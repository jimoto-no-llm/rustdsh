// OAuth auto-recognition ("drop it in and it's recognized").
//
// Well-known external login stores are mirrored into
// `$DSH_HOME/.credentials.yaml`, which is the only writable credential layer
// dsh itself reads for OAuth grants:
//
//   ~/.codex/auth.json                  (Codex CLI: ChatGPT OAuth + optional key)
//   $XDG_DATA_HOME/opencode/auth.json   (opencode logins, e.g. openai OAuth)
//   ~/.local/share/opencode/auth.json   (same, default data dir)
//
// Safety rules (the file holds live secrets, dsh refreshes them in place):
//   1. never delete or rename anything, only add/replace single entries
//   2. never overwrite a record with an older grant (compare `expires`,
//      fall back to source-file mtime vs credentials-file mtime)
//   3. keep the file at 0600, otherwise dsh refuses to read it
//   4. every other byte of the document is preserved (line surgery, no re-emit)
//
// Issue #87 epic memo (87-1 design decision, comment only, no routing logic yet):
//   - Placement UNDECIDED: rdsh is a launcher/sim (passthrough delegation in
//     src/main.rs), not an LLM gateway. Candidates: (a) advise profile choice
//     at startup only, (b) rewrite agent-default-model in cordis.patch.yml,
//     (c) relay requests. No implementation until 87-1 picks one.
//   - Price source: official pages only (URL/format/refresh TBD for 2 firms);
//     start with a manual table (87-2), auto-fetch comes later (87-3).
//   - Formula (units fixed in 87-1): effective price = API price x model
//     multiplier x (monthly fee / Credits); two worked examples TBD in 87-1.
//   - Related: provider_needs() detection (ok/importable/missing) excludes
//     unusable routes in 87-2; ZDR mode is split out to 87-5 (requirements first).

use std::collections::HashMap;

const RECORD_SCOPE: &str = "llm-pi-ai";

fn home() -> Option<String> {
    crate::inspect::home_dir()
}

pub fn creds_path() -> String {
    format!("{}/.credentials.yaml", crate::inspect::dsh_home())
}

fn data_dir() -> Option<String> {
    if let Ok(x) = std::env::var("XDG_DATA_HOME") {
        if !x.is_empty() {
            return Some(x);
        }
    }
    // opencode on native Windows keeps auth under %APPDATA% (Roaming).
    #[cfg(target_os = "windows")]
    {
        if let Ok(a) = std::env::var("APPDATA") {
            if !a.is_empty() {
                return Some(a);
            }
        }
    }
    home().map(|h| format!("{h}/.local/share"))
}

