//! `rdsh cost-ledger` integration: the Rust module ports
//! `dashboard/cost-ledger.mjs`, so the CLI contract is checked on the real
//! binary — compact JSON on stdout, the JS error message on stderr, exit 1,
//! byte-identical output across runs, and no dependency on settings.
use std::path::PathBuf;
use std::process::{Command, Output};

/// A scope plus one report, the two operations both implementations accept.
const SCOPE: &str = r#"{
  "scope_id": "october-workers",
  "project_id": "project-1",
  "period_start": "2026-10-06T00:00:00Z",
  "period_end": "2026-10-07T00:00:00Z",
  "membership_complete": true,
  "targets": [
    { "target_id": "target-1", "worker_id": "worker-1",
      "session_id": "native-session-1", "run_id": "run-1",
      "provider": "fixture-provider", "model": "fixture-model" },
    { "target_id": "target-2", "worker_id": "worker-2",
      "session_id": "native-session-2", "run_id": "run-2",
      "provider": "fixture-provider", "model": "fixture-model" }
  ]
}"#;

const REPORT: &str = r#"{
  "event_id": "usage-1",
  "scope_id": "october-workers",
  "target_id": "target-1",
  "source_kind": "provider_usage",
  "source_ref": "fixture provider report / meter-1",
  "observed_at": "2026-10-06T01:00:00Z",
  "mode": "cumulative",
  "sequence": 1,
  "currency": "USD",
  "amount": "0.1",
  "certainty": "reported",
  "tokens": { "input": 10, "cached_input": 2, "output": 5 },
  "basis": "Fixture provider-reported amount; 外部明細との突合なし"
}"#;

/// Exact `JSON.stringify` of the JS `publicCostLedger` projection for the
/// fixture above, with the two non-deterministic stamps elided.
const EXPECTED_PUBLIC: &str = concat!(
    r#"{"operation":"public","cost_ledger":{"schema":1,"project_id":"project-1","scopes":["#,
    r#"{"scope_id":"october-workers","project_id":"project-1","#,
    r#""period_start":"2026-10-06T00:00:00.000Z","period_end":"2026-10-07T00:00:00.000Z","#,
    r#""membership_complete":true,"targets":["#,
    r#"{"target_id":"target-1","worker_id":"worker-1","session_id":"native-session-1","#,
    r#""run_id":"run-1","provider":"fixture-provider","model":"fixture-model"},"#,
    r#"{"target_id":"target-2","worker_id":"worker-2","session_id":"native-session-2","#,
    r#""run_id":"run-2","provider":"fixture-provider","model":"fixture-model"}],"#,
    r#""declared_at":"STAMP","groups":[{"source_kind":"provider_usage","currency":"USD","#,
    r#""level":"targets","amount":"0.1","certainty":"reported","partial":true,"#,
    r#""missing_targets":["target-2"],"covered_targets":["target-1"],"included_reports":1,"#,
    r#""observed_at":"2026-10-06T01:00:00.000Z","tokens":{"input":{"value":"10","partial":true},"#,
    r#""cached_input":{"value":"2","partial":true},"output":{"value":"5","partial":true}}}],"#,
    r#""unreported_sources":["cli_report","api_estimate","invoice_actual"],"reports":["#,
    r#"{"event_id":"usage-1","scope_id":"october-workers","target_id":"target-1","#,
    r#""source_kind":"provider_usage","source_ref":"fixture provider report / meter-1","#,
    r#""observed_at":"2026-10-06T01:00:00.000Z","mode":"cumulative","sequence":1,"#,
    r#""currency":"USD","amount":"0.1","certainty":"reported","#,
    r#""tokens":{"input":10,"cached_input":2,"output":5},"#,
    r#""basis":"Fixture provider-reported amount; 外部明細との突合なし","#,
    r#""received_at":"STAMP","included":true}]}]}}"#,
);

