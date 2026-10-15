use std::path::PathBuf;
use std::process::{Command, Output};

const NOW: &str = "2026-10-15T00:00:00Z";

#[test]
fn public_orders_numeric_policy_ids_like_javascript() {
    let fixture = Fixture::new();
    let state = serde_json::json!({
        "project": { "id": "p1" },
        "budget_admission": {
            "schema": 1,
            "project_id": "p1",
            "policies": {
                "10": policy("10", "0"),
                "2": policy("2", "0"),
            },
            "jobs": {},
            "calls": {},
            "receipts": {},
            "decisions": [],
            "operations": [],
        },
    });
    let output = fixture.run_json(&serde_json::json!({
        "operation": "public", "state": state, "now": NOW,
    }));
    let ids: Vec<&str> = output["budget_admission"]["policies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|policy| policy["policy_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["2", "10"]);
}

#[test]
fn public_omits_undefined_projection_fields_like_javascript() {
    let fixture = Fixture::new();
    let state = serde_json::json!({
        "budget_admission": {
            "schema": 1, "policies": {}, "jobs": {}, "calls": {},
            "receipts": {}, "operations": [],
        },
    });
    let output = fixture.run_json(&serde_json::json!({
        "operation": "public", "state": state, "now": NOW,
    }));
    let book = output["budget_admission"].as_object().unwrap();
    assert!(!book.contains_key("project_id"));
    assert!(!book.contains_key("decisions"));
}

#[test]
fn public_fails_closed_for_malformed_stored_amounts() {
    let fixture = Fixture::new();
    let mut cases = Vec::new();

    let mut bad_baseline = policy("p1", "0");
    bad_baseline["baseline"] = serde_json::json!("not-money");
    cases.push(("baseline", bad_baseline, serde_json::json!({})));

    let mut bad_reservation = policy("p1", "0");
    bad_reservation["call_reservation"] = serde_json::json!("not-money");
    cases.push(("call reservation", bad_reservation, serde_json::json!({})));

    let mut bad_limit = policy("p1", "0");
    bad_limit["hard_limit"] = serde_json::json!("not-money");
    cases.push(("hard limit", bad_limit, serde_json::json!({})));

    let bad_reservation = serde_json::json!({
        "call-1": {"policy_ids": ["p1"], "amount": null, "reservation": "not-money"}
    });
    cases.push((
        "stored call reservation",
        policy("p1", "0"),
        bad_reservation,
    ));

    let bad_call = serde_json::json!({
        "call-1": {"policy_ids": ["p1"], "amount": "not-money", "reservation": "0.3"}
    });
    cases.push(("call amount", policy("p1", "0"), bad_call.clone()));
    let mut unknown_spend = policy("p1", "0");
    unknown_spend["baseline"] = serde_json::Value::Null;
    cases.push(("call amount with unknown baseline", unknown_spend, bad_call));

    for (name, policy, calls) in cases {
        let state = serde_json::json!({
            "project": { "id": "p1" },
            "budget_admission": {
                "schema": 1, "project_id": "p1",
                "policies": { "p1": policy },
                "jobs": {}, "calls": calls,
                "receipts": {}, "decisions": [], "operations": [],
            },
        });
        let error = fixture.run_failure(&serde_json::json!({
            "operation": "public", "state": state, "now": NOW,
        }));
        assert!(error.contains("budget_invalid_amount"), "{name}: {error}");
    }
}

#[test]
fn public_rejects_malformed_policy_and_call_shapes() {
    let fixture = Fixture::new();
    let empty_book = || {
        serde_json::json!({
            "schema": 1, "project_id": "p1",
            "policies": { "p1": policy("p1", "0") },
            "jobs": {}, "calls": {}, "receipts": {},
            "decisions": [], "operations": [],
        })
    };
    let mut null_policies = empty_book();
    null_policies["policies"] = serde_json::Value::Null;
    let mut non_object_policy = empty_book();
    non_object_policy["policies"] = serde_json::json!({ "p1": true });
    let mut null_calls = empty_book();
    null_calls["calls"] = serde_json::Value::Null;
    let mut non_object_call = empty_book();
    non_object_call["calls"] = serde_json::json!({ "call-1": true });
    let mut missing_policy_ids = empty_book();
    missing_policy_ids["calls"] = serde_json::json!({
        "call-1": { "amount": null, "reservation": "1" }
    });
    let mut non_array_policy_ids = empty_book();
    non_array_policy_ids["calls"] = serde_json::json!({
        "call-1": { "policy_ids": null, "amount": null, "reservation": "1" }
    });

    for (name, book) in [
        ("null policies", null_policies),
        ("non-object policy", non_object_policy),
        ("null calls", null_calls),
        ("non-object call", non_object_call),
        ("missing policy_ids", missing_policy_ids),
        ("non-array policy_ids", non_array_policy_ids),
    ] {
        let error = fixture.run_failure(&serde_json::json!({
            "operation": "public",
            "state": { "project": { "id": "p1" }, "budget_admission": book },
            "now": NOW,
        }));
        assert!(error.contains("budget_invalid_store"), "{name}: {error}");
    }
}

#[test]
fn public_accepts_a_valid_state_larger_than_the_old_cli_cap() {
    let fixture = Fixture::new();
    let document = serde_json::json!({
        "operation": "public",
        "state": { "project": { "id": "p1" }, "unrelated": "x".repeat(300 * 1024) },
        "now": NOW,
    });
    let output = fixture.run_json(&document);
    assert_eq!(output["budget_admission"], serde_json::Value::Null);
}

fn policy(id: &str, baseline: &str) -> serde_json::Value {
    serde_json::json!({
        "policy_id": id, "revision": 1, "run_id": null,
        "period_start": "2026-10-01T00:00:00.000Z",
        "period_end": "2026-11-01T00:00:00.000Z",
        "currency": "USD", "source_kind": "provider_usage",
        "baseline": baseline, "baseline_basis": "Fixture",
        "soft_limit": "1", "hard_limit": "2", "call_reservation": "0.3",
        "paused": false, "active": true,
    })
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-budget-compat-{suffix}"));
        std::fs::create_dir_all(root.join("dsh")).unwrap();
        Self { root }
    }

    fn path(&self) -> String {
        self.root
            .join("request.json")
            .to_string_lossy()
            .into_owned()
    }

    fn run_json(&self, document: &serde_json::Value) -> serde_json::Value {
        std::fs::write(self.root.join("request.json"), document.to_string()).unwrap();
        let output = self.run();
        assert!(output.status.success(), "{}", output_text(&output));
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn run_failure(&self, document: &serde_json::Value) -> String {
        std::fs::write(self.root.join("request.json"), document.to_string()).unwrap();
        let output = self.run();
        assert_eq!(output.status.code(), Some(1), "{}", output_text(&output));
        assert!(output.stdout.is_empty(), "{}", output_text(&output));
        output_text(&output)
    }

    fn run(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args(["--language", "en"])
            .args(["budget-admission", "public", "--input-file", &self.path()])
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("APPDATA", self.root.join("appdata"))
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
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn output_text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}