/// Where `opencode.json` (the OpenCode settings file) lives. Shown by
/// `rdsh setup` so first-run users can find the settings screen.
fn config_dir() -> Option<String> {
    if let Ok(x) = std::env::var("XDG_CONFIG_HOME") {
        if !x.is_empty() {
            return Some(x);
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(a) = std::env::var("APPDATA") {
            if !a.is_empty() {
                return Some(a);
            }
        }
    }
    home().map(|h| format!("{h}/.config"))
}

fn opencode_config_path() -> Option<String> {
    config_dir().map(|c| format!("{c}/opencode/opencode.json"))
}

/// opencode's provider key -> dsh record id. Only `openai` needs renaming
/// (dsh's route is `openai-codex`); everything else passes through verbatim
/// when it fits the record-id grammar, otherwise it is skipped with a note.
fn provider_id(opencode_key: &str) -> Option<String> {
    if opencode_key == "openai" {
        return Some("openai-codex".to_string());
    }
    if is_record_id(opencode_key) {
        return Some(opencode_key.to_string());
    }
    None
}

fn is_record_id(s: &str) -> bool {
    let mut c = s.chars();
    match c.next() {
        Some(f) if f.is_ascii_lowercase() => {}
        _ => return false,
    }
    s.chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

#[derive(Debug, Clone)]
struct OauthGrant {
    provider: String,
    access: String,
    refresh: String,
    expires: Option<i64>,
    account_id: Option<String>,
    from: String,
    src_mtime_ms: u64,
}

#[derive(Debug, Clone)]
struct ApiKey {
    name: String,
    value: String,
    from: String,
}

fn mtime_ms(p: &str) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_json(path: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn num_field(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

// --- JWT exp (best effort, no deps) ----------------------------------------

fn b64url_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a' + 26) as u32),
        b'0'..=b'9' => Some((c - b'0' + 52) as u32),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut n = 0;
    for &c in bytes {
        if c == b'=' {
            break;
        }
        let v = b64url_val(c)?;
        buf = (buf << 6) | v;
        n += 1;
        if n == 4 {
            out.push((buf >> 16) as u8);
            out.push((buf >> 8) as u8);
            out.push(buf as u8);
            buf = 0;
            n = 0;
        }
    }
    match n {
        0 => {}
        2 => {
            out.push((buf >> 4) as u8);
        }
        3 => {
            out.push((buf >> 10) as u8);
            out.push((buf >> 2) as u8);
        }
        _ => return None,
    }
    Some(out)
}

/// Seconds-since-epoch `exp` claim of a JWT access token, in milliseconds.
fn jwt_exp_ms(token: &str) -> Option<i64> {
    let mut parts = token.split('.');
    let payload = parts.nth(1)?;
    let raw = b64url_decode(payload)?;
    let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    v.get("exp")?.as_i64().map(|s| s * 1000)
}

// --- external stores --------------------------------------------------------

fn scan_codex(grants: &mut Vec<OauthGrant>, keys: &mut Vec<ApiKey>) {
    let h = match home() {
        Some(h) => h,
        None => return,
    };
    let path = format!("{h}/.codex/auth.json");
    let v = match read_json(&path) {
        Some(v) => v,
        None => return,
    };
    let mt = mtime_ms(&path);
    if let Some(k) = v.get("OPENAI_API_KEY").and_then(|x| x.as_str()) {
        if !k.is_empty() {
            keys.push(ApiKey {
                name: "OPENAI_API_KEY".to_string(),
                value: k.to_string(),
                from: "codex".to_string(),
            });
        }
    }
    if let Some(t) = v.get("tokens") {
        let access = str_field(t, "access_token").unwrap_or_default();
        let refresh = str_field(t, "refresh_token").unwrap_or_default();
        if !access.is_empty() && !refresh.is_empty() {
            grants.push(OauthGrant {
                provider: "openai-codex".to_string(),
                access: access.clone(),
                refresh,
                expires: jwt_exp_ms(&access),
                account_id: str_field(t, "account_id"),
                from: "codex".to_string(),
                src_mtime_ms: mt,
            });
        }
    }
}

fn scan_opencode(grants: &mut Vec<OauthGrant>, notes: &mut Vec<String>) {
    let mut paths = Vec::new();
    if let Some(d) = data_dir() {
        paths.push(format!("{d}/opencode/auth.json"));
    }
    if let Some(h) = home() {
        let alt = format!("{h}/.config/opencode/auth.json");
        if !paths.contains(&alt) {
            paths.push(alt);
        }
    }
    for path in paths {
        let v = match read_json(&path) {
            Some(v) => v,
            None => continue,
        };
        let obj = match v.as_object() {
            Some(o) => o,
            None => continue,
        };
        let mt = mtime_ms(&path);
        for (key, entry) in obj {
            let access = str_field(entry, "access").unwrap_or_default();
            let refresh = str_field(entry, "refresh").unwrap_or_default();
            if access.is_empty() || refresh.is_empty() {
                continue;
            }
            match provider_id(key) {
                Some(provider) => grants.push(OauthGrant {
                    provider,
                    access,
                    refresh,
                    expires: num_field(entry, "expires"),
                    account_id: str_field(entry, "accountId"),
                    from: "opencode".to_string(),
                    src_mtime_ms: mt,
                }),
                None => notes.push(format!(
                    "opencode login '{key}' skipped: not a dsh record id"
                )),
            }
        }
    }
}

// --- credentials.yaml (minimal line-preserving reader/writer) ---------------

#[derive(Debug, Clone, Default)]
struct StoredGrant {
    kind: String,
    access: Option<String>,
    expires: Option<i64>,
}

#[derive(Debug, Default)]
struct CredsDoc {
    text: String,
    version_ok: bool,
    grants: HashMap<String, StoredGrant>,
    refs: HashMap<String, String>,
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        s[1..s.len() - 1].replace("''", "'")
    } else {
        s.to_string()
    }
}

fn parse_num(s: &str) -> Option<i64> {
    s.trim().parse::<i64>().ok()
}

fn flush_entry(
    doc: &mut CredsDoc,
    section: &str,
    cur_key: &str,
    cur_kind: &str,
    cur_access: &Option<String>,
    cur_expires: Option<i64>,
) {
    if section == "records" && !cur_key.is_empty() {
        doc.grants.insert(
            cur_key.to_string(),
            StoredGrant {
                kind: cur_kind.to_string(),
                access: cur_access.clone(),
                expires: cur_expires,
            },
        );
    }
}

fn load_doc(path: &str) -> CredsDoc {
    let mut doc = CredsDoc::default();
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return doc,
    };
    // Iterate the buffer directly: copying every line into a Vec<String>
    // just to parse it was an allocation per line for no benefit.
    let mut section = "";
    let mut cur_key = String::new();
    let mut cur_kind = String::new();
    let mut cur_access: Option<String> = None;
    let mut cur_expires: Option<i64> = None;
    let mut in_payload = false;
    for line in text.lines() {
        let ind = indent_of(line);
        let t: &str = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if ind == 0 {
            flush_entry(
                &mut doc,
                section,
                &cur_key,
                &cur_kind,
                &cur_access,
                cur_expires,
            );
            cur_key.clear();
            in_payload = false;
            if t == "version: 1" {
                doc.version_ok = true;
            }
            if t == "records:" || t == "refs:" {
                section = if t == "records:" { "records" } else { "refs" };
            } else {
                section = "";
            }
            continue;
        }
        if section == "records" && ind == 2 && t.ends_with(':') {
            flush_entry(
                &mut doc,
                section,
                &cur_key,
                &cur_kind,
                &cur_access,
                cur_expires,
            );
            cur_key = t[..t.len() - 1].to_string();
            cur_kind.clear();
            cur_access = None;
            cur_expires = None;
            in_payload = false;
        } else if section == "refs" && ind == 2 {
            if let Some(i) = t.find(':') {
                let name = t[..i].trim().to_string();
                let val = unquote(&t[i + 1..]);
                if !name.is_empty() {
                    doc.refs.insert(name, val);
                }
            }
        } else if section == "records" && ind == 4 && !cur_key.is_empty() {
            if let Some(rest) = t.strip_prefix("kind:") {
                cur_kind = rest.trim().to_string();
                in_payload = false;
            } else {
                in_payload = t == "payload:";
            }
        } else if section == "records" && ind >= 6 && in_payload && !cur_key.is_empty() {
            if let Some(rest) = t.strip_prefix("access:") {
                cur_access = Some(unquote(rest));
            } else if let Some(rest) = t.strip_prefix("expires:") {
                cur_expires = parse_num(rest);
            }
        }
    }
    flush_entry(
        &mut doc,
        section,
        &cur_key,
        &cur_kind,
        &cur_access,
        cur_expires,
    );
    doc.text = text;
    if doc.text.trim().is_empty() {
        doc.version_ok = true;
    }
    doc
}

fn quote(s: &str) -> String {
    let plain_ok = !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-+/= ".contains(&b))
        && !s.starts_with(' ')
        && !s.ends_with(' ')
        && !s.contains(": ")
        && !s.contains(" #");
    if plain_ok {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "''"))
    }
}

fn safe_scalar(s: &str) -> anyhow::Result<()> {
    if s.chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        anyhow::bail!("credential value contains a line or control character");
    }
    Ok(())
}

fn grant_block(key: &str, g: &OauthGrant) -> Vec<String> {
    let mut b = vec![
        format!("  {key}:"),
        "    kind: grant".to_string(),
        "    payload:".to_string(),
        format!("      access: {}", quote(&g.access)),
        format!("      refresh: {}", quote(&g.refresh)),
    ];
    if let Some(e) = g.expires {
        b.push(format!("      expires: {e}"));
    }
    if let Some(a) = &g.account_id {
        if !a.is_empty() {
            b.push(format!("      accountId: {}", quote(a)));
        }
    }
    b.push("      type: oauth".to_string());
    b
}