#[test]
fn declare_prints_the_js_json_shape() {
    let fixture = Fixture::new();
    let document = format!(
        r#"{{"operation":"declare","state":{{"schema":1,"project":{{"id":"project-1"}}}},"input":{SCOPE}}}"#
    );
    let result = fixture.run_json(&document);
    assert_eq!(result["operation"], "declare");
    assert_eq!(result["declared"], true);
    let stored = &result["cost_ledger"]["scopes"]["october-workers"];
    assert_eq!(stored["scope_id"], "october-workers");
    assert_eq!(stored["period_start"], "2026-10-06T00:00:00.000Z");
    assert_eq!(stored["membership_complete"], true);
    assert_eq!(stored["targets"][0]["target_id"], "target-1");
    assert_eq!(stored["targets"][0]["run_id"], "run-1");
    assert!(stored["declared_at"].as_str().unwrap().ends_with('Z'));
    // The stored scope key order is the JS spread order.
    let keys: Vec<&String> = stored.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "scope_id",
            "project_id",
            "period_start",
            "period_end",
            "membership_complete",
            "targets",
            "declared_at"
        ]
    );
}

#[test]
fn report_records_and_public_projects_the_js_payload() {
    let fixture = Fixture::new();
    let recorded = fixture.run_json(&fixture.recorded_document());
    assert_eq!(recorded["recorded"], true);
    let report = &recorded["cost_ledger"]["reports"]["usage-1"];
    assert_eq!(report["amount"], "0.1");
    assert_eq!(report["observed_at"], "2026-10-06T01:00:00.000Z");
    assert_eq!(report["tokens"]["input"], 10);
    // Report key order is `reportKeys` order from the JS module.
    let keys: Vec<&String> = report.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "event_id",
            "scope_id",
            "target_id",
            "source_kind",
            "source_ref",
            "observed_at",
            "mode",
            "sequence",
            "currency",
            "amount",
            "certainty",
            "tokens",
            "basis",
            "received_at"
        ]
    );

    let public = fixture.run_json(&fixture.public_document());
    let text = serde_json::to_string(&public).unwrap();
    assert_eq!(public["operation"], "public");
    // Compare the whole payload with the stamps normalised: this is the exact
    // byte shape the JS `publicCostLedger` produced.
    assert_eq!(normalise_stamps(&text), EXPECTED_PUBLIC);
}

#[test]
fn public_is_byte_identical_across_runs() {
    let fixture = Fixture::new();
    let document = fixture.public_document();
    let args = [
        "cost-ledger",
        "public",
        "--input-file",
        &fixture.path("r.json"),
    ];
    fixture.write("r.json", &document);
    let first = fixture.run(&args);
    fixture.write("r.json", &document);
    let second = fixture.run(&args);
    assert!(first.status.success() && second.status.success());
    // `declared_at` is stamped at declare time and carried in the document, so
    // the two runs must agree exactly.
    assert_eq!(stdout(&first), stdout(&second));
}

#[test]
fn report_is_idempotent_and_rejects_a_conflicting_event() {
    let fixture = Fixture::new();
    let first = fixture.run_json(&fixture.recorded_document());
    let stored = serde_json::to_string(&first["cost_ledger"]).unwrap();
    // Re-recording the identical report is a no-op.
    let again = format!(
        r#"{{"operation":"report","state":{{"schema":1,"project":{{"id":"project-1"}},"cost_ledger":{stored}}},"input":{REPORT}}}"#
    );
    let second = fixture.run_json(&again);
    assert_eq!(second["cost_ledger"], first["cost_ledger"]);
    // The same event ID with different data is refused.
    let forged = REPORT.replace("\"0.1\"", "\"9\"");
    let changed = format!(
        r#"{{"operation":"report","state":{{"schema":1,"project":{{"id":"project-1"}},"cost_ledger":{stored}}},"input":{forged}}}"#
    );
    fixture.write("changed.json", &changed);
    let refused = fixture.run(&[
        "cost-ledger",
        "report",
        "--input-file",
        &fixture.path("changed.json"),
    ]);
    assert_eq!(
        refused.status.code(),
        Some(1),
        "{}",
        public_output(&refused)
    );
    assert!(
        public_output(&refused).contains("Cost ledger: event ID already refers to different data"),
        "{}",
        public_output(&refused)
    );
}

