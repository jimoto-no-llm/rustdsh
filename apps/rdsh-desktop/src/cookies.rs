//! Browser-session cookies for an already running host.
//!
//! The host mints a signed cookie from a process token, but the signing secret
//! is also stored in the user credentials, so an independent process can mint
//! the same cookie for the same authority. That lets the app attach to a host
//! that is already running (the user service, or a previous launch) instead of
//! starting a Node process and waiting for it.

use std::path::PathBuf;

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

const COOKIE_PREFIX: &str = "dsh-auth-";
const SECRET_BYTES: usize = 32;
const LIFETIME_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Returns (cookie name, cookie value) for one authority such as 127.0.0.1:3080.
pub fn cookie_for(secret: &[u8], authority: &str) -> (String, String) {
    let name = format!(
        "{COOKIE_PREFIX}{}",
        base64url(&Sha256::digest(authority.as_bytes()))
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0);
    let payload = serde_json::json!({
        "version": 1,
        "authority": authority,
        "issuedAt": now,
        "expiresAt": now + LIFETIME_MS,
    });
    let body = base64url(payload.to_string().as_bytes());
    let signature = sign(secret, &body);
    (name, format!("v1.{body}.{signature}"))
}

fn sign(secret: &[u8], body: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(body.as_bytes());
    base64url(&mac.finalize().into_bytes())
}

/// Read the browser-session secret from the harness credentials.
pub fn load_secret() -> Option<Vec<u8>> {
    let path = credentials_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    parse_secret(&text)
}

fn credentials_path() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("DSH_HOME") {
        return Some(PathBuf::from(home).join(".credentials.yaml"));
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".dsh/.credentials.yaml"))
}

/// The file is a flat record map, so a line scan is enough and avoids a YAML
/// dependency: find the browser-session record, then its secret below it.
fn parse_secret(text: &str) -> Option<Vec<u8>> {
    let mut inside = false;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if !inside {
            if trimmed.trim() == "client-connection/browser-session:" && line.starts_with("  ") {
                inside = true;
            }
            continue;
        }
        let indent = trimmed.len() - trimmed.trim_start().len();
        if indent <= 2 && !trimmed.trim().is_empty() {
            // Another record started without a secret.
            return None;
        }
        if let Some(value) = trimmed.trim().strip_prefix("secret:") {
            let decoded = base64url_decode(value.trim())?;
            if decoded.len() != SECRET_BYTES {
                return None;
            }
            return Some(decoded);
        }
    }
    None
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let (first, second, third) = match chunk {
            [first, second, third] => (*first, *second, *third),
            [first, second] => (*first, *second, 0),
            [first] => (*first, 0, 0),
            _ => continue,
        };
        out.push(ALPHABET[(first >> 2) as usize] as char);
        out.push(ALPHABET[(((first & 0b11) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(((second & 0b1111) << 2) | (third >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(third & 0b111111) as usize] as char);
        }
    }
    out
}

fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u32> {
        Some(match byte {
            b'A'..=b'Z' => (byte - b'A') as u32,
            b'a'..=b'z' => (byte - b'a') as u32 + 26,
            b'0'..=b'9' => (byte - b'0') as u32 + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        })
    }
    let bytes = text.as_bytes();
    if bytes.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in bytes {
        buffer = (buffer << 6) | value(*byte)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::{base64url, base64url_decode, cookie_for, parse_secret};

    #[test]
    fn base64url_round_trips() {
        for case in [
            b"".as_slice(),
            b"f",
            b"fo",
            b"foo",
            b"foob",
            b"fooba",
            b"foobar",
        ] {
            let encoded = base64url(case);
            assert_eq!(base64url_decode(&encoded).as_deref(), Some(case));
        }
        assert_eq!(base64url(b"foo"), "Zm9v");
    }

    #[test]
    fn cookie_matches_the_documented_shape() {
        let secret = [7u8; 32];
        let (name, value) = cookie_for(&secret, "127.0.0.1:3080");
        assert!(name.starts_with("dsh-auth-"));
        assert_eq!(name.len(), "dsh-auth-".len() + 43);
        assert!(value.starts_with("v1."));
        assert_eq!(value.split('.').count(), 3);
    }

    #[test]
    fn parses_the_browser_session_secret() {
        let secret = base64url(&[9u8; 32]);
        let text = format!(
            "version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: {secret}\n  other/record:\n    kind: grant\n"
        );
        assert_eq!(parse_secret(&text), Some(vec![9u8; 32]));
    }

    #[test]
    fn ignores_a_file_without_the_record() {
        assert!(parse_secret("version: 1\nrecords: {}\n").is_none());
    }
}
