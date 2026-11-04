//! Read-only access to grants already shared with this DSH_HOME.
//! Never scans external login stores, imports, refreshes, or rewrites credentials.
use anyhow::{bail, Result};
use std::path::Path;

#[derive(Clone)]
pub(crate) struct Grant {
    pub access: String,
    pub expires: i64,
    pub account_id: Option<String>,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(i64::MAX)
}

pub(crate) fn load(provider: &str) -> Result<Option<Grant>> {
    load_at(Path::new(&super::creds_path()), provider, now_ms())
}

fn load_at(path: &Path, provider: &str, now: i64) -> Result<Option<Grant>> {
    if !matches!(provider, "openai-codex") {
        return Ok(None);
    }
    if !path.exists() {
        return Ok(None);
    }
    if crate::file_security::others_can_read(path) {
        bail!("NATIVE_OAUTH_STORE_PERMISSIONS");
    }
    let doc = super::load_doc(&path.to_string_lossy());
    if !doc.version_ok {
        bail!("NATIVE_OAUTH_STORE_INVALID");
    }
    let Some(stored) = doc.grants.get(&format!("llm-pi-ai/{provider}")) else {
        return Ok(None);
    };
    if stored.kind != "grant" {
        bail!("NATIVE_OAUTH_GRANT_INVALID");
    }
    let access = stored
        .access
        .as_ref()
        .filter(|s| {
            !s.is_empty() && s.len() <= 32 * 1024 && s.bytes().all(|c| c.is_ascii_graphic())
        })
        .ok_or_else(|| anyhow::anyhow!("NATIVE_OAUTH_GRANT_INVALID"))?;
    let jwt = access
        .split('.')
        .nth(1)
        .and_then(super::b64url_decode)
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let jwt_expiry = super::jwt_exp_ms(access);
    let expires = match (stored.expires, jwt_expiry) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) | (None, Some(a)) => a,
        _ => bail!("NATIVE_OAUTH_EXPIRY_REQUIRED"),
    };
    if expires <= now.saturating_add(30_000) {
        bail!("NATIVE_OAUTH_EXPIRED");
    }
    let account_id = jwt
        .as_ref()
        .and_then(|v| v["https://api.openai.com/auth"]["chatgpt_account_id"].as_str())
        .filter(|s| !s.is_empty() && s.len() <= 200 && s.bytes().all(|c| c.is_ascii_graphic()))
        .map(str::to_owned);
    if provider == "openai-codex" && account_id.is_none() {
        bail!("NATIVE_OAUTH_ACCOUNT_REQUIRED");
    }
    Ok(Some(Grant {
        access: access.clone(),
        expires,
        account_id,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "header.eyJleHAiOjIwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJmaXh0dXJlLWFjY291bnQifX0.signature";
    fn fixture(body: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "rdsh-oauth-store-{}",
            crate::local_http::random_token().unwrap()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        options
            .open(&path)
            .unwrap()
            .write_all(body.as_bytes())
            .unwrap();
        path
    }
    fn document(token: &str) -> String {
        format!("version: 1\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: grant\n    payload:\n      access: '{token}'\n      expires: 3000000\n")
    }
    #[test]
    fn scoped_grant_and_jwt_expiry_are_read_without_rewriting_store() {
        let body = document(TOKEN);
        let path = fixture(&body);
        let g = load_at(&path, "openai-codex", 1000000).unwrap().unwrap();
        assert_eq!(g.account_id.as_deref(), Some("fixture-account"));
        assert_eq!(
            g.expires, 2000000,
            "JWT expiry wins over stale store metadata"
        );
        assert!(
            load_at(&path, "anthropic", 0).unwrap().is_none(),
            "Claude login is owned by claude -p"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
        assert_eq!(
            load_at(&path, "openai-codex", 1980000)
                .err()
                .unwrap()
                .to_string(),
            "NATIVE_OAUTH_EXPIRED"
        );
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn missing_wrong_kind_and_invalid_account_fail_closed() {
        for (body, expected) in [
            (
                "version: 1\nrefs:\n  OPENAI_API_KEY: not-a-grant\n".into(),
                None,
            ),
            (document("not-a-jwt"), Some("NATIVE_OAUTH_ACCOUNT_REQUIRED")),
            (
                document(TOKEN).replace("kind: grant", "kind: key"),
                Some("NATIVE_OAUTH_GRANT_INVALID"),
            ),
            ("version: 2\n".into(), Some("NATIVE_OAUTH_STORE_INVALID")),
        ] {
            let path = fixture(&body);
            let result = load_at(&path, "openai-codex", 0);
            match expected {
                Some(message) => assert_eq!(result.err().unwrap().to_string(), message),
                None => assert!(result.unwrap().is_none()),
            }
            std::fs::remove_file(path).unwrap();
        }
    }
    #[test]
    #[cfg(unix)]
    fn readable_store_is_rejected_without_changing_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let path = fixture(&document(TOKEN));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            load_at(&path, "openai-codex", 0).err().unwrap().to_string(),
            "NATIVE_OAUTH_STORE_PERMISSIONS"
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        std::fs::remove_file(path).unwrap();
    }
}