#[test]
fn commands_reject_the_js_error_cases_verbatim() {
    let fixture = Fixture::new();
    // Each case patches one field of the fixture and requires the exact JS
    // message, so the port cannot drift into a different refusal.
    let scope_cases: [(&str, serde_json::Value, &str); 4] = [
        (
            "project_id",
            serde_json::json!("other"),
            "scope belongs to another project",
        ),
        (
            "period_end",
            serde_json::json!("2026-10-05T00:00:00Z"),
            "period must have a positive duration",
        ),
        (
            "membership_complete",
            serde_json::json!("true"),
            "membership_complete must be explicit",
        ),
        (
            "scope_id",
            serde_json::json!("__proto__"),
            "invalid identifier",
        ),
    ];
    for (key, value, message) in scope_cases {
        let mut input: serde_json::Value = serde_json::from_str(SCOPE).unwrap();
        input[key] = value;
        let document = serde_json::json!({
            "operation": "declare",
            "state": { "schema": 1, "project": { "id": "project-1" } },
            "input": input,
        });
        fixture.write("case.json", &document.to_string());
        let output = fixture.run(&[
            "cost-ledger",
            "declare",
            "--input-file",
            &fixture.path("case.json"),
        ]);
        assert_eq!(output.status.code(), Some(1), "{}", public_output(&output));
        assert!(stdout(&output).is_empty(), "{}", public_output(&output));
        assert!(
            public_output(&output).contains(&format!("Cost ledger: {message}")),
            "expected {message} in {}",
            public_output(&output)
        );
    }

    // The report cases need the scope already declared, so the state carries
    // the ledger the declare run produced.
    let declared = fixture.declared_ledger();
    let report_cases: [(&str, serde_json::Value, &str); 8] = [
        (
            "source_kind",
            serde_json::json!("guessed"),
            "unknown source kind",
        ),
        (
            "target_id",
            serde_json::json!("missing"),
            "unknown target; only an unallocated invoice may use null",
        ),
        (
            "currency",
            serde_json::json!("usd"),
            "currency must be an explicit three-letter code",
        ),
        (
            "amount",
            serde_json::json!("01"),
            "amount must be a nonnegative decimal string with at most 9 fractional digits",
        ),
        (
            "certainty",
            serde_json::json!("confirmed"),
            "certainty must match the amount and source",
        ),
        ("mode", serde_json::json!("snapshot"), "invalid report mode"),
        (
            "sequence",
            serde_json::json!(0),
            "positive stable sequence required",
        ),
        (
            "observed_at",
            serde_json::json!("2026-10-05T23:00:00Z"),
            "observation precedes its period",
        ),
    ];
    for (key, value, message) in report_cases {
        let mut input: serde_json::Value = serde_json::from_str(REPORT).unwrap();
        input[key] = value;
        let document = serde_json::json!({
            "operation": "report",
            "state": {
                "schema": 1,
                "project": { "id": "project-1" },
                "cost_ledger": declared.clone(),
            },
            "input": input,
        });
        fixture.write("case.json", &document.to_string());
        let output = fixture.run(&[
            "cost-ledger",
            "report",
            "--input-file",
            &fixture.path("case.json"),
        ]);
        assert_eq!(output.status.code(), Some(1), "{}", public_output(&output));
        assert!(stdout(&output).is_empty(), "{}", public_output(&output));
        assert!(
            public_output(&output).contains(&format!("Cost ledger: {message}")),
            "expected {message} in {}",
            public_output(&output)
        );
    }
}

