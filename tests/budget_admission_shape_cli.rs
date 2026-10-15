//! Corrupt stored shapes must not erase a reservation or become an empty view.
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Output};

const NOW: &str = "2026-10-15T00:00:00Z";

fn policy() -> Value {
    json!({
        "policy_id":"p", "expected_revision":0, "run_id":null,
        "period_start":"2026-10-01T00:00:00Z", "period_end":"2026-11-01T00:00:00Z",
        "currency":"USD", "source_kind":"provider_usage", "baseline":"0",
        "baseline_basis":"synthetic", "soft_limit":"1", "hard_limit":"1",
        "call_reservation":"1", "paused":false, "active":true, "reason":"synthetic",
    })
}

fn call(id: &str) -> Value {
    json!({"job_id":"j", "call_id":id, "session_id":null,
        "provider":"synthetic", "model":"synthetic", "purpose":null})
}

#[test]
fn malformed_calls_cannot_release_existing_reservations() {
    let fixture = Fixture::new();
    let state = fixture.reserved_state();
    let intact = fixture.success("apply", "call", &state, call("d"));
    assert_eq!(intact["result"]["reason"], "budget_hard_limit");

    let mut missing_ids = state["budget_admission"]["calls"]["c"].clone();
    missing_ids.as_object_mut().unwrap().remove("policy_ids");
    let mut bad_calls = vec![
        Value::Null,
        json!(true),
        json!(0),
        json!("bad"),
        json!([]),
        missing_ids,
    ];
    for ids in [Value::Null, json!(1), json!(true), json!({})] {
        let mut bad = state["budget_admission"]["calls"]["c"].clone();
        bad["policy_ids"] = ids;
        bad_calls.push(bad);
    }
    for bad in bad_calls {
        let mut corrupt = state.clone();
        corrupt["budget_admission"]["calls"]["c"] = bad;
        fixture.failure("apply", "call", &corrupt, call("d"));
        fixture.failure(
            "apply",
            "job",
            &corrupt,
            json!({"job_id":"k","run_id":"r","worker_id":"w"}),
        );
        fixture.failure("public", "public", &corrupt, Value::Null);
        fixture.failure("apply", "policy", &corrupt, policy_with(false));
    }
}

#[test]
fn null_or_absent_collections_propagate_the_js_object_values_failure() {
    let fixture = Fixture::new();
    let state = fixture.reserved_state();
    for key in ["policies", "jobs", "calls"] {
        for missing in [false, true] {
            let mut corrupt = state.clone();
            if missing {
                corrupt["budget_admission"]
                    .as_object_mut()
                    .unwrap()
                    .remove(key);
            } else {
                corrupt["budget_admission"][key] = Value::Null;
            }
            fixture.failure("public", "public", &corrupt, Value::Null);
            fixture.failure(
                "apply",
                "job",
                &corrupt,
                json!({"job_id":"k","run_id":"r","worker_id":"w"}),
            );
            if key == "calls" || key == "policies" {
                fixture.failure("apply", "call", &corrupt, call("d"));
            }
        }
    }
}

#[test]
fn missing_call_collection_fails_even_without_a_matching_policy() {
    let fixture = Fixture::new();
    let mut state = fixture.reserved_state();
    state["budget_admission"]["policies"] = json!({});
    let denied = fixture.success("apply", "call", &state, call("d"));
    assert_eq!(denied["result"]["reason"], "budget_policy_missing");
    state["budget_admission"]["calls"] = Value::Null;
    fixture.failure("apply", "call", &state, call("d"));
    state["budget_admission"]
        .as_object_mut()
        .unwrap()
        .remove("calls");
    fixture.failure("apply", "call", &state, call("d"));
}

#[test]
fn public_rejects_rows_that_the_js_projection_cannot_read() {
    let fixture = Fixture::new();
    let state = fixture.reserved_state();
    for bad in [Value::Null, json!(true), json!(2), json!("bad"), json!([])] {
        let mut corrupt = state.clone();
        corrupt["budget_admission"]["policies"]["p"] = bad;
        fixture.failure("public", "public", &corrupt, Value::Null);
    }
    for key in ["jobs", "calls"] {
        let mut corrupt = state.clone();
        corrupt["budget_admission"][key] = json!({"broken":null});
        fixture.failure("public", "public", &corrupt, Value::Null);
    }
    let mut corrupt = state;
    corrupt["budget_admission"]["policies"] = json!({"broken":null});
    fixture.failure(
        "apply",
        "job",
        &corrupt,
        json!({"job_id":"k","run_id":"r","worker_id":"w"}),
    );
}

