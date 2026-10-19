//! Read-only, conservative projection of explicit pi-ai routes for the native harness.
use super::*;
use serde_json::{Map, Value};

/// This is configuration data only: no Cordis/JavaScript is loaded or executed.
/// Unsupported YAML is rejected by the same structural checks used by provider add.
pub(crate) fn read_routes(text: &str) -> Result<Option<Map<String, Value>>> {
    let locale = crate::locale::Locale::English;
    let lines = structural_lines(&split_lines(text));
    check_document(&lines, locale).map_err(anyhow::Error::msg)?;
    inspect_mapping_keys(&lines, locale)?;
    if lines
        .iter()
        .filter(|line| !skippable(line))
        .map(|line| trim_yaml(line))
        .eq(std::iter::once("[]"))
    {
        return Ok(None);
    }
    let Some(entry) = llm_pi_ai_entry(&lines, locale).map_err(anyhow::Error::msg)? else {
        return Ok(None);
    };
    let entry_end = block_end(&lines, entry);
    let entry_depth = dash_key_col(&lines[entry]);
    for line in lines
        .iter()
        .take(entry_end)
        .skip(entry + 1)
        .filter(|line| !skippable(line) && indent_of(line) == entry_depth)
    {
        let (key, _) = mapping_parts(trim_yaml(line))
            .ok_or_else(|| anyhow::anyhow!("NATIVE_PROFILE_ENTRY_LAYOUT"))?;
        let key =
            try_unquote(key, locale).map_err(|_| anyhow::anyhow!("NATIVE_PROFILE_ENTRY_KEY"))?;
        if !["id", "name", "config"].contains(&key.as_str()) {
            bail!("NATIVE_PROFILE_ENTRY_OPTIONS_UNSUPPORTED");
        }
    }
    let Some(p) = locate_providers(&lines, locale)? else {
        // A later pi-ai config replaces the earlier one, including removing providers.
        return Ok(Some(Map::new()));
    };
    let mut routes = Map::new();
    for i in p.line + 1..p.end {
        if skippable(&lines[i]) || indent_of(&lines[i]) != p.child_indent {
            continue;
        }
        let (key, rest) = mapping_parts(trim_yaml(&lines[i]))
            .ok_or_else(|| anyhow::anyhow!("NATIVE_PROFILE_ROUTE_LAYOUT"))?;
        let id =
            try_unquote(key, locale).map_err(|_| anyhow::anyhow!("NATIVE_PROFILE_ROUTE_ID"))?;
        if routes.contains_key(&id) {
            bail!("NATIVE_PROFILE_DUPLICATE_ROUTE");
        }
        let mut route = Map::new();
        if rest.trim() == "{}" {
            routes.insert(id, Value::Object(route));
            continue;
        }
        if !rest.trim().is_empty() {
            bail!("NATIVE_PROFILE_ROUTE_LAYOUT");
        }
        let end = block_end(&lines, i);
        if let Some(depth) = child_indent(&lines, i, end) {
            for j in i + 1..end {
                if skippable(&lines[j]) || indent_of(&lines[j]) != depth {
                    continue;
                }
                let (key, rest) = mapping_parts(trim_yaml(&lines[j]))
                    .ok_or_else(|| anyhow::anyhow!("NATIVE_PROFILE_FIELD_LAYOUT"))?;
                let key = try_unquote(key, locale)
                    .map_err(|_| anyhow::anyhow!("NATIVE_PROFILE_FIELD"))?;
                if key == "models" {
                    if rest.trim() == "[]" {
                        route.insert(key, Value::Array(vec![]));
                        continue;
                    }
                    if !rest.trim().is_empty() {
                        bail!("NATIVE_PROFILE_MODELS_LAYOUT");
                    }
                    let mend = block_end(&lines, j);
                    let mut models = vec![];
                    if let Some(first) = (j + 1..mend).find(|k| !skippable(&lines[*k])) {
                        if !lines[first].trim_start().starts_with("- ") {
                            bail!("NATIVE_PROFILE_MODELS_SEQUENCE_REQUIRED");
                        }
                    }
                    let items: Vec<_> = (j + 1..mend)
                        .filter(|k| {
                            !skippable(&lines[*k]) && lines[*k].trim_start().starts_with("- ")
                        })
                        .collect();
                    if let Some(first) = items.first() {
                        let item_depth = indent_of(&lines[*first]);
                        for k in items
                            .into_iter()
                            .filter(|k| indent_of(&lines[*k]) == item_depth)
                        {
                            let mut model = Map::new();
                            let mapping_depth = item_depth + dash_key_col(lines[k].trim_start());
                            let item_end = block_end(&lines, k);
                            for (n, source) in lines.iter().enumerate().take(item_end).skip(k) {
                                let line = if n == k {
                                    source.trim_start().trim_start_matches("- ")
                                } else {
                                    if indent_of(source) != mapping_depth {
                                        continue;
                                    }
                                    trim_yaml(source)
                                };
                                let Some((field, value)) = mapping_parts(line) else {
                                    continue;
                                };
                                let field = try_unquote(field, locale)
                                    .map_err(|_| anyhow::anyhow!("NATIVE_PROFILE_MODEL_FIELD"))?;
                                if ["id", "name", "api", "baseURL", "maxTokens"]
                                    .contains(&field.as_str())
                                {
                                    if value.is_empty()
                                        || value.starts_with(['|', '>', '[', '{', '&', '*', '!'])
                                    {
                                        bail!("NATIVE_PROFILE_MODEL_SCALAR");
                                    }
                                    let value = try_unquote(value, locale).map_err(|_| {
                                        anyhow::anyhow!("NATIVE_PROFILE_MODEL_SCALAR")
                                    })?;
                                    model.insert(field.to_owned(), Value::String(value));
                                } else if !["input", "cost", "contextWindow", "reasoning"]
                                    .contains(&field.as_str())
                                {
                                    model.insert("unsupported".into(), Value::Bool(true));
                                }
                            }
                            if model
                                .get("id")
                                .and_then(Value::as_str)
                                .is_none_or(str::is_empty)
                            {
                                bail!("NATIVE_PROFILE_MODEL_ID");
                            }
                            models.push(Value::Object(model));
                        }
                    }
                    route.insert(key, Value::Array(models));
                } else if ["api", "baseURL", "apiKeyEnv", "displayName"].contains(&key.as_str()) {
                    if rest.is_empty() || rest.starts_with(['|', '>', '[', '{', '&', '*', '!']) {
                        bail!("NATIVE_PROFILE_ROUTE_SCALAR");
                    }
                    let value = try_unquote(rest, locale)
                        .map_err(|_| anyhow::anyhow!("NATIVE_PROFILE_ROUTE_SCALAR"))?;
                    route.insert(key, Value::String(value));
                } else {
                    // Do not silently ignore headers, OAuth, reasoning or compatibility switches.
                    route.insert("unsupported".into(), Value::Bool(true));
                }
            }
        }
        routes.insert(id, Value::Object(route));
    }
    Ok(Some(routes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_routes_preserve_quoted_ids_and_empty_catalog_routes() {
        let text = "- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        api: openai-completions\n        baseURL: 'http://127.0.0.1:1234/v1'\n        models:\n          - id: 'model:one'\n            name: 'Model One'\n      cerebras: {}\n";
        assert!(read_routes("# empty root\n[]\n").unwrap().is_none());
        let routes = read_routes(text).unwrap().unwrap();
        assert_eq!(routes["custom"]["models"][0]["id"], "model:one");
        assert_eq!(routes["custom"]["models"][0]["name"], "Model One");
        assert_eq!(routes["cerebras"], serde_json::json!({}));
        assert!(read_routes(&text.replace("      cerebras: {}", "      custom: {}")).is_err());
    }
    #[test]
    fn quoted_model_keys_unsupported_fields_and_fake_block_content() {
        let text="- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        api: openai-completions\n        models:\n          - 'id': model\n            \"headers\": {}\n";
        let routes = read_routes(text).unwrap().unwrap();
        assert_eq!(routes["custom"]["models"][0]["id"], "model");
        assert_eq!(routes["custom"]["models"][0]["unsupported"], true);
        assert!(
            read_routes(&text.replace("'id': model", "'id': |\n              fake-model")).is_err()
        );
        let fake="- id: prompt\n  config:\n    text: |\n      - id: llm-pi-ai\n        config:\n          providers:\n            fake: {}\n";
        assert!(read_routes(fake).unwrap().is_none());
        assert_eq!(
            read_routes("- id: llm-pi-ai\n  config:\n    other: true\n")
                .unwrap()
                .unwrap()
                .len(),
            0
        );
        assert!(read_routes(&text.replace("  config:", "  disabled: true\n  config:")).is_err());
        let wide = text
            .replace("- 'id':", "-   'id':")
            .replace("            \"headers", "              \"headers");
        assert_eq!(
            read_routes(&wide).unwrap().unwrap()["custom"]["models"][0]["unsupported"],
            true
        );
        let wrapped = text
            .replace("        models:", "        models:\n          nested:")
            .replace("          - 'id':", "            - 'id':");
        assert!(read_routes(&wrapped).is_err());
    }
}