#[test]
fn report_rejects_a_decreased_cumulative_counter() {
    let fixture = Fixture::new();
    // Store the first cumulative snapshot, then offer a smaller one.
    let first = fixture.run_json(&fixture.recorded_document());
    let ledger = serde_json::to_string(&first["cost_ledger"]).unwrap();
    let mut decreased: serde_json::Value = serde_json::from_str(REPORT).unwrap();
    decreased["event_id"] = serde_json::json!("usage-2");
    decreased["amount"] = serde_json::json!("0.01");
    decreased["sequence"] = serde_json::json!(2);
    decreased["observed_at"] = serde_json::json!("2026-10-06T02:00:00Z");
    let document = serde_json::json!({
        "operation": "report",
        "state": { "schema": 1, "project": { "id": "project-1" }, "cost_ledger": first["cost_ledger"].clone() },
        "input": decreased,
    });
    let _ = ledger;
    fixture.write("decreased.json", &document.to_string());
    let output = fixture.run(&[
        "cost-ledger",
        "report",
        "--input-file",
        &fixture.path("decreased.json"),
    ]);
    assert_eq!(output.status.code(), Some(1), "{}", public_output(&output));
    assert!(
        public_output(&output).contains("cumulative counter decreased"),
        "{}",
        public_output(&output)
    );
}

#[test]
fn validate_accepts_and_rejects_like_the_js_module() {
    let fixture = Fixture::new();
    let ok = fixture
        .run_json(r#"{"operation":"validate","state":{"schema":1,"project":{"id":"project-1"}}}"#);
    assert_eq!(ok["valid"], true);
    let recorded = fixture.run_json(&fixture.recorded_document());
    let stored = serde_json::to_string(&recorded["cost_ledger"]).unwrap();
    let valid = fixture.run_json(&format!(
        r#"{{"operation":"validate","state":{{"schema":1,"project":{{"id":"project-1"}},"cost_ledger":{stored}}}}}"#
    ));
    assert_eq!(valid["valid"], true);
    // A tampered stored amount is refused with the inner message.
    let tampered = stored.replace("\"amount\":\"0.1\"", "\"amount\":\"-5\"");
    fixture.write(
        "tampered.json",
        &format!(
            r#"{{"operation":"validate","state":{{"schema":1,"project":{{"id":"project-1"}},"cost_ledger":{tampered}}}}}"#
        ),
    );
    let output = fixture.run(&[
        "cost-ledger",
        "validate",
        "--input-file",
        &fixture.path("tampered.json"),
    ]);
    assert_eq!(output.status.code(), Some(1), "{}", public_output(&output));
    assert!(
        public_output(&output).contains("Cost ledger: amount must be a nonnegative decimal string"),
        "{}",
        public_output(&output)
    );
    // A stored `null` ledger is a shape error, not a missing document.
    fixture.write(
        "null.json",
        r#"{"operation":"validate","state":{"schema":1,"project":{"id":"project-1"},"cost_ledger":null}}"#,
    );
    let null_ledger = fixture.run(&[
        "cost-ledger",
        "validate",
        "--input-file",
        &fixture.path("null.json"),
    ]);
    assert_eq!(null_ledger.status.code(), Some(1));
    assert!(
        public_output(&null_ledger).contains("Cost ledger: unexpected or missing fields"),
        "{}",
        public_output(&null_ledger)
    );
}

#[test]
fn schema_prints_the_advertised_js_schemas() {
    let fixture = Fixture::new();
    let result = fixture
        .run_json(r#"{"operation":"schema","state":{"schema":1,"project":{"id":"project-1"}}}"#);
    let scope = &result["cost_scope"];
    assert_eq!(scope["type"], "object");
    assert_eq!(scope["additionalProperties"], false);
    let keys: Vec<&String> = scope["properties"].as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "scope_id",
            "project_id",
            "period_start",
            "period_end",
            "membership_complete",
            "targets"
        ]
    );
    assert_eq!(scope["properties"]["period_start"]["format"], "date-time");
    assert_eq!(scope["properties"]["targets"]["maxItems"], 100);
    let target = &scope["properties"]["targets"]["items"];
    assert_eq!(target["additionalProperties"], false);
    assert_eq!(
        target["properties"]["run_id"]["type"],
        serde_json::json!(["string", "null"])
    );

    let report = &result["cost_report"];
    assert_eq!(
        report["properties"]["source_kind"]["enum"],
        serde_json::json!([
            "provider_usage",
            "cli_report",
            "api_estimate",
            "invoice_actual"
        ])
    );
    assert_eq!(
        report["properties"]["mode"]["enum"],
        serde_json::json!(["event", "cumulative"])
    );
    assert_eq!(
        report["properties"]["sequence"]["maximum"],
        9007199254740991i64
    );
    assert_eq!(
        report["properties"]["amount"]["pattern"],
        "^(?:0|[1-9]\\d{0,15})(?:\\.\\d{1,9})?$"
    );
    assert_eq!(
        report["properties"]["certainty"]["enum"],
        serde_json::json!(["unknown", "reported", "estimated", "confirmed"])
    );
    // `tokens` re-wraps the object schema with a nullable type.
    let tokens = &report["properties"]["tokens"];
    assert_eq!(tokens["type"], serde_json::json!(["object", "null"]));
    assert_eq!(tokens["additionalProperties"], false);
    assert_eq!(
        tokens["required"],
        serde_json::json!(["input", "cached_input", "output"])
    );
    assert_eq!(
        tokens["properties"]["input"]["maximum"],
        9007199254740991i64
    );
    // The sequence maximum must print as an integer, never as `...991.0`.
    assert!(!serde_json::to_string(report).unwrap().contains(".0"));
}

