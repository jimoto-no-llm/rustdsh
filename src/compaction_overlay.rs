//! Per-model compaction thresholds as a launch-time overlay.
//!
//! DSH's basic compaction backend (`@deepseek-ai/dsh-compaction-basic`) takes
//! exact provider/model overrides in `modelPolicies`. This module turns
//! thresholds kept in absolute tokens into that shape and builds the `--patch`
//! overlay that hands them over at boot, the same way `webui_gzip` raises the
//! gzip level: nothing is written into the profile, and a caller-supplied
//! `--patch` still wins because the generated layer goes first.
//!
//! Two facts about the patch algorithm shape the overlay. Both were verified
//! against the installed bundle with `--dump-config`:
//!
//! - A patch entry's `config` is assigned as a whole, not deep-merged. The
//!   overlay therefore restates the config the dump already shows and adds
//!   only `modelPolicies`.
//! - Rows are matched by id, and the id index follows `group` entries only.
//!   In the `headless` profile `compaction-basic` is a top-level row. In `web`
//!   it sits inside each agent preset's `config.plugins`, which the index does
//!   not enter; a patch naming `compaction-basic` there only reaches the
//!   disabled top-level row. For those the overlay restates the preset's
//!   `config` and adds `modelPolicies` under the nested row.
//!
//! A row that already carries `modelPolicies` was configured by hand and is
//! left alone, as is a disabled row or one whose `config` is not a plain
//! block. Every such case only costs the overlay for that row, never the boot.

/// Feature id that gates this layer. Off by default.
pub const FEATURE_ID: &str = "compaction_policy";

/// The row this module configures.
pub const COMPACTION_ROW_ID: &str = "compaction-basic";

/// The single config key this module adds.
pub const MODEL_POLICIES_KEY: &str = "modelPolicies";

/// Thresholds for one provider/model route, in absolute tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AbsolutePolicy {
    pub provider: String,
    pub model: String,
    /// The model's context window.
    pub context_window: u64,
    /// Output tokens a request reserves from the same window.
    pub output_reserve: u64,
    /// Compact once the request reaches this many tokens.
    pub trigger_tokens: u64,
    /// Recent conversation kept verbatim.
    pub retain_tokens: u64,
    /// Output cap of the summarization request.
    pub max_tokens: u64,
}

/// One `modelPolicies` entry in the backend's own vocabulary.
///
/// `thresholdRatio` is not a field: this module always writes 1, so that
/// `headroomTokens` alone decides the trigger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPolicy {
    pub provider: String,
    pub model: String,
    pub headroom_tokens: u64,
    pub retain_tokens: u64,
    pub max_tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyError {
    /// Provider or model is blank.
    EmptyTarget,
    /// Provider or model contains a control character.
    UnsafeTarget,
    /// The trigger is zero.
    ZeroTrigger,
    /// The trigger does not fit in the window after the output reservation.
    TriggerOutOfWindow,
    /// The retained tail is not smaller than the trigger.
    RetainNotBelowTrigger,
    /// The summary output cap is zero.
    ZeroMaxTokens,
    /// Two policies name the same provider and model.
    DuplicateTarget,
}

impl AbsolutePolicy {
    /// Express the absolute trigger in the backend's terms.
    ///
    /// The backend compacts at
    /// `min(window * thresholdRatio, window - output - headroomTokens)`.
    /// With `thresholdRatio: 1` the second term decides, so
    /// `headroomTokens = window - output - trigger` pins the trigger to an
    /// absolute token count. A window or output reservation that differs from
    /// what the backend resolves shifts the trigger by the same number of
    /// tokens; it does not scale it.
    pub fn to_model_policy(&self) -> Result<ModelPolicy, PolicyError> {
        check_target(&self.provider, &self.model)?;
        if self.trigger_tokens == 0 {
            return Err(PolicyError::ZeroTrigger);
        }
        let headroom_tokens = self
            .context_window
            .checked_sub(self.output_reserve)
            .and_then(|usable| usable.checked_sub(self.trigger_tokens))
            .ok_or(PolicyError::TriggerOutOfWindow)?;
        if self.retain_tokens >= self.trigger_tokens {
            return Err(PolicyError::RetainNotBelowTrigger);
        }
        if self.max_tokens == 0 {
            return Err(PolicyError::ZeroMaxTokens);
        }
        Ok(ModelPolicy {
            provider: self.provider.clone(),
            model: self.model.clone(),
            headroom_tokens,
            retain_tokens: self.retain_tokens,
            max_tokens: self.max_tokens,
        })
    }
}