/// Replace-or-insert one 2-space entry inside a top-level section.
fn splice_entry(text: &str, section: &str, key: &str, block: &[String]) -> Option<String> {
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    let sec_line = lines.iter().position(|l| *l == format!("{section}:"));
    let sec_line = match sec_line {
        Some(i) => i,
        None => {
            if section != "records" && section != "refs" {
                return None;
            }
            if !lines.is_empty() && !lines.last().map(|l| l.is_empty()).unwrap_or(true) {
                lines.push(String::new());
            }
            lines.push(format!("{section}:"));
            lines.len() - 1
        }
    };
    let entry_prefix = format!("  {key}:");
    if let Some(pos) = lines
        .iter()
        .enumerate()
        .skip(sec_line + 1)
        .take_while(|(_, l)| indent_of(l) != 0 || l.trim().is_empty())
        .find(|(_, l)| *l == &entry_prefix)
        .map(|(i, _)| i)
    {
        let mut end = pos + 1;
        while end < lines.len() {
            let l = &lines[end];
            if l.trim().is_empty() {
                end += 1;
                continue;
            }
            if indent_of(l) <= 2 {
                break;
            }
            end += 1;
        }
        lines.splice(pos..end, block.iter().cloned());
    } else {
        let mut ins = sec_line + 1;
        while ins < lines.len() {
            let l = &lines[ins];
            if !l.trim().is_empty() && indent_of(l) == 0 {
                break;
            }
            ins += 1;
        }
        let mut at: Vec<String> = Vec::new();
        if ins < lines.len() && !lines[..ins].last().map(|l| l.is_empty()).unwrap_or(true) {
            at.push(String::new());
        }
        at.extend(block.iter().cloned());
        lines.splice(ins..ins, at);
    }
    let mut out = lines.join("\n");
    out.push('\n');
    Some(out)
}