#[test]
fn commands_refuse_unreadable_invalid_and_mismatched_input() {
    let fixture = Fixture::new();
    fixture.write("invalid.json", "{ not json");
    let invalid = fixture.run(&[
        "cost-ledger",
        "public",
        "--input-file",
        &fixture.path("invalid.json"),
    ]);
    assert!(!invalid.status.success());
    assert!(
        public_output(&invalid).contains("Input JSON is invalid"),
        "{}",
        public_output(&invalid)
    );
    let missing = fixture.run(&[
        "cost-ledger",
        "public",
        "--input-file",
        &fixture.path("missing.json"),
    ]);
    assert!(!missing.status.success());
    assert!(
        public_output(&missing).contains("cannot read JSON"),
        "{}",
        public_output(&missing)
    );
    let oversized = fixture.path("oversized.json");
    std::fs::write(&oversized, vec![b' '; 300 * 1024]).unwrap();
    let huge = fixture.run(&["cost-ledger", "public", "--input-file", &oversized]);
    assert!(!huge.status.success());
    assert!(
        public_output(&huge).contains("at most 256 KiB"),
        "{}",
        public_output(&huge)
    );
    // The declared operation must match the requested action.
    fixture.write(
        "mismatch.json",
        r#"{"operation":"validate","state":{"schema":1,"project":{"id":"project-1"}}}"#,
    );
    let mismatch = fixture.run(&[
        "cost-ledger",
        "public",
        "--input-file",
        &fixture.path("mismatch.json"),
    ]);
    assert!(!mismatch.status.success());
    assert!(
        public_output(&mismatch).contains("operation does not match"),
        "{}",
        public_output(&mismatch)
    );
    // An unknown action is refused.
    let unknown = fixture.run(&[
        "cost-ledger",
        "inspect",
        "--input-file",
        &fixture.path("mismatch.json"),
    ]);
    assert!(!unknown.status.success());
}