#[test]
fn js_string_policy_ids_still_count_the_existing_reservation() {
    let fixture = Fixture::new();
    let mut state = fixture.reserved_state();
    state["budget_admission"]["calls"]["c"]["policy_ids"] = json!("p");
    let result = fixture.success("apply", "call", &state, call("d"));
    assert_eq!(result["result"]["reason"], "budget_hard_limit");
    let public = fixture.success("public", "public", &state, Value::Null);
    assert_eq!(public["budget_admission"]["policies"][0]["reserved"], "1");
    fixture.failure("apply", "policy", &state, policy_with(false));
}

#[test]
fn projection_only_books_keep_js_accepted_partial_collections() {
    let fixture = Fixture::new();
    for collection in [json!({}), json!([]), json!(false), json!(5), json!("")] {
        let state = json!({"budget_admission":{
            "policies":collection, "jobs":collection, "calls":collection,
        }});
        let result = fixture.success("public", "public", &state, Value::Null);
        assert_eq!(result["budget_admission"]["policies"], json!([]));
    }
    let state = json!({"budget_admission":{
        "policies":{}, "jobs":{"primitive":true}, "calls":{"primitive":true},
    }});
    fixture.success("public", "public", &state, Value::Null);
    let mut state = fixture.reserved_state();
    for key in ["policies", "jobs", "calls"] {
        let row = state["budget_admission"][key]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone();
        state["budget_admission"][key] = json!([row]);
    }
    let result = fixture.success("public", "public", &state, Value::Null);
    assert_eq!(result["budget_admission"]["policies"][0]["reserved"], "1");
}

#[test]
fn public_projection_distinguishes_missing_fields_from_null() {
    let fixture = Fixture::new();
    let state = json!({"budget_admission":{
        "policies":{},
        "jobs":{"missing":{},"null":{"closed_at":null},"false":{"closed_at":false}},
        "calls":{"missing":{},"null":{"amount":null},"zero":{"amount":"0"}},
    }});
    let result = fixture.success("public", "public", &state, Value::Null);
    assert_eq!(
        result["budget_admission"]["jobs"],
        json!([
            {"enforcement":"stopped"},
            {"closed_at":null,"enforcement":"unknown"},
            {"closed_at":false,"enforcement":"stopped"},
        ])
    );
    assert_eq!(
        result["budget_admission"]["calls"],
        json!([
            {"accounting":"source_reported"},
            {"amount":null,"accounting":"unconfirmed"},
            {"amount":"0","accounting":"source_reported"},
        ])
    );
}

#[test]
fn public_projection_keeps_primitive_and_array_rows() {
    let fixture = Fixture::new();
    for (row, spread) in [
        (json!(true), json!({})),
        (json!(false), json!({})),
        (json!(0), json!({})),
        (json!(2), json!({})),
        (json!("abc"), json!({"0":"a","1":"b","2":"c"})),
        (json!([]), json!({})),
        (json!([1]), json!({"0":1})),
        (
            json!([null,{"nested":true}]),
            json!({"0":null,"1":{"nested":true}}),
        ),
    ] {
        let state = json!({"budget_admission":{
            "policies":{},"jobs":{"j":row},"calls":{"c":row},
        }});
        let result = fixture.success("public", "public", &state, Value::Null);
        let mut job = spread.clone();
        job["enforcement"] = json!("stopped");
        let mut call = spread;
        call["accounting"] = json!("source_reported");
        assert_eq!(result["budget_admission"]["jobs"], json!([job]));
        assert_eq!(result["budget_admission"]["calls"], json!([call]));
    }
}