pub(crate) fn write_creds(path: &str, text: &str) -> anyhow::Result<()> {
    use std::io::Write;
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = format!("{path}.tmp.{}", crate::local_http::random_token()?);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> anyhow::Result<()> {
        let mut file = options.open(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

// --- decisions ----------------------------------------------------------------

#[derive(Debug)]
struct Decision {
    provider: String,
    from: String,
    action: &'static str,
    detail: String,
    grant: Option<OauthGrant>,
}

fn fresher_than(source: &OauthGrant, stored: &StoredGrant, creds_mtime: u64) -> bool {
    if stored.access.as_deref() == Some(source.access.as_str()) {
        return false;
    }
    match (source.expires, stored.expires) {
        (Some(s), Some(t)) => s > t,
        _ => source.src_mtime_ms > creds_mtime && creds_mtime > 0,
    }
}

/// One snapshot of the external-login stores and the credentials file.
/// Computed once per command and shared by every consumer (the old 6-tuple
/// plan() was re-run up to 3 times per invocation by cmd_auth/cmd_setup/
/// setup_status_json/exec_boot — each scan is a full file crawl + parse).
struct Scan {
    grants: Vec<OauthGrant>,
    keys: Vec<ApiKey>,
    notes: Vec<String>,
    doc: CredsDoc,
    decisions: Vec<Decision>,
    path: String,
}

fn scan() -> Scan {
    scan_selected(None, None, None)
}

fn scan_selected(provider: Option<&str>, source: Option<&str>, key_ref: Option<&str>) -> Scan {
    let mut grants: Vec<OauthGrant> = Vec::new();
    let mut keys: Vec<ApiKey> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    scan_codex(&mut grants, &mut keys);
    scan_opencode(&mut grants, &mut notes);
    if provider.is_some() || source.is_some() || key_ref.is_some() {
        grants.retain(|g| {
            provider == Some(g.provider.as_str()) && source.is_none_or(|v| v == g.from)
        });
        keys.retain(|k| key_ref == Some(k.name.as_str()) && source.is_none_or(|v| v == k.from));
    }
    let path = creds_path();
    let doc = load_doc(&path);
    let creds_mtime = mtime_ms(&path);

    let mut best: HashMap<String, OauthGrant> = HashMap::new();
    for g in &grants {
        match best.get(&g.provider) {
            Some(cur) => {
                if g.expires.unwrap_or(0) > cur.expires.unwrap_or(0) {
                    best.insert(g.provider.clone(), g.clone());
                }
            }
            None => {
                best.insert(g.provider.clone(), g.clone());
            }
        }
    }
    let mut providers: Vec<String> = best.keys().cloned().collect();
    providers.sort();
    let mut decisions = Vec::new();
    for p in providers {
        let g = best.remove(&p).unwrap();
        let key = format!("{RECORD_SCOPE}/{p}");
        match doc.grants.get(&key) {
            Some(stored) if stored.kind != "grant" => decisions.push(Decision {
                provider: p,
                from: g.from.clone(),
                action: "ok",
                detail: format!("record {key} is {}, left alone", stored.kind),
                grant: None,
            }),
            None => decisions.push(Decision {
                provider: p,
                from: g.from.clone(),
                action: "import",
                detail: format!("no record {key}: would import from {}", g.from),
                grant: Some(g),
            }),
            Some(stored) => {
                if stored.access.as_deref() == Some(g.access.as_str()) {
                    decisions.push(Decision {
                        provider: p,
                        from: g.from.clone(),
                        action: "ok",
                        detail: format!("record {key} already matches {}", g.from),
                        grant: None,
                    });
                } else if fresher_than(&g, stored, creds_mtime) {
                    decisions.push(Decision {
                        provider: p,
                        from: g.from.clone(),
                        action: "refresh",
                        detail: format!("record {key} is older: would refresh from {}", g.from),
                        grant: Some(g),
                    });
                } else {
                    decisions.push(Decision {
                        provider: p,
                        from: g.from.clone(),
                        action: "ok",
                        detail: format!(
                            "record {key} kept: dsh-side token is newer than {}",
                            g.from
                        ),
                        grant: None,
                    });
                }
            }
        }
    }
    Scan {
        grants,
        keys,
        notes,
        doc,
        decisions,
        path,
    }
}

/// Best-effort mirror before delegating to dsh (boot/dump/plugin/raw).
/// Never fails: a broken store must not break launching. When `banner` is
/// set, a no-connection state also prints the first-run guidance once —
/// both from a single `scan()`, instead of re-crawling the stores.
pub fn pre_boot(banner: bool) {
    let s = scan();
    if banner && setup_needed_in(&s) {
        print_first_boot_banner();
    }
}

/// Import missing-or-older grants/refs from a pre-computed scan. Quiet mode
/// stays silent unless it actually writes (used by pre_boot before boot).
fn apply_imports(s: &Scan, quiet: bool) -> anyhow::Result<Vec<String>> {
    let (keys, doc, decisions, path) = (&s.keys, &s.doc, &s.decisions, &s.path);
    if !doc.text.is_empty() && !doc.version_ok {
        if !quiet {
            eprintln!("[rdsh auth] refuse: {path} uses the pre-release flat layout; add `version: 1` first");
        }
        return Ok(vec![]);
    }
    let mut text = if doc.text.is_empty() {
        "version: 1\n".to_string()
    } else {
        doc.text.clone()
    };
    let mut done = Vec::new();
    for d in decisions.iter().filter(|d| d.action != "ok") {
        if let Some(g) = &d.grant {
            safe_scalar(&g.access)?;
            safe_scalar(&g.refresh)?;
            if let Some(account) = &g.account_id {
                safe_scalar(account)?;
            }
            let key = format!("{RECORD_SCOPE}/{}", d.provider);
            match splice_entry(&text, "records", &key, &grant_block(&key, g)) {
                Some(t) => {
                    text = t;
                    done.push(format!("{} {} from {}", d.action, key, g.from));
                }
                None => {
                    if !quiet {
                        eprintln!("[rdsh auth] skip {}: section error", key);
                    }
                }
            }
        }
    }
    for k in keys {
        if doc.refs.contains_key(&k.name) {
            continue;
        }
        safe_scalar(&k.value)?;
        let block = vec![format!("  {}: {}", k.name, quote(&k.value))];
        match splice_entry(&text, "refs", &k.name, &block) {
            Some(t) => {
                text = t;
                done.push(format!("import ref {} from {}", k.name, k.from));
            }
            None => {
                if !quiet {
                    eprintln!("[rdsh auth] skip ref {}: section error", k.name);
                }
            }
        }
    }
    if done.is_empty() {
        return Ok(done);
    }
    write_creds(path, &text)?;
    for d in &done {
        eprintln!("[rdsh auth] {d} -> {path}");
    }
    Ok(done)
}

/// Source stores that produced grants, as JSON (shared by `auth --json` and
/// the setup UI status).
fn sources_json(s: &Scan) -> Vec<serde_json::Value> {
    let h = home().unwrap_or_default();
    let mut sources = Vec::new();
    if s.grants.iter().any(|g| g.from == "codex") {
        sources.push(serde_json::json!({"name":"codex","path": format!("{h}/.codex/auth.json")}));
    }
    if s.grants.iter().any(|g| g.from == "opencode") {
        let d = data_dir().unwrap_or_default();
        sources
            .push(serde_json::json!({"name":"opencode","path": format!("{d}/opencode/auth.json")}));
    }
    sources
}

fn records_json(s: &Scan) -> Vec<serde_json::Value> {
    s.decisions
        .iter()
        .map(|d| {
            serde_json::json!({"provider": d.provider, "from": d.from, "action": d.action, "detail": d.detail})
        })
        .collect()
}

/// Whether the credentials file blocks an import (pre-release flat layout).
fn layout_refused(s: &Scan) -> bool {
    !s.doc.text.is_empty() && !s.doc.version_ok
}

pub fn cmd_auth(
    import: bool,
    json: bool,
    provider: Option<String>,
    source: Option<String>,
    key_ref: Option<String>,
) -> anyhow::Result<()> {
    if import && provider.is_none() && key_ref.is_none() {
        anyhow::bail!(
            "credential import requires --provider <id> or --ref <name>; bulk copying is disabled"
        );
    }
    if let Some(ref value) = source {
        anyhow::ensure!(
            value == "codex" || value == "opencode",
            "unknown credential source"
        );
    }
    let s = scan_selected(provider.as_deref(), source.as_deref(), key_ref.as_deref());
    let (grants, keys, notes, doc, decisions, path) =
        (&s.grants, &s.keys, &s.notes, &s.doc, &s.decisions, &s.path);
    let wrote = if import {
        if layout_refused(&s) {
            anyhow::bail!(
                "refuse: {path} uses the pre-release flat layout; add `version: 1` first"
            );
        }
        apply_imports(&s, false)?
    } else {
        vec![]
    };
    if json {
        println!(
            "{}",
            serde_json::json!({
                "credentials": path,
                "sources": sources_json(&s),
                "records": records_json(&s),
                "refs_known": keys.iter().map(|k| &k.name).collect::<Vec<_>>(),
                "notes": notes,
                "wrote": wrote,
            })
        );
        return Ok(());
    }
    println!("[rdsh auth] credentials: {path}");
    if grants.is_empty() && keys.is_empty() {
        println!("[rdsh auth] no external logins found (checked ~/.codex/auth.json, <data>/opencode/auth.json)");
        println!("[rdsh auth] first time here? `rdsh setup` walks you through the connect");
    }
    for g in grants {
        let exp = g
            .expires
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        println!(
            "[rdsh auth] source {}: {} oauth (expires_ms={})",
            g.from, g.provider, exp
        );
    }
    for k in keys {
        let have = doc.refs.contains_key(&k.name);
        println!(
            "[rdsh auth] source {}: ref {} ({})",
            k.from,
            k.name,
            if have {
                "already stored"
            } else {
                "would import"
            }
        );
    }
    for d in decisions {
        println!("[rdsh auth] {}: {}", d.provider, d.detail);
    }
    // What the dsh GUI model picker boots by default, and whether its
    // credential is already here (auto-detected from profile patches).
    for need in provider_needs(&s) {
        let mark = match need.state {
            "ok" => "credential ok",
            "importable" => "credential importable: run `rdsh auth --import --provider <id>`",
            _ => "credential missing: run `rdsh setup`",
        };
        println!(
            "[rdsh auth] dsh default: {} {}/{} ({}, {})",
            need.profile, need.provider, need.model, need.via, mark
        );
    }
    for n in notes {
        println!("[rdsh auth] note: {n}");
    }
    if !doc.text.is_empty() && !doc.version_ok {
        println!("[rdsh auth] refuse: pre-release flat layout; add `version: 1` first");
    } else if import {
        if wrote.is_empty() {
            println!("[rdsh auth] nothing to write");
        }
    } else if decisions.iter().any(|d| d.action != "ok")
        || keys.iter().any(|k| !doc.refs.contains_key(&k.name))
    {
        println!("[rdsh auth] hint: `rdsh auth --import --provider <id>` copies these credentials; automatic copying is disabled; select --provider or --ref");
    } else {
        println!("[rdsh auth] everything already recognized");
    }
    Ok(())
}

/// One line for `rdsh doctor` (never fails).
pub fn summary_line() -> String {
    let s = scan();
    let (keys, doc, decisions) = (&s.keys, &s.doc, &s.decisions);
    if decisions.is_empty() && keys.is_empty() {
        return "no external logins found (codex/opencode)".to_string();
    }
    let mut parts: Vec<String> = decisions
        .iter()
        .map(|d| format!("{}={} [{}]", d.provider, d.action, d.from))
        .collect();
    for k in keys {
        parts.push(format!(
            "{}={}",
            k.name,
            if doc.refs.contains_key(&k.name) {
                "stored"
            } else {
                "pending-import"
            }
        ));
    }
    parts.sort();
    parts.join(", ")
}

// --- first-run setup ----------------------------------------------------------
//
// dsh's default route asks for a DeepSeek connection on first boot, which
// confuses newcomers (subscription OAuth via Codex/opencode needs no API key
// at all, but nothing says so). `rdsh setup` plus the first-boot banner
// below close that gap: detect, import, and otherwise show the exact next
// step instead of a bare credential prompt.

/// API-key env vars that count as "already connected".
const KNOWN_ENV_KEYS: &[&str] = &["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];

fn user_lang() -> String {
    for k in ["LANGUAGE", "LC_ALL", "LANG"] {
        if let Ok(v) = std::env::var(k) {
            if !v.trim().is_empty() {
                return v;
            }
        }
    }
    String::new()
}

fn lang_is_japanese(lang: &str) -> bool {
    let base = lang.split(['.', '@', ':']).next().unwrap_or("");
    base.replace('-', "_").starts_with("ja")
}

fn is_japanese() -> bool {
    lang_is_japanese(&user_lang())
}

fn env_key_set(name: &str) -> bool {
    std::env::var(name)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

/// External stores are only candidates for import. A connection requires a
/// credential already stored for DSH or a usable API-key environment variable.
fn setup_needed_in(s: &Scan) -> bool {
    let doc = &s.doc;
    if !doc.grants.is_empty() || !doc.refs.is_empty() {
        return false;
    }
    !KNOWN_ENV_KEYS.iter().any(|k| env_key_set(k))
}

/// First-boot banner text printed to stderr (the decision to show it is made
/// by `pre_boot` from the same scan, so the stores are not crawled twice).
fn print_first_boot_banner() {
    if is_japanese() {
        eprintln!("[rdsh] モデル接続がまだありません（初回セットアップが必要です）");
        eprintln!(
            "[rdsh]   rdsh setup   … 対話ガイド：GPTサブスク(OAuth)かDeepSeekキーを接続します"
        );
        eprintln!("[rdsh]   サブスク利用ならAPIキーは不要です。詳しくは rdsh auth / rdsh doctor");
    } else {
        eprintln!("[rdsh] no model connection yet (first-run setup needed)");
        eprintln!(
            "[rdsh]   rdsh setup   … guided connect: GPT subscription (OAuth) or a DeepSeek key"
        );
        eprintln!("[rdsh]   subscriptions need no API key. See also rdsh auth / rdsh doctor");
    }
}

fn prompt_line(prompt: &str) -> Option<String> {
    use std::io::IsTerminal as _;
    if !std::io::stdin().is_terminal() {
        return None;
    }
    eprint!("{prompt}");
    use std::io::Write as _;
    let _ = std::io::stderr().flush();
    let mut s = String::new();
    if std::io::stdin().read_line(&mut s).is_err() {
        return None;
    }
    let s = s.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn prompt_yes(prompt: &str) -> bool {
    match prompt_line(prompt) {
        Some(s) => matches!(s.trim().to_lowercase().as_str(), "y" | "yes"),
        None => false,
    }
}

/// Store one `refs:` entry (0600, other entries untouched). Returns true
/// when the file changed.
fn store_ref(name: &str, value: &str) -> anyhow::Result<bool> {
    safe_scalar(value)?;
    let path = creds_path();
    let doc = load_doc(&path);
    if !doc.text.is_empty() && !doc.version_ok {
        anyhow::bail!("refuse: {path} uses the pre-release flat layout");
    }
    if doc.refs.get(name).map(|v| v == value).unwrap_or(false) {
        return Ok(false);
    }
    let mut text = if doc.text.is_empty() {
        "version: 1\n".to_string()
    } else {
        doc.text.clone()
    };
    let block = vec![format!("  {}: {}", name, quote(value))];
    match splice_entry(&text, "refs", name, &block) {
        Some(t) => text = t,
        None => anyhow::bail!("section error writing ref {name}"),
    }
    write_creds(&path, &text)?;
    eprintln!("[rdsh setup] stored ref {name} -> {path}");
    Ok(true)
}

fn which_bin(bin: &str) -> bool {
    if bin.contains('/') || bin.contains('\\') {
        return false;
    }
    std::env::var("PATH")
        .map(|p| {
            #[cfg(target_os = "windows")]
            let sep = ';';
            #[cfg(not(target_os = "windows"))]
            let sep = ':';
            p.split(sep).any(|d| {
                let d = d.trim();
                if d.is_empty() {
                    return false;
                }
                #[cfg(target_os = "windows")]
                {
                    [".exe", ".cmd", ".bat", ""]
                        .iter()
                        .any(|e| std::fs::metadata(format!("{d}/{bin}{e}")).is_ok())
                }
                #[cfg(not(target_os = "windows"))]
                {
                    std::fs::metadata(format!("{d}/{bin}")).is_ok()
                }
            })
        })
        .unwrap_or(false)
}

/// Launch the provider's own login flow (`opencode auth login` prefers the
/// subscription OAuth the complaint is about; `codex login` is the fallback).
/// Returns true when a flow was started (it may still have been aborted).
fn launch_login() -> bool {
    let tool: Option<(&str, &[&str])> = [
        ("opencode", &["auth", "login"] as &[&str]),
        ("codex", &["login"] as &[&str]),
    ]
    .into_iter()
    .find(|(bin, _)| which_bin(bin));
    let (bin, args) = match tool {
        Some(t) => t,
        None => {
            if is_japanese() {
                eprintln!(
                    "[rdsh setup] codexもopencodeも見つかりません。先にどちらかを導入してください"
                );
            } else {
                eprintln!(
                    "[rdsh setup] neither codex nor opencode found on PATH; install one first"
                );
            }
            return false;
        }
    };
    eprintln!(
        "[rdsh setup] launching `{bin} {}` … finish the login there",
        args.join(" ")
    );
    match std::process::Command::new(bin).args(args).status() {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[rdsh setup] could not launch {bin}: {e:#}");
            false
        }
    }
}

fn open_path(path: &str) -> anyhow::Result<()> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(path);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(path);
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path);
        c
    };
    let st = cmd
        .status()
        .map_err(|e| anyhow::anyhow!("spawning opener: {e}"))?;
    if st.success() {
        Ok(())
    } else {
        anyhow::bail!("opener exited {st}")
    }
}

/// `--open`: reveal the settings locations in the OS file manager (the
/// "show me the settings screen" step for GUI-first users).
fn open_settings_dirs(json: bool) {
    let mut targets = vec![crate::inspect::dsh_home()];
    if let Some(c) = config_dir() {
        targets.push(format!("{c}/opencode"));
    }
    for t in targets {
        match open_path(&t) {
            Ok(_) if !json => println!("[rdsh setup] opened {t}"),
            Ok(_) => {}
            Err(e) => eprintln!("[rdsh setup] could not open {t}: {e:#}"),
        }
    }
}

/// One provider route a dsh profile boots by default, with how it
/// authenticates and whether that credential is currently visible.
#[derive(Debug, Clone)]
pub struct ProviderNeed {
    pub profile: String,
    pub provider: String,
    pub model: String,
    pub via: String,
    pub state: &'static str,
}

/// Read every profile's `agent-default-model` entry (what the dsh GUI
/// model picker shows) and resolve whether its credential exists:
/// an OAuth record, a fresher external grant (`importable`), or the
/// provider block's `apiKeyEnv` ref/env. This is the "detect what dsh
/// will use and bring it over" half of first-run setup.
fn provider_needs(s: &Scan) -> Vec<ProviderNeed> {
    let (grants, keys, doc) = (&s.grants, &s.keys, &s.doc);
    let root = format!("{}/profiles", crate::inspect::dsh_home());
    let mut profiles: Vec<String> = std::fs::read_dir(&root)
        .map(|e| {
            e.filter_map(|x| x.ok())
                .filter(|x| x.metadata().map(|m| m.is_dir()).unwrap_or(false))
                .map(|x| x.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    profiles.sort();
    let mut out = Vec::new();
    for p in profiles {
        let text = match std::fs::read_to_string(format!("{root}/{p}/cordis.patch.yml")) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let (provider, model) = match parse_default_model(&text) {
            Some(x) => x,
            None => continue,
        };
        let key = format!("{RECORD_SCOPE}/{provider}");
        let has_record = doc
            .grants
            .get(&key)
            .and_then(|g| g.access.clone())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        let api_key_env = parse_api_key_env(&text, &provider);
        let has_key = match &api_key_env {
            Some(n) => doc.refs.get(n).map(|v| !v.is_empty()).unwrap_or(false) || env_key_set(n),
            None => keys.iter().any(|k| k.name == key_name(&provider)),
        };
        let importable = grants.iter().any(|g| g.provider == provider);
        let (via, state) = if has_record || has_key {
            (via_name(&api_key_env), "ok")
        } else if importable {
            ("oauth".to_string(), "importable")
        } else {
            (via_name(&api_key_env), "missing")
        };
        out.push(ProviderNeed {
            profile: p,
            provider,
            model,
            via,
            state,
        });
    }
    out
}

/// Ref/env name for well-known API-key routes (mirrors profile `apiKeyEnv`).
fn key_name(provider: &str) -> String {
    provider.to_uppercase().replace('-', "_") + "_API_KEY"
}

fn via_name(api_key_env: &Option<String>) -> String {
    match api_key_env {
        Some(n) => format!("key {n}"),
        None => "oauth".to_string(),
    }
}

fn parse_default_model(text: &str) -> Option<(String, String)> {
    let mut lines = text.lines();
    while let Some(l) = lines.next() {
        if l.trim() == "- id: agent-default-model" {
            let mut prov: Option<String> = None;
            let mut model = String::new();
            for l2 in lines.by_ref().take(12) {
                let t = l2.trim();
                if t.starts_with("- id:") || t == "- insert:" {
                    break;
                }
                if let Some(v) = t.strip_prefix("provider:") {
                    prov = Some(v.trim().to_string());
                }
                if let Some(v) = t.strip_prefix("model:") {
                    model = v.trim().to_string();
                }
                if prov.is_some() && !model.is_empty() {
                    break;
                }
            }
            if let Some(p) = prov {
                return Some((p, model));
            }
        }
    }
    None
}

/// `apiKeyEnv:` declared on a provider block (`<provider>:` mapping).
fn parse_api_key_env(text: &str, provider: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let t = lines[i].trim();
        if t == format!("{provider}:") {
            let base = indent_of(lines[i]);
            i += 1;
            while i < lines.len() {
                let l = lines[i];
                let ind = indent_of(l);
                let tt = l.trim();
                if !tt.is_empty() && ind <= base && (tt.ends_with(':') || tt.starts_with("- ")) {
                    break;
                }
                if ind > base {
                    if let Some(v) = tt.strip_prefix("apiKeyEnv:") {
                        let v = v.trim().to_string();
                        if !v.is_empty() {
                            return Some(v);
                        }
                    }
                }
                i += 1;
            }
            return None;
        }
        i += 1;
    }
    None
}

fn print_guide() {
    let creds = creds_path();
    let cfg =
        opencode_config_path().unwrap_or_else(|| "<config dir>/opencode/opencode.json".to_string());
    if is_japanese() {
        println!("[rdsh setup] まだ使えるモデルがありません。楽な順に3択です:");
        println!("[rdsh setup]   1) サブスクで使う（APIキー不要・おすすめ）");
        println!("[rdsh setup]      opencode auth login  … OpenAI(GPT)等を選んでOAuth接続");
        println!("[rdsh setup]      codex login          … ChatGPTプランでGPTを使う場合");
        println!("[rdsh setup]      終わったら rdsh auth --import --provider openai-codex で取り込みます（rdsh setup --login でも実行）");
        println!("[rdsh setup]   2) DeepSeekキーを使う（dshが最初に求める接続がこれです）");
        println!("[rdsh setup]      platform.deepseek.com で発行 → 上の入力欄に貼り付け");
        println!("[rdsh setup]      または DEEPSEEK_API_KEY=... rdsh setup --yes で保存");
        println!("[rdsh setup]   3) あとで：このまま起動するとdshがDeepSeek接続を求めます");
        println!("[rdsh setup] 認証ファイル: {creds}");
        println!("[rdsh setup] opencode設定: {cfg}");
    } else {
        println!("[rdsh setup] no usable model yet. Easiest first:");
        println!("[rdsh setup]   1) Use a subscription (no API key needed, recommended)");
        println!(
            "[rdsh setup]      opencode auth login  … pick OpenAI (GPT) and connect via OAuth"
        );
        println!("[rdsh setup]      codex login          … for ChatGPT-plan GPT access");
        println!("[rdsh setup]      then run rdsh auth --import --provider openai-codex");
        println!("[rdsh setup]   2) Use a DeepSeek key (what dsh asks for by default)");
        println!("[rdsh setup]      issue one at platform.deepseek.com, then paste it above");
        println!("[rdsh setup]      or save it with DEEPSEEK_API_KEY=... rdsh setup --yes");
        println!("[rdsh setup]   3) Later: booting as-is leads to the DeepSeek prompt");
        println!("[rdsh setup] credentials file: {creds}");
        println!("[rdsh setup] opencode settings: {cfg}");
    }
}

/// First-run wizard: import what exists, persist env keys, optionally run
/// the provider login flow or reveal settings dirs, otherwise print the
/// exact next step. Safe non-interactive: prompts only fire on a TTY.
pub fn cmd_setup(open: bool, login: bool, json: bool, yes: bool) -> anyhow::Result<()> {
    // One scan drives the import, the env-key loop, and the "needed" verdict.
    let mut s = scan();
    let mut persisted: Vec<String> = Vec::new();
    // Refs already stored: seeded from the scan, extended as we write (the
    // old code re-read the credentials file once per env key).
    let mut known_refs: std::collections::HashSet<String> = s.doc.refs.keys().cloned().collect();
    for k in KNOWN_ENV_KEYS {
        let v = match std::env::var(k) {
            Ok(v) if !v.trim().is_empty() => v,
            _ => continue,
        };
        if known_refs.contains(*k) {
            continue;
        }
        let take = yes
            || (!json
                && prompt_yes(&format!(
                    "[rdsh setup] save {k} from the environment into credentials? [y/N] "
                )));
        if take && store_ref(k, v.trim())? {
            known_refs.insert(k.to_string());
            persisted.push(k.to_string());
        }
    }
    {
        use std::io::IsTerminal as _;
        if !json && !yes && std::io::stdin().is_terminal() && setup_needed_in(&s) {
            if let Some(pasted) = prompt_line(
                "[rdsh setup] paste DEEPSEEK_API_KEY here (Enter to skip, input is echoed): ",
            ) {
                match store_ref("DEEPSEEK_API_KEY", &pasted) {
                    Ok(true) => {
                        known_refs.insert("DEEPSEEK_API_KEY".to_string());
                        persisted.push("DEEPSEEK_API_KEY".to_string());
                    }
                    Ok(false) => {}
                    Err(e) => eprintln!("[rdsh setup] could not store key: {e:#}"),
                }
            }
        }
    }
    let mut login_run = false;
    if login {
        login_run = launch_login();
        // Login never implicitly copies other applications' credentials.
    }
    if open {
        open_settings_dirs(json);
    }
    // `needed` reflects the post-import state: a key stored during this run
    // counts as a credential (the old code got this by rescanning the file).
    s = scan();
    let needed = setup_needed_in(&s);
    if json {
        println!(
            "{}",
            serde_json::json!({
                "needed": needed,
                "credentials": creds_path(),
                "persisted_env_keys": persisted,
                "login_run": login_run,
                "opencode_config": opencode_config_path(),
            })
        );
        return Ok(());
    }
    if !needed {
        println!("[rdsh setup] connected: credentials are in place (see rdsh auth / rdsh doctor)");
        return Ok(());
    }
    print_guide();
    Ok(())
}

/// Status document for the floating setup UI (`rdsh setup --web`).
/// Read-only and secret-free: refs appear by name only, never by value.
pub fn setup_status_json() -> String {
    let s = scan();
    let (keys, doc, path) = (&s.keys, &s.doc, &s.path);
    serde_json::json!({
        "credentials": path,
        "sources": sources_json(&s),
        "records": records_json(&s),
        "refs_known": keys.iter().map(|k| &k.name).collect::<Vec<_>>(),
        "refs_stored": doc.refs.keys().cloned().collect::<Vec<_>>(),
        "notes": &s.notes,
        "needed": setup_needed_in(&s),
        "opencode_config": opencode_config_path(),
        "defaults": provider_needs(&s)
            .iter()
            .map(|n| {
                serde_json::json!({"profile": n.profile, "provider": n.provider, "model": n.model, "via": n.via, "state": n.state})
            })
            .collect::<Vec<_>>(),
    })
    .to_string()
}

/// Ref names the setup UI is allowed to store (allowlist: never arbitrary keys).
const SETUP_KEY_ALLOWLIST: &[&str] = &["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];

/// Store a pasted API key submitted from the floating setup UI.
/// Same 0600 line-surgery path as the terminal wizard.
pub(crate) fn setup_store_key(name: &str, value: &str) -> anyhow::Result<bool> {
    if !SETUP_KEY_ALLOWLIST.contains(&name) {
        anyhow::bail!("refusing to store unknown credential {name}");
    }
    safe_scalar(value)?;
    let v = value.trim();
    if v.is_empty() || v.len() > 512 {
        anyhow::bail!("empty or oversized value");
    }
    store_ref(name, v)
}

/// Open a URL in the OS browser (best effort, used by `setup --web`).
pub(crate) fn open_browser(url: &str) -> anyhow::Result<()> {
    open_path(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_id_grammar() {
        assert!(is_record_id("openai-codex"));
        assert!(is_record_id("a1"));
        assert!(!is_record_id("OpenAI"));
        assert!(!is_record_id("a.b"));
        assert!(!is_record_id("1a"));
        assert_eq!(provider_id("openai").as_deref(), Some("openai-codex"));
        assert_eq!(provider_id("anthropic").as_deref(), Some("anthropic"));
        assert!(provider_id("OpenAI").is_none());
    }

    #[test]
    fn jwt_exp_decode() {
        let tok = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTE3MDg4MDJ9.sig";
        assert_eq!(jwt_exp_ms(tok), Some(1791708802000));
        assert!(jwt_exp_ms("not-a-jwt").is_none());
    }

    #[test]
    fn splice_insert_and_replace() {
        let base = "version: 1\nrecords:\n  llm-pi-ai/other:\n    kind: grant\n    payload:\n      access: x\nrefs:\n  A_B: '1'\n";
        let g = OauthGrant {
            provider: "openai-codex".to_string(),
            access: "acc".to_string(),
            refresh: "ref".to_string(),
            expires: Some(5),
            account_id: Some("id-1".to_string()),
            from: "opencode".to_string(),
            src_mtime_ms: 1,
        };
        let key = "llm-pi-ai/openai-codex";
        let t1 = splice_entry(base, "records", key, &grant_block(key, &g)).unwrap();
        assert!(t1.contains("  llm-pi-ai/openai-codex:\n"));
        assert!(t1.contains("  llm-pi-ai/other:\n"));
        assert!(t1.contains("refs:\n"));
        let g2 = OauthGrant {
            access: "acc2".to_string(),
            ..g.clone()
        };
        let t2 = splice_entry(&t1, "records", key, &grant_block(key, &g2)).unwrap();
        assert!(t2.contains("acc2"));
        assert!(!t2.contains("      access: acc\n"));
        assert!(t2.contains("  llm-pi-ai/other:\n"));
    }

    #[test]
    fn splice_creates_sections() {
        let g = OauthGrant {
            provider: "openai-codex".to_string(),
            access: "a".to_string(),
            refresh: "r".to_string(),
            expires: None,
            account_id: None,
            from: "codex".to_string(),
            src_mtime_ms: 0,
        };
        let key = "llm-pi-ai/openai-codex";
        let t = splice_entry("version: 1\n", "records", key, &grant_block(key, &g)).unwrap();
        assert!(t.contains("records:\n"));
        assert!(t.contains("type: oauth"));
    }

    #[test]
    fn freshness_rules() {
        let src = OauthGrant {
            provider: "openai-codex".to_string(),
            access: "new".to_string(),
            refresh: "r".to_string(),
            expires: Some(200),
            account_id: None,
            from: "opencode".to_string(),
            src_mtime_ms: 10,
        };
        let same = StoredGrant {
            kind: "grant".into(),
            access: Some("new".into()),
            expires: Some(100),
        };
        assert!(!fresher_than(&src, &same, 20));
        let older = StoredGrant {
            kind: "grant".into(),
            access: Some("old".into()),
            expires: Some(100),
        };
        assert!(fresher_than(&src, &older, 20));
        let newer = StoredGrant {
            kind: "grant".into(),
            access: Some("dsh-refreshed".into()),
            expires: Some(300),
        };
        assert!(!fresher_than(&src, &newer, 20));
    }

    #[test]
    fn credential_scalars_cannot_create_new_yaml_lines() {
        assert!(safe_scalar("valid-key-123").is_ok());
        assert!(safe_scalar("key\nrefs:\n  OTHER: injected").is_err());
        assert!(safe_scalar("key\rrecords:").is_err());
        assert!(safe_scalar("key\u{2028}records:").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn credential_file_is_private_when_created() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "rdsh-auth-test-{}",
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join(".credentials.yaml");
        write_creds(path.to_str().unwrap(), "version: 1\n").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn parse_patches() {
        let text = "- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        displayName: OpenCode Go\n        apiKeyEnv: OPENCODE_GO_API_KEY\n- id: agent-default-model\n  config:\n    provider: opencode-go\n    model: muse-spark-1.3-contributor\n";
        assert_eq!(
            parse_default_model(text),
            Some((
                "opencode-go".to_string(),
                "muse-spark-1.3-contributor".to_string()
            ))
        );
        assert_eq!(
            parse_api_key_env(text, "opencode-go"),
            Some("OPENCODE_GO_API_KEY".to_string())
        );
        assert!(parse_api_key_env(text, "openai-codex").is_none());
        assert!(parse_default_model("nothing here").is_none());
    }

    #[test]
    fn setup_status_shape() {
        let v: serde_json::Value = serde_json::from_str(&setup_status_json()).unwrap();
        assert!(v.get("credentials").is_some());
        assert!(v.get("records").unwrap().is_array());
        assert!(v.get("needed").unwrap().is_boolean());
        assert!(v.get("refs_stored").unwrap().is_array());
    }

    #[test]
    fn lang_detect() {
        assert!(lang_is_japanese("ja_JP.UTF-8"));
        assert!(lang_is_japanese("ja"));
        assert!(!lang_is_japanese("en_US.UTF-8"));
        assert!(!lang_is_japanese(""));
        assert!(!lang_is_japanese("zh_CN.UTF-8"));
    }
}
