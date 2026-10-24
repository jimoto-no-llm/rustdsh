//! Harness client: the token exchange plus the unary RPC envelope.
//!
//! Protocol (from the pinned upstream sources):
//!   POST /api/<namespace>/<method>
//!   {"type":"client-request","rpcId","method","payload":{"args":{...}}}
//!   -> {"type":"server-response","rpcId","result":{"ok":true,"value":...}}
//! Authorization headers are not supported; the browser-trust fence wants the
//! signed cookie obtained from the process token.

use std::cell::Cell;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

use crate::host::Host;
use crate::http;

pub struct Api {
    origin: String,
    cookie: String,
    counter: Cell<u64>,
}

impl Api {
    /// Exchange the process token for a signed cookie, or use the one the host
    /// attach path already minted for a running service.
    pub fn connect(host: &Host) -> Result<Self> {
        if let Some(cookie) = host.cookie.clone() {
            return Ok(Self {
                origin: host.origin.clone(),
                cookie,
                counter: Cell::new(0),
            });
        }
        let path = format!("/?token={}", host.token);
        let response = http::get(&host.origin, &path)
            .context("exchange the process token for a session cookie")?;
        if response.status == 401 {
            return Err(anyhow!("host rejected the process token (401)"));
        }
        if response.status >= 400 {
            return Err(anyhow!(
                "token exchange returned HTTP {}: {}",
                response.status,
                response.body.chars().take(200).collect::<String>()
            ));
        }
        let raw = response
            .header("set-cookie")
            .ok_or_else(|| anyhow!("token exchange did not set a session cookie"))?;
        let cookie = session_cookie(raw)?;
        Ok(Self {
            origin: host.origin.clone(),
            cookie,
            counter: Cell::new(0),
        })
    }

    /// The signed session cookie; the WebSocket mux authenticates with it.
    pub fn cookie(&self) -> &str {
        &self.cookie
    }

    /// One unary RPC. Returns the response value or the server-side error.
    pub fn unary(&self, endpoint: &str, args: Value) -> Result<Value> {
        let rpc_id = format!("rdsh-desktop-{}", self.counter.get());
        self.counter.set(self.counter.get() + 1);
        let request = json!({
            "type": "client-request",
            "rpcId": rpc_id,
            "method": endpoint,
            "payload": { "args": args }
        });
        let path = format!("/api/{endpoint}");
        let response = http::post_json(&self.origin, &path, &self.cookie, &request.to_string())
            .with_context(|| format!("POST {path}"))?;
        if response.status >= 400 {
            return Err(anyhow!(
                "{endpoint} returned HTTP {}: {}",
                response.status,
                response.body.chars().take(200).collect::<String>()
            ));
        }
        let document = response
            .json()
            .with_context(|| format!("{endpoint} response"))?;
        let echoed = document
            .get("rpcId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if echoed != rpc_id {
            return Err(anyhow!(
                "{endpoint} echoed rpcId {echoed} instead of {rpc_id}"
            ));
        }
        let result = document
            .get("result")
            .ok_or_else(|| anyhow!("{endpoint} response has no result"))?;
        if result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(result.get("value").cloned().unwrap_or(Value::Null));
        }
        let error = result.get("error").cloned().unwrap_or(Value::Null);
        Err(anyhow!(
            "{endpoint} failed: {} {}",
            error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ))
    }

    /// Conversation list used by the sidebar.
    pub fn session_list(&self) -> Result<Value> {
        self.unary("session/list", json!({ "_request": {} }))
    }

    /// Model catalog used by the composer's model picker.
    pub fn model_catalog(&self) -> Result<Value> {
        self.unary("session/modelCatalog", json!({}))
    }
}

/// The first `name=value` pair of a Set-Cookie header.
///
/// The failure message describes the header's shape instead of repeating it:
/// the raw header carries the signed session cookie, and this error reaches the
/// user through the `{error:#}` printer in main.rs.
fn session_cookie(raw: &str) -> Result<String> {
    raw.split(';')
        .next()
        .map(str::trim)
        .filter(|pair| pair.contains('='))
        .map(str::to_string)
        .ok_or_else(|| {
            anyhow!(
                "malformed Set-Cookie header ({} bytes, {} semicolon-separated fields): the first field has no '='",
                raw.len(),
                raw.split(';').count()
            )
        })
}

#[cfg(test)]
mod tests {
    use super::session_cookie;

    #[test]
    fn keeps_the_first_cookie_pair() {
        let raw = "dsh-auth-abc=v1.payload.signature; Path=/; HttpOnly; SameSite=Lax";
        assert_eq!(
            session_cookie(raw).unwrap(),
            "dsh-auth-abc=v1.payload.signature"
        );
    }

    #[test]
    fn malformed_cookie_error_does_not_echo_the_header() {
        // The failure path must stay diagnosable without printing the value.
        let raw = "secret-token-value; Path=/; HttpOnly";
        let error = format!("{:#}", session_cookie(raw).unwrap_err());
        assert!(error.contains("malformed Set-Cookie"));
        assert!(error.contains("36 bytes"));
        assert!(error.contains("3 semicolon-separated fields"));
        assert!(!error.contains("secret-token-value"));
    }
}