fn check_target(provider: &str, model: &str) -> Result<(), PolicyError> {
    for value in [provider, model] {
        if value.trim().is_empty() {
            return Err(PolicyError::EmptyTarget);
        }
        if value.chars().any(char::is_control) {
            return Err(PolicyError::UnsafeTarget);
        }
    }
    Ok(())
}

/// Reject a policy list the backend would refuse at load.
///
/// The backend fails the plugin on duplicate exact-target overrides, and a
/// name with a control character cannot be written as one YAML scalar line.
pub fn validate(policies: &[ModelPolicy]) -> Result<(), PolicyError> {
    for (index, policy) in policies.iter().enumerate() {
        check_target(&policy.provider, &policy.model)?;
        if policy.max_tokens == 0 {
            return Err(PolicyError::ZeroMaxTokens);
        }
        let duplicate = policies[..index]
            .iter()
            .any(|earlier| earlier.provider == policy.provider && earlier.model == policy.model);
        if duplicate {
            return Err(PolicyError::DuplicateTarget);
        }
    }
    Ok(())
}

/// A generated overlay and how many `compaction-basic` rows it configures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overlay {
    pub body: String,
    pub rows: usize,
}

/// Build the `--patch` overlay that adds `modelPolicies` to every enabled
/// `compaction-basic` row of a composed `--dump-config` listing.
///
/// Returns `None` when there is nothing to write: no policies, a policy list
/// the backend would refuse, or no row that can be configured safely.
pub fn overlay_for(composed: &str, policies: &[ModelPolicy]) -> Option<Overlay> {
    overlay_with_options(
        composed,
        policies,
        &crate::compaction_config::Options::default(),
    )
}

pub fn overlay_with_options(
    composed: &str,
    policies: &[ModelPolicy],
    options: &crate::compaction_config::Options,
) -> Option<Overlay> {
    if (policies.is_empty() && !options.needs_plugin()) || validate(policies).is_err() {
        return None;
    }
    let mut body = String::new();
    let mut rows = 0;
    for entry in crate::webui_gzip::split_entries(composed) {
        if let Some((patch, count)) = patch_entry(&entry, policies, options) {
            body.push_str(&patch);
            rows += count;
        }
    }
    if rows == 0 {
        None
    } else {
        Some(Overlay { body, rows })
    }
}

