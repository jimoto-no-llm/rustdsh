use super::*;
use std::io::{Read, Write};

const LIMIT: u64 = 128 * 1024 * 1024;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "rdsh-cloud-json-{}-{}",
            std::process::id(),
            getrandom::u64().unwrap()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn padded_json(&self, length: u64) -> PathBuf {
        let path = self.0.join("input.json");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(b"{}").unwrap();
        std::io::copy(&mut std::io::repeat(b' ').take(length - 2), &mut file).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn rejects_valid_json_larger_than_128_mib() {
    let fixture = Fixture::new();
    let path = fixture.padded_json(LIMIT + 1);
    let error = read_json::<serde_json::Value>(&path).unwrap_err();
    assert!(error.to_string().contains("128 MiB"), "{error}");
}

#[test]
fn accepts_valid_json_exactly_at_the_limit() {
    let fixture = Fixture::new();
    let path = fixture.padded_json(LIMIT);
    let value: serde_json::Value = read_json(&path).unwrap();
    assert_eq!(value, serde_json::json!({}));
}

#[test]
fn bounds_reads_when_input_grows_after_metadata() {
    struct GrowingInput {
        read: usize,
    }
    impl Read for GrowingInput {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            bytes.fill(b' ');
            self.read += bytes.len();
            assert!(self.read <= LIMIT as usize + 1, "read past the limit probe");
            Ok(bytes.len())
        }
    }
    let mut reader = GrowingInput { read: 0 };
    let error = read_json_from::<serde_json::Value>(&mut reader, 0).unwrap_err();
    assert_eq!(error.to_string(), "Input JSON exceeds 128 MiB");
    assert_eq!(reader.read, LIMIT as usize + 1);
}

#[test]
fn preserves_plan_request_and_lease_deserialization() {
    fn round_trip<T: for<'de> Deserialize<'de> + Serialize>(
        fixture: &Fixture,
        value: serde_json::Value,
    ) {
        let path = fixture.0.join("document.json");
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let decoded: T = read_json(&path).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
    let fixture = Fixture::new();
    let request = serde_json::json!({
        "run_id":"run-1", "task_id":"task-1", "attempt_id":"attempt-1",
        "worker_id":"worker-1", "idempotency_key":"key-1", "container_name":"worker",
        "image_digest":format!("example.invalid/worker@sha256:{}", "0".repeat(64))
    });
    round_trip::<SandboxRequest>(&fixture, request.clone());
    round_trip::<PoolPlan>(
        &fixture,
        serde_json::json!({"namespace":"ns", "name":"pool", "template":"worker",
            "replicas":2, "expected_resource_version":null}),
    );
    round_trip::<SandboxLease>(
        &fixture,
        serde_json::json!({"namespace":"ns", "pool":"pool", "request":request,
            "sandbox_id":"sandbox", "lease_id":"lease", "generation":1,
            "fencing_token":null, "phase":"ready", "allocation":"warm"}),
    );
}

#[test]
fn rejects_invalid_json_missing_files_and_directories() {
    let fixture = Fixture::new();
    let path = fixture.0.join("invalid.json");
    for bytes in [b"{".as_slice(), &[0xff]] {
        std::fs::write(&path, bytes).unwrap();
        assert!(read_json::<serde_json::Value>(&path).is_err());
    }
    assert!(read_json::<serde_json::Value>(&fixture.0.join("missing")).is_err());
    assert!(read_json::<serde_json::Value>(&fixture.0).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_fifo_without_waiting_for_a_writer() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let fixture = Fixture::new();
    let path = fixture.0.join("input.fifo");
    let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let error = read_json::<serde_json::Value>(&path).unwrap_err();
    assert!(error.to_string().contains("regular file"), "{error}");
}
