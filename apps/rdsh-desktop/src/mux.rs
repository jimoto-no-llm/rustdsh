//! Multiplexed stream transport (/api/remote.mux).
//!
//! Unary calls ride plain POSTs, but conversation history and live events arrive
//! on one WebSocket multiplexed by streamId. The host pings every two seconds,
//! so the reader answers pings while it waits for the next message.

use std::net::TcpStream;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect, Message, WebSocket};

/// How long one socket read waits before returning to the caller.
const READ_TIMEOUT: Duration = Duration::from_millis(500);
/// A peer that sends nothing for this long is treated as half-dead even though
/// its socket is still open. The host pings every two seconds, so this is three
/// missed heartbeats.
const READ_STALL: Duration = Duration::from_secs(6);

pub struct Mux {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
    /// Last instant the host sent anything, pings included.
    last_rx: Instant,
    /// Silence longer than this fails a read so the caller can reconnect.
    stall: Duration,
}

impl Mux {
    /// The browser-trust fence wants the session cookie; Origin is not sent.
    pub fn connect(origin: &str, cookie: &str) -> Result<Self> {
        let ws = origin.replacen("http://", "ws://", 1);
        let url = format!("{ws}/api/remote.mux");
        let mut request = url
            .as_str()
            .into_client_request()
            .context("build the mux handshake")?;
        request.headers_mut().insert(
            "Cookie",
            HeaderValue::from_str(cookie).context("session cookie is not a valid header value")?,
        );
        let (mut socket, _response) = connect(request).context("connect to /api/remote.mux")?;
        // Bound the socket so a quiet or half-dead peer cannot block a read
        // forever; the caller decides when silence means "reconnect".
        if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
            stream.set_read_timeout(Some(READ_TIMEOUT))?;
        }
        Ok(Self {
            socket,
            next_id: 0,
            last_rx: Instant::now(),
            stall: READ_STALL,
        })
    }

    /// Bound each read so a quiet stream still lets the caller make progress.
    pub fn set_read_timeout(&mut self, timeout: std::time::Duration) -> Result<()> {
        match self.socket.get_mut() {
            MaybeTlsStream::Plain(stream) => {
                stream.set_read_timeout(Some(timeout))?;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Open one logical stream; the returned id keys every later message.
    pub fn open(&mut self, endpoint: &str, args: Value) -> Result<String> {
        let stream_id = format!("rdsh-desktop-{}", self.next_id);
        self.next_id += 1;
        let message = json!({
            "type": "open",
            "streamId": stream_id,
            "endpoint": endpoint,
            "payload": { "args": args }
        });
        self.socket
            .send(Message::Text(message.to_string().into()))
            .with_context(|| format!("open {endpoint}"))?;
        Ok(stream_id)
    }

    pub fn cancel(&mut self, stream_id: &str) -> Result<()> {
        let message = json!({ "type": "cancel", "streamId": stream_id });
        self.socket
            .send(Message::Text(message.to_string().into()))?;
        Ok(())
    }

    /// Mark the host as alive; every received frame, pings included, counts.
    fn note_activity(&mut self) {
        self.last_rx = Instant::now();
    }

    /// Fail once the peer has been silent past the stall budget: an open socket
    /// to a dead or partitioned host must not block the caller forever.
    fn check_stall(&self) -> Result<()> {
        let silent = self.last_rx.elapsed();
        if silent >= self.stall {
            return Err(anyhow!(
                "no host traffic for {:.1}s; the connection looks dead",
                silent.as_secs_f64()
            ));
        }
        Ok(())
    }

    /// Read one message, treating a socket read timeout as "nothing yet" so a
    /// quiet stream is not mistaken for a closed connection. A stall past the
    /// budget is an error, not silence.
    pub fn try_read(&mut self) -> Result<Option<Value>> {
        loop {
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    self.note_activity();
                    return Ok(Some(
                        serde_json::from_str(&text).context("mux message is not JSON")?,
                    ));
                }
                Ok(Message::Binary(bytes)) => {
                    self.note_activity();
                    return Ok(Some(
                        serde_json::from_slice(&bytes).context("mux message is not JSON")?,
                    ));
                }
                Ok(Message::Ping(payload)) => {
                    self.note_activity();
                    self.socket.send(Message::Pong(payload))?;
                }
                Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {
                    self.note_activity();
                    continue;
                }
                Ok(Message::Close(frame)) => {
                    return Err(anyhow!("mux closed by the host: {frame:?}"))
                }
                Err(tungstenite::Error::Io(error)) if is_would_block(&error) => {
                    self.check_stall()?;
                    return Ok(None);
                }
                Err(error) => return Err(anyhow!("{error}")),
            }
        }
    }

    /// Next host message as JSON, answering pings while waiting. A half-dead
    /// host fails the read once the stall budget passes with no traffic.
    pub fn read(&mut self) -> Result<Value> {
        loop {
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    self.note_activity();
                    return serde_json::from_str(&text).context("mux message is not JSON");
                }
                Ok(Message::Binary(bytes)) => {
                    self.note_activity();
                    return serde_json::from_slice(&bytes).context("mux message is not JSON");
                }
                Ok(Message::Ping(payload)) => {
                    self.note_activity();
                    self.socket.send(Message::Pong(payload))?;
                }
                Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {
                    self.note_activity();
                    continue;
                }
                Ok(Message::Close(frame)) => {
                    return Err(anyhow!("mux closed by the host: {frame:?}"))
                }
                Err(tungstenite::Error::Io(error)) if is_would_block(&error) => {
                    self.check_stall()?;
                }
                Err(error) => return Err(anyhow!("{error}")),
            }
        }
    }
}

/// A socket read timeout surfaces as one of these two io errors.
fn is_would_block(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

#[cfg(test)]
mod tests {
    use super::is_would_block;

    #[test]
    fn treats_a_read_timeout_as_no_data() {
        let would_block = std::io::Error::from(std::io::ErrorKind::WouldBlock);
        let timed_out = std::io::Error::from(std::io::ErrorKind::TimedOut);
        let broken = std::io::Error::from(std::io::ErrorKind::BrokenPipe);
        assert!(is_would_block(&would_block));
        assert!(is_would_block(&timed_out));
        assert!(!is_would_block(&broken));
    }
}
