use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(20);
static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "rdsh-serve-files-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("sessions")).unwrap();
        fs::write(root.join("rdsh.json"), r#"{"extras":{"enable":["serve"]}}"#).unwrap();
        Self(root)
    }

    fn declare(&self, id: &str, paths: &[&Path]) {
        let files: Vec<_> = paths
            .iter()
            .map(|path| serde_json::json!({"path": path}))
            .collect();
        fs::write(
            self.0.join("sessions").join(format!("{id}.json")),
            serde_json::json!({"type": "presented", "files": files}).to_string(),
        )
        .unwrap();
    }

    fn serve(&self) -> Server {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command.env_clear();
        for name in ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let child = command
            .args(["--language", "en", "serve", "--port", "0"])
            .current_dir(&self.0)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("DSH_HOME", &self.0)
            .env("TMPDIR", &self.0)
            .env("TEMP", &self.0)
            .env("TMP", &self.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut server = Server {
            child,
            address: "127.0.0.1:0".parse().unwrap(),
            token: String::new(),
        };
        let stderr = server.child.stderr.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = sender.send(line);
            }
        });
        while server.address.port() == 0 || server.token.is_empty() {
            let line = receiver.recv_timeout(WAIT).unwrap();
            if let Some((_, url)) = line.split_once("dashboard: http://") {
                server.address = url.split('/').next().unwrap().parse().unwrap();
            }
            if let Some((_, path)) = line.split_once("token handoff file: ") {
                server.token = fs::read_to_string(path).unwrap().trim().to_string();
            }
        }
        server
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Server {
    child: Child,
    address: SocketAddr,
    token: String,
}

impl Server {
    fn get(&self, target: &str, authenticated: bool) -> Response {
        let mut stream = TcpStream::connect_timeout(&self.address, WAIT).unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        stream.set_write_timeout(Some(WAIT)).unwrap();
        let auth = if authenticated {
            format!("X-Rdsh-Token: {}\r\n", self.token)
        } else {
            String::new()
        };
        write!(
            stream,
            "GET {target} HTTP/1.1\r\nHost: {}\r\n{auth}Connection: close\r\n\r\n",
            self.address
        )
        .unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        let end = bytes.windows(4).position(|s| s == b"\r\n\r\n").unwrap();
        Response {
            headers: String::from_utf8(bytes[..end].to_vec()).unwrap(),
            body: bytes[end + 4..].to_vec(),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Response {
    headers: String,
    body: Vec<u8>,
}

impl Response {
    fn status(&self, expected: u16) {
        assert!(
            self.headers.starts_with(&format!("HTTP/1.1 {expected} ")),
            "{}\n{}",
            self.headers,
            String::from_utf8_lossy(&self.body)
        );
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }
}

fn encode(value: &str) -> String {
    value.bytes().map(|byte| format!("%{byte:02X}")).collect()
}

#[test]
fn selected_session_controls_listing_and_download_with_utf8_filename() {
    let fixture = Fixture::new();
    let file = fixture.0.join("report + 日本.txt");
    fs::write(&file, b"declared artifact\0\xff").unwrap();
    fixture.declare("earlier session", &[&file]);
    fs::OpenOptions::new()
        .write(true)
        .open(fixture.0.join("sessions/earlier session.json"))
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1))
        .unwrap();
    fixture.declare("latest", &[]);
    let server = fixture.serve();
    let session = encode("earlier session");
    let path = encode(file.to_str().unwrap());
    let listing = server.get(&format!("/api/files?session={session}"), true);
    listing.status(200);
    let listing: serde_json::Value = serde_json::from_slice(&listing.body).unwrap();
    assert_eq!(listing["files"][0]["path"], file.to_str().unwrap());

    let response = server.get(&format!("/api/file?path={path}&session={session}"), true);
    response.status(200);
    assert_eq!(response.body, fs::read(&file).unwrap());
    assert_eq!(response.header("content-length"), Some("19"));
    assert_eq!(
        response.header("content-type"),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(response.header("connection"), Some("close"));
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(response.header("referrer-policy"), Some("no-referrer"));
    let disposition = response.header("content-disposition").unwrap();
    assert!(disposition.is_ascii());
    assert!(disposition.contains("filename*=UTF-8''report%20%2B%20%E6%97%A5%E6%9C%AC.txt"));
    server
        .get(&format!("/api/file?path={path}"), true)
        .status(403);
    server
        .get(&format!("/api/file?path={path}&session={session}"), false)
        .status(401);
}

#[test]
#[cfg(unix)]
fn declared_filename_cannot_inject_response_headers() {
    let fixture = Fixture::new();
    let file = fixture.0.join("report\"; x=\"bad\r\nX-Injected: yes.txt");
    fs::write(&file, b"file body").unwrap();
    fixture.declare("fixture", &[&file]);
    let server = fixture.serve();
    let response = server.get(
        &format!("/api/file?path={}", encode(file.to_str().unwrap())),
        true,
    );
    response.status(200);
    assert_eq!(response.body, b"file body");
    assert_eq!(response.header("x-injected"), None);
    let disposition = response.header("content-disposition").unwrap();
    assert!(disposition.contains("%22%3B%20x%3D%22bad%0D%0AX-Injected%3A%20yes.txt"));
}

#[test]
fn error_responses_remain_json_for_quoted_paths_and_session_ids() {
    let fixture = Fixture::new();
    fixture.declare("fixture", &[]);
    let server = fixture.serve();
    let missing = fixture.0.join("missing\"file.txt");
    for (target, status) in [
        ("/api/file".to_string(), 400),
        ("/api/files?session=missing\"session".to_string(), 404),
        (
            format!("/api/file?path={}", encode(missing.to_str().unwrap())),
            403,
        ),
        (
            "/api/file?path=ignored&session=missing%22session".to_string(),
            404,
        ),
    ] {
        let response = server.get(&target, true);
        response.status(status);
        assert_eq!(response.header("content-type"), Some("application/json"));
        let value: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
        assert!(!value["error"].as_str().unwrap().is_empty());
    }
}