/// One `- id: compaction-basic` row inside an entry block.
struct Row {
    /// Index of the `- id:` line.
    start: usize,
    /// Index one past the row's last line.
    end: usize,
    /// Indentation of the `- id:` line.
    indent: usize,
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

/// Index one past the block that starts after `start`: the first later line
/// that is not blank and is indented no deeper than `indent`.
fn block_end(lines: &[String], start: usize, limit: usize, indent: usize) -> usize {
    (start + 1..limit)
        .find(|&index| !is_blank(&lines[index]) && indent_of(&lines[index]) <= indent)
        .unwrap_or(limit)
}

/// Index one past the last non-blank line in `from..to`, or `from`.
fn after_last_content(lines: &[String], from: usize, to: usize) -> usize {
    (from..to)
        .rev()
        .find(|&index| !is_blank(&lines[index]))
        .map_or(from, |index| index + 1)
}

fn compaction_rows(lines: &[String]) -> Vec<Row> {
    let marker = format!("- id: {COMPACTION_ROW_ID}");
    let mut rows = Vec::new();
    let mut scalar_indent = None;
    for (start, line) in lines.iter().enumerate() {
        let indent = indent_of(line);
        if let Some(parent) = scalar_indent {
            if is_blank(line) || indent > parent {
                continue;
            }
            scalar_indent = None;
        }
        // The composed dump may contain YAML examples inside prompt text.
        // Literal/folded block content is data, even when it resembles a row.
        if let Some((_, value)) = line.split_once(':') {
            let indicator = value.split('#').next().unwrap_or_default().trim();
            if indicator.starts_with(['|', '>'])
                && indicator[1..]
                    .chars()
                    .all(|c| matches!(c, '+' | '-' | '1'..='9'))
            {
                scalar_indent = Some(indent);
                continue;
            }
        }
        if line.trim() != marker {
            continue;
        }
        let end = block_end(lines, start, lines.len(), indent);
        rows.push(Row { start, end, indent });
    }
    rows
}

/// The `config:` block of the top-level row: the key line and one past its body.
fn top_config_range(lines: &[String]) -> Option<(usize, usize)> {
    let key = lines
        .iter()
        .position(|line| indent_of(line) == 2 && line.trim() == "config:")?;
    Some((key, block_end(lines, key, lines.len(), 2)))
}

fn top_level_disabled(lines: &[String]) -> bool {
    lines
        .iter()
        .any(|line| indent_of(line) == 2 && line.trim().starts_with("disabled: true"))
}

fn yaml_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// The `modelPolicies:` block, with the key at `indent`.
fn policies_block(indent: usize, policies: &[ModelPolicy]) -> Vec<String> {
    let pad = " ".repeat(indent);
    let mut out = vec![format!("{pad}{MODEL_POLICIES_KEY}:")];
    for policy in policies {
        out.push(format!(
            "{pad}  - provider: {}",
            yaml_quoted(&policy.provider)
        ));
        out.push(format!("{pad}    model: {}", yaml_quoted(&policy.model)));
        out.push(format!("{pad}    thresholdRatio: 1"));
        out.push(format!(
            "{pad}    headroomTokens: {}",
            policy.headroom_tokens
        ));
        out.push(format!("{pad}    retainTokens: {}", policy.retain_tokens));
        out.push(format!("{pad}    maxTokens: {}", policy.max_tokens));
    }
    out
}

/// Add `modelPolicies` to one row. Returns false when the row is left alone.
fn edit_row(
    lines: &mut Vec<String>,
    row: &Row,
    policies: &[ModelPolicy],
    options: &crate::compaction_config::Options,
) -> bool {
    let key_indent = row.indent + 2;
    let pad = " ".repeat(key_indent);
    let mut block: Option<(usize, usize)> = None;
    let mut empty_flow: Option<usize> = None;
    let mut known_backend = false;
    for index in row.start + 1..row.end {
        let line = &lines[index];
        if is_blank(line) || indent_of(line) != key_indent {
            continue;
        }
        let body = line.trim();
        if let Some(name) = body.strip_prefix("name:") {
            if name.trim().trim_matches(['\'', '"']) != "@deepseek-ai/dsh-compaction-basic" {
                return false;
            }
            known_backend = true;
        }
        if body.starts_with("disabled: true") {
            return false;
        }
        if body == "config:" {
            block = Some((index, block_end(lines, index, row.end, key_indent)));
        } else if body == "config: {}" {
            empty_flow = Some(index);
        } else if body.starts_with("config:") {
            // An inline or tagged value: restating it by text is not safe.
            return false;
        }
    }

    if options.needs_plugin() && !known_backend {
        return false;
    }

    let mut configured = false;
    let insert_at = if let Some((key, body_end)) = block {
        configured = lines[key + 1..body_end].iter().any(|line| {
            indent_of(line) == key_indent + 2 && line.trim().starts_with(MODEL_POLICIES_KEY)
        });
        if configured && !options.needs_plugin() {
            return false;
        }
        after_last_content(lines, key + 1, body_end)
    } else if let Some(index) = empty_flow {
        lines[index] = format!("{pad}config:");
        index + 1
    } else {
        let at = after_last_content(lines, row.start + 1, row.end);
        lines.insert(at, format!("{pad}config:"));
        at + 1
    };
    let mut added = if configured || policies.is_empty() {
        vec![]
    } else {
        policies_block(key_indent + 2, policies)
    };
    if options.needs_plugin() {
        let pad = " ".repeat(key_indent + 2);
        if let Some(instructions) = &options.instructions {
            added.push(format!(
                "{pad}instructions: {}",
                serde_json::to_string(instructions).ok().unwrap()
            ));
        }
        added.push(format!(
            "{pad}rdshRoutes: {}",
            serde_json::to_string(&options.routes).ok().unwrap()
        ));
        if let Some(early) = &options.early {
            added.push(format!(
                "{pad}rdshEarly: {}",
                serde_json::to_string(early).ok().unwrap()
            ));
            let Ok(binary) = std::env::current_exe() else {
                return false;
            };
            let binary = binary.to_string_lossy().into_owned();
            added.push(format!(
                "{pad}rdshBinary: {}",
                serde_json::to_string(&binary).ok().unwrap()
            ));
        }
        for line in &mut lines[row.start + 1..insert_at] {
            if indent_of(line) == key_indent && line.trim_start().starts_with("name:") {
                *line = format!("{}name: rdsh-compaction", " ".repeat(key_indent));
            }
        }
    }
    lines.splice(insert_at..insert_at, added);
    true
}

/// Build the patch entry for one top-level entry block, with the number of
/// rows it configures. `None` when the entry holds no row to configure.
fn patch_entry(
    entry: &str,
    policies: &[ModelPolicy],
    options: &crate::compaction_config::Options,
) -> Option<(String, usize)> {
    let mut lines: Vec<String> = entry.lines().map(str::to_string).collect();
    let id_line = lines.first()?.clone();
    if top_level_disabled(&lines) {
        return None;
    }
    let rows = compaction_rows(&lines);
    let config = top_config_range(&lines);
    let mut patched = 0;
    // Later rows first, so earlier indices stay valid while lines are added.
    for row in rows.iter().rev() {
        if row.indent > 0 {
            // A nested row is only reachable by restating the entry's config.
            let inside = config.is_some_and(|(key, end)| row.start > key && row.end <= end);
            if !inside {
                continue;
            }
        }
        if edit_row(&mut lines, row, policies, options) {
            patched += 1;
        }
    }
    if patched == 0 {
        return None;
    }
    if options.needs_plugin() && rows.iter().any(|row| row.indent == 0) {
        // DSH treats `name` as a match guard, not an assignable field. Disable
        // the top-level backend and insert its replacement; nested preset rows
        // can change names because their containing config is replaced whole.
        let mut out = format!("{id_line}\n  disabled: true\n- insert:\n");
        lines[0] = "- id: rdsh-compaction".into();
        for line in &lines {
            out.push_str("    ");
            out.push_str(line);
            out.push('\n');
        }
        return Some((out, patched));
    }
    let (key, end) = top_config_range(&lines)?;
    let end = after_last_content(&lines, key + 1, end);
    let mut out = id_line;
    out.push('\n');
    for line in &lines[key..end] {
        out.push_str(line);
        out.push('\n');
    }
    Some((out, patched))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(provider: &str, model: &str) -> ModelPolicy {
        ModelPolicy {
            provider: provider.to_string(),
            model: model.to_string(),
            headroom_tokens: 100_000,
            retain_tokens: 20_000,
            max_tokens: 8_192,
        }
    }

    /// `dsh --profile headless --dump-config`, trimmed to the rows around
    /// `compaction-basic`. The row is top level and has no config.
    const HEADLESS: &str = r#"# == @deepseek-ai/dsh-base
- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
"#;

    /// `dsh --profile web --dump-config`, trimmed. The top-level row is
    /// disabled and the live row sits inside each agent preset.
    const WEB: &str = r#"# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
  disabled: true
# == @deepseek-ai/dsh-web-app
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          text: !!js ctx.persona.text
      - id: compaction
        name: cordis:group
        group: true
        isolate:
          compaction: true
          toolResultPruner: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
            config:
              thresholdChars: 8192
              headChars: 4096
              tailChars: 1024
      - id: delegation
        name: cordis:group
- id: preset-minimal
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: minimal
    plugins:
      - id: compaction
        name: cordis:group
        group: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
          - id: command-compact
            name: '@deepseek-ai/dsh-command-compact'
"#;

    #[test]
    fn absolute_trigger_becomes_headroom() {
        let absolute = AbsolutePolicy {
            provider: "hai".to_string(),
            model: "deepseek-v4-flash".to_string(),
            context_window: 1_000_000,
            output_reserve: 8_192,
            trigger_tokens: 150_000,
            retain_tokens: 20_000,
            max_tokens: 8_192,
        };
        let resolved = absolute.to_model_policy().unwrap();
        // window - output - headroom is the trigger again.
        assert_eq!(resolved.headroom_tokens, 841_808);
        assert_eq!(1_000_000 - 8_192 - resolved.headroom_tokens, 150_000);
        assert_eq!(resolved.retain_tokens, 20_000);
    }

    #[test]
    fn a_wrong_window_shifts_the_trigger_but_does_not_scale_it() {
        let mut absolute = AbsolutePolicy {
            provider: "p".to_string(),
            model: "m".to_string(),
            context_window: 200_000,
            output_reserve: 0,
            trigger_tokens: 150_000,
            retain_tokens: 20_000,
            max_tokens: 4_096,
        };
        let recorded = absolute.to_model_policy().unwrap();
        // The backend resolves a window 10% larger than rdsh recorded.
        let actual_window: u64 = 220_000;
        let trigger = actual_window - recorded.headroom_tokens;
        assert_eq!(trigger, 170_000);
        // A ratio-based trigger would have moved to 165_000 at 75% of 220_000
        // and keeps moving with the window; this one moves by the same 20_000.
        absolute.context_window = 400_000;
        let doubled = absolute.to_model_policy().unwrap();
        assert_eq!(400_000 - doubled.headroom_tokens, 150_000);
    }

    #[test]
    fn policies_the_backend_would_refuse_are_rejected() {
        let base = AbsolutePolicy {
            provider: "p".to_string(),
            model: "m".to_string(),
            context_window: 100_000,
            output_reserve: 8_000,
            trigger_tokens: 50_000,
            retain_tokens: 10_000,
            max_tokens: 4_096,
        };
        let with = |change: fn(&mut AbsolutePolicy)| {
            let mut policy = base.clone();
            change(&mut policy);
            policy.to_model_policy()
        };
        assert_eq!(
            with(|p| p.trigger_tokens = 92_001),
            Err(PolicyError::TriggerOutOfWindow)
        );
        assert_eq!(
            with(|p| p.output_reserve = 100_001),
            Err(PolicyError::TriggerOutOfWindow)
        );
        assert_eq!(
            with(|p| p.trigger_tokens = 0),
            Err(PolicyError::ZeroTrigger)
        );
        assert_eq!(
            with(|p| p.retain_tokens = 50_000),
            Err(PolicyError::RetainNotBelowTrigger)
        );
        assert_eq!(with(|p| p.max_tokens = 0), Err(PolicyError::ZeroMaxTokens));
        assert_eq!(
            with(|p| p.model = "  ".to_string()),
            Err(PolicyError::EmptyTarget)
        );
        assert_eq!(
            with(|p| p.provider = "a\nb".to_string()),
            Err(PolicyError::UnsafeTarget)
        );
        // The largest trigger that still fits leaves zero headroom.
        assert_eq!(
            with(|p| p.trigger_tokens = 92_000).map(|p| p.headroom_tokens),
            Ok(0)
        );
    }

    #[test]
    fn duplicate_targets_are_rejected() {
        let policies = [policy("p", "m"), policy("p", "other"), policy("p", "m")];
        assert_eq!(validate(&policies), Err(PolicyError::DuplicateTarget));
        assert_eq!(validate(&policies[..2]), Ok(()));
        assert_eq!(overlay_for(HEADLESS, &policies), None);
    }

    #[test]
    fn headless_row_gets_a_config_with_the_policies() {
        let overlay = overlay_for(HEADLESS, &[policy("hai", "deepseek-v4-flash")]).unwrap();
        assert_eq!(overlay.rows, 1);
        assert_eq!(
            overlay.body,
            "\
- id: compaction-basic
  config:
    modelPolicies:
      - provider: 'hai'
        model: 'deepseek-v4-flash'
        thresholdRatio: 1
        headroomTokens: 100000
        retainTokens: 20000
        maxTokens: 8192
"
        );
    }

    #[test]
    fn web_presets_are_restated_with_the_policies_under_the_nested_row() {
        let overlay = overlay_for(WEB, &[policy("hai", "deepseek-v4-flash")]).unwrap();
        // One row per preset; the disabled top-level row is not touched.
        assert_eq!(overlay.rows, 2);
        assert!(!overlay.body.contains("- id: compaction-basic\n  config:"));
        assert!(overlay
            .body
            .starts_with("- id: preset-standard\n  config:\n"));
        assert!(overlay.body.contains("\n- id: preset-minimal\n  config:\n"));

        // Every field the preset layer set survives, tags included.
        for kept in [
            "    id: standard",
            "    order: 1",
            "          text: !!js ctx.persona.text",
            "          toolResultPruner: true",
            "              thresholdChars: 8192",
            "      - id: delegation",
        ] {
            assert!(overlay.body.contains(kept), "dropped: {kept}");
        }

        // The policies sit under the nested row, before its next sibling.
        let expected = "\
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
            config:
              modelPolicies:
                - provider: 'hai'
                  model: 'deepseek-v4-flash'
                  thresholdRatio: 1
                  headroomTokens: 100000
                  retainTokens: 20000
                  maxTokens: 8192
          - id: command-compact
";
        assert_eq!(overlay.body.matches(expected).count(), 2);

        // Only `id` and `config` are restated; `name` stays with the layer below.
        assert!(!overlay
            .body
            .contains("name: '@deepseek-ai/dsh-agent-preset'"));
    }

    #[test]
    fn restating_only_adds_the_policy_lines() {
        let overlay = overlay_for(WEB, &[policy("p", "m")]).unwrap();
        // What a faithful restatement repeats: both preset entries, in order,
        // without the `name` key the patch does not need.
        let first_preset = WEB.find("- id: preset-standard").unwrap();
        let restated: Vec<&str> = WEB[first_preset..]
            .lines()
            .filter(|line| *line != "  name: '@deepseek-ai/dsh-agent-preset'")
            .collect();
        let mut rest = restated.iter().peekable();
        let mut added: Vec<&str> = Vec::new();
        for line in overlay.body.lines() {
            if rest.peek().is_some_and(|next| **next == line) {
                rest.next();
            } else {
                added.push(line);
            }
        }
        assert_eq!(
            rest.next(),
            None,
            "an original line was dropped or reordered"
        );
        let one_row = [
            "            config:",
            "              modelPolicies:",
            "                - provider: 'p'",
            "                  model: 'm'",
            "                  thresholdRatio: 1",
            "                  headroomTokens: 100000",
            "                  retainTokens: 20000",
            "                  maxTokens: 8192",
        ];
        let expected: Vec<&str> = one_row.iter().chain(one_row.iter()).copied().collect();
        assert_eq!(added, expected);
    }

    #[test]
    fn existing_config_is_restated_and_extended() {
        let composed = "\
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    auto: true
    maxOverflowRetries: 2
- id: next
";
        let overlay = overlay_for(composed, &[policy("p", "m")]).unwrap();
        assert_eq!(
            overlay.body,
            "\
- id: compaction-basic
  config:
    auto: true
    maxOverflowRetries: 2
    modelPolicies:
      - provider: 'p'
        model: 'm'
        thresholdRatio: 1
        headroomTokens: 100000
        retainTokens: 20000
        maxTokens: 8192
"
        );
    }

    #[test]
    fn an_empty_flow_config_becomes_a_block() {
        let composed = "\
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config: {}
";
        let overlay = overlay_for(composed, &[policy("p", "m")]).unwrap();
        assert!(overlay
            .body
            .starts_with("- id: compaction-basic\n  config:\n    modelPolicies:\n"));
    }

    #[test]
    fn rows_configured_by_hand_or_not_plain_are_left_alone() {
        let by_hand = "\
- id: compaction-basic
  config:
    modelPolicies:
      - provider: p
        model: m
        thresholdRatio: 0.7
";
        let inline = "\
- id: compaction-basic
  config: { auto: false }
";
        let tagged = "\
- id: compaction-basic
  config: !!js ctx.compaction
";
        let disabled_nested = "\
- id: preset-x
  config:
    plugins:
      - id: compaction-basic
        name: '@deepseek-ai/dsh-compaction-basic'
        disabled: true
";
        let disabled_preset = "\
- id: preset-x
  disabled: true
  config:
    plugins:
      - id: compaction-basic
        name: '@deepseek-ai/dsh-compaction-basic'
";
        let policies = [policy("p", "m")];
        for composed in [
            by_hand,
            inline,
            tagged,
            disabled_nested,
            disabled_preset,
            "",
        ] {
            assert_eq!(overlay_for(composed, &policies), None, "{composed}");
        }
        assert_eq!(overlay_for(HEADLESS, &[]), None);
    }

    #[test]
    fn names_are_written_as_quoted_scalars() {
        let overlay = overlay_for(HEADLESS, &[policy("it's", "a: b #c")]).unwrap();
        assert!(overlay.body.contains("      - provider: 'it''s'\n"));
        assert!(overlay.body.contains("        model: 'a: b #c'\n"));
    }

    #[test]
    fn prompt_examples_and_custom_backends_are_not_plugin_rows() {
        let prompt = "- id: preset-x\n  config:\n    prompt: |-\n      - id: compaction-basic\n        name: '@deepseek-ai/dsh-compaction-basic'\n";
        let custom = "- id: compaction-basic\n  name: custom-backend\n";
        for composed in [prompt, custom] {
            assert_eq!(overlay_for(composed, &[policy("p", "m")]), None);
        }
    }
}