#[test]
fn public_projection_enumerates_string_collections_and_rejects_null_rows() {
    let fixture = Fixture::new();
    let state = json!({"budget_admission":{"policies":{},"jobs":"abc","calls":"xy"}});
    let result = fixture.success("public", "public", &state, Value::Null);
    assert_eq!(
        result["budget_admission"]["jobs"],
        json!([
            {"0":"a","enforcement":"stopped"},
            {"0":"b","enforcement":"stopped"},
            {"0":"c","enforcement":"stopped"},
        ])
    );
    assert_eq!(
        result["budget_admission"]["calls"],
        json!([
            {"0":"x","accounting":"source_reported"},
            {"0":"y","accounting":"source_reported"},
        ])
    );
    for key in ["jobs", "calls"] {
        let mut state = json!({"budget_admission":{"policies":{},"jobs":{},"calls":{}}});
        state["budget_admission"][key] = json!({"broken":null});
        fixture.failure("public", "public", &state, Value::Null);
    }
}

#[test]
fn active_policy_edits_do_not_scan_calls_that_js_short_circuits() {
    let fixture = Fixture::new();
    let mut state = fixture.reserved_state();
    state["budget_admission"]["calls"]["c"] = json!(true);
    fixture.success("apply", "policy", &state, policy_with(true));
}

#[test]
fn finish_checks_a_missing_call_before_validating_its_job_id() {
    let fixture = Fixture::new();
    let state = fixture.reserved_state();
    for (call_id, expected) in [
        ("missing", "budget_call_missing"),
        ("c", "budget_invalid_id"),
    ] {
        let error = fixture.failure(
            "apply",
            "finish",
            &state,
            json!({"call_id":call_id,"job_id":"bad/id","outcome":"finished","tokens":null}),
        );
        assert!(error.contains(expected), "{call_id}: {error}");
    }
    for (row, expected) in [
        (Value::Null, "budget_call_missing"),
        (json!(false), "budget_call_missing"),
        (json!(0), "budget_call_missing"),
        (json!(""), "budget_call_missing"),
        (json!(true), "budget_invalid_id"),
        (json!(2), "budget_invalid_id"),
        (json!("bad"), "budget_invalid_id"),
        (json!([]), "budget_invalid_id"),
        (json!([1]), "budget_invalid_id"),
    ] {
        let mut corrupt = state.clone();
        corrupt["budget_admission"]["calls"]["c"] = row;
        let error = fixture.failure(
            "apply",
            "finish",
            &corrupt,
            json!({"call_id":"c","job_id":"bad/id","outcome":"finished","tokens":null}),
        );
        assert!(error.contains(expected), "{corrupt}: {error}");
    }
}

fn policy_with(active: bool) -> Value {
    let mut input = policy();
    input["expected_revision"] = json!(1);
    input["active"] = json!(active);
    input
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-budget-shapes-{suffix}"));
        std::fs::create_dir_all(&root).unwrap();
        Self { root }
    }

    fn reserved_state(&self) -> Value {
        let mut state = json!({"project":{"id":"synthetic"}});
        for (operation, input) in [
            ("policy", policy()),
            ("job", json!({"job_id":"j","run_id":"r","worker_id":"w"})),
            ("ready", json!({"job_id":"j"})),
            ("call", call("c")),
        ] {
            state["budget_admission"] =
                self.success("apply", operation, &state, input)["budget_admission"].clone();
        }
        state
    }

    fn run(&self, action: &str, operation: &str, state: &Value, input: Value) -> Output {
        let file = self.root.join("request.json");
        let document = json!({"operation":operation,"state":state,"input":input,"now":NOW});
        std::fs::write(&file, document.to_string()).unwrap();
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(["--language", "en"])
            .args(["budget-admission", action, "--input-file"])
            .arg(&file)
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("APPDATA", self.root.join("appdata"))
            .env("LOCALAPPDATA", self.root.join("localappdata"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("DSH_HOME", self.root.join("dsh"))
            .env_remove("RDSH_ORIG_BIN")
            .env_remove("RDSH_PASSTHROUGH")
            .env_remove("RDSH_DRY_RUN")
            .env_remove("RDSH_DEFAULT_PROFILE")
            .output()
            .unwrap()
    }

    fn success(&self, action: &str, operation: &str, state: &Value, input: Value) -> Value {
        let output = self.run(action, operation, state, input);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn failure(&self, action: &str, operation: &str, state: &Value, input: Value) -> String {
        let output = self.run(action, operation, state, input);
        assert_eq!(
            output.status.code(),
            Some(1),
            "{operation}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("Budget admission:"));
        String::from_utf8(output.stderr).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