#[test]
fn commands_accept_a_utf8_bom_like_the_dashboard_cli() {
    let fixture = Fixture::new();
    fixture.write(
        "bom.json",
        &format!("\u{feff}{}", fixture.recorded_document()),
    );
    let output = fixture.run(&[
        "cost-ledger",
        "report",
        "--input-file",
        &fixture.path("bom.json"),
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    assert!(stdout(&output).contains("\"recorded\":true"));
}

#[test]
fn commands_require_the_input_file_option() {
    let fixture = Fixture::new();
    let output = fixture.run(&["cost-ledger", "public"]);
    assert!(!output.status.success());
    assert!(
        public_output(&output).contains("--input-file"),
        "{}",
        public_output(&output)
    );
}

#[test]
fn commands_ignore_unrelated_corrupt_settings_without_replacing_them() {
    // The pure validator must not fail closed on an unreadable settings file.
    let fixture = Fixture::new();
    fixture.write("request.json", &fixture.recorded_document());
    fixture.write("dsh/rdsh.json", "{broken");
    let output = fixture.run(&[
        "cost-ledger",
        "report",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    assert_eq!(
        std::fs::read_to_string(fixture.path("dsh/rdsh.json")).unwrap(),
        "{broken"
    );
}

/// Replace each `"<key>":"<iso timestamp>"` value with a placeholder, so the
/// two call-time stamps do not defeat the byte comparison.
fn normalise_stamps(text: &str) -> String {
    let mut text = text.to_string();
    for key in ["declared_at", "received_at"] {
        let needle = format!("\"{key}\":\"");
        let mut search = 0;
        while let Some(offset) = text[search..].find(&needle) {
            let value_start = search + offset + needle.len();
            let Some(close) = text[value_start..].find('"') else {
                break;
            };
            text.replace_range(value_start..value_start + close, "STAMP");
            // Continue after the placeholder: searching from the start again
            // would find the same key and replace `STAMP` with itself forever.
            search = value_start + "STAMP".len();
        }
    }
    text
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-cost-{suffix}"));
        std::fs::create_dir_all(root.join("dsh")).unwrap();
        Self { root }
    }

    fn path(&self, name: &str) -> String {
        self.root.join(name).to_string_lossy().into_owned()
    }

    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.root.join(name), text).unwrap();
    }

    /// Declare the fixture scope and return the stored ledger as a `Value`.
    fn declared_ledger(&self) -> serde_json::Value {
        let document = format!(
            r#"{{"operation":"declare","state":{{"schema":1,"project":{{"id":"project-1"}}}},"input":{SCOPE}}}"#
        );
        self.run_json(&document)["cost_ledger"].clone()
    }

    /// `{ operation: "report", state, input }` with the scope already declared.
    fn recorded_document(&self) -> String {
        let ledger = serde_json::to_string(&self.declared_ledger()).unwrap();
        format!(
            r#"{{"operation":"report","state":{{"schema":1,"project":{{"id":"project-1"}},"cost_ledger":{ledger}}},"input":{REPORT}}}"#
        )
    }

    /// `{ operation: "public", state }` with the scope and one report stored.
    fn public_document(&self) -> String {
        let recorded = self.recorded_document();
        let result = self.run_json(&recorded);
        let ledger = serde_json::to_string(&result["cost_ledger"]).unwrap();
        format!(
            r#"{{"operation":"public","state":{{"schema":1,"project":{{"id":"project-1"}},"cost_ledger":{ledger}}}}}"#
        )
    }

    /// Run an inline document and parse the stdout.
    fn run_json(&self, document: &str) -> serde_json::Value {
        self.write("inline.json", document);
        let operation = serde_json::from_str::<serde_json::Value>(document)
            .expect("fixture documents are JSON")["operation"]
            .as_str()
            .expect("fixture documents declare an operation")
            .to_string();
        let output = self.run(&[
            "cost-ledger",
            &operation,
            "--input-file",
            &self.path("inline.json"),
        ]);
        assert!(output.status.success(), "{}", public_output(&output));
        serde_json::from_str(&stdout(&output)).expect("stdout is JSON")
    }

    fn run(&self, args: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rdsh"));
        command
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("APPDATA", self.root.join("appdata"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("DSH_HOME", self.root.join("dsh"))
            .env_remove("RDSH_ORIG_BIN")
            .env_remove("RDSH_PASSTHROUGH")
            .env_remove("RDSH_DRY_RUN")
            .env_remove("RDSH_DEFAULT_PROFILE");
        command.args(args).output().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn public_output(output: &Output) -> String {
    format!(
        "{}{}",
        stdout(output),
        String::from_utf8_lossy(&output.stderr)
    )
}
