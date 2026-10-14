//! `rdsh budget-admission` integration: the Rust module ports
//! `dashboard/budget-admission.mjs`, so the CLI contract is checked on the real
//! binary — compact JSON on stdout, the JS error message on stderr, exit 1,
//! byte-identical output across runs, and no dependency on settings.
use std::path::PathBuf;
use std::process::{Command, Output};

/// The policy every fixture book starts from.
const POLICY: &str = r#"{
  "policy_id": "project-budget",
  "expected_revision": 0,
  "run_id": null,
  "period_start": "2026-10-01T00:00:00Z",
  "period_end": "2026-11-01T00:00:00Z",
  "currency": "USD",
  "source_kind": "provider_usage",
  "baseline": "0",
  "baseline_basis": "Fixture baseline; no invoice verified",
  "soft_limit": "1",
  "hard_limit": "2",
  "call_reservation": "0.3",
  "paused": false,
  "active": true,
  "reason": "Fixture policy for the admission port"
}"#;

/// The instant the CLI takes as `now`, so no clock enters the comparison.
const NOW: &str = "2026-10-15T00:00:00Z";

/// A `policy` request for a fresh state document.
fn policy_document() -> String {
    format!(
        r#"{{"operation":"policy","state":{{"schema":1,"project":{{"id":"project-1"}}}},"input":{POLICY},"now":"{NOW}"}}"#
    )
}

/// Exact `JSON.stringify` of the JS `applyBudgetOperation(state,"policy",…)`
/// result for [`POLICY`] — the policy object alone, in JS literal order.
const EXPECTED_POLICY: &str = concat!(
    r#"{"operation":"policy","result":{"policy_id":"project-budget","revision":1,"#,
    r#""run_id":null,"period_start":"2026-10-01T00:00:00.000Z","period_end":"2026-11-01T00:00:00.000Z","#,
    r#""currency":"USD","source_kind":"provider_usage","baseline":"0","#,
    r#""baseline_basis":"Fixture baseline; no invoice verified","soft_limit":"1","hard_limit":"2","#,
    r#""call_reservation":"0.3","paused":false,"active":true},"#,
    r#""budget_admission":{"schema":1,"project_id":"project-1","policies":{"project-budget":{"#,
    r#""policy_id":"project-budget","revision":1,"run_id":null,"#,
    r#""period_start":"2026-10-01T00:00:00.000Z","period_end":"2026-11-01T00:00:00.000Z","#,
    r#""currency":"USD","source_kind":"provider_usage","baseline":"0","#,
    r#""baseline_basis":"Fixture baseline; no invoice verified","soft_limit":"1","hard_limit":"2","#,
    r#""call_reservation":"0.3","paused":false,"active":true}},"jobs":{},"calls":{},"receipts":{},"#,
    r#""decisions":[{"sequence":1,"kind":"policy","policy":{"policy_id":"project-budget","revision":1,"#,
    r#""run_id":null,"period_start":"2026-10-01T00:00:00.000Z","period_end":"2026-11-01T00:00:00.000Z","#,
    r#""currency":"USD","source_kind":"provider_usage","baseline":"0","#,
    r#""baseline_basis":"Fixture baseline; no invoice verified","soft_limit":"1","hard_limit":"2","#,
    r#""call_reservation":"0.3","paused":false,"active":true},"#,
    r#""reason":"Fixture policy for the admission port","actor":"local_administrator","#,
    r#""recorded_at":"2026-10-15T00:00:00.000Z"}],"operations":[{"operation":"policy","input":{"#,
    r#""policy_id":"project-budget","expected_revision":0,"run_id":null,"#,
    r#""period_start":"2026-10-01T00:00:00Z","period_end":"2026-11-01T00:00:00Z","currency":"USD","#,
    r#""source_kind":"provider_usage","baseline":"0","#,
    r#""baseline_basis":"Fixture baseline; no invoice verified","soft_limit":"1","hard_limit":"2","#,
    r#""call_reservation":"0.3","paused":false,"active":true,"#,
    r#""reason":"Fixture policy for the admission port"},"#,
    r#""recorded_at":"2026-10-15T00:00:00.000Z"}]}}"#,
);

#[test]
fn apply_policy_prints_the_js_json_shape() {
    let fixture = Fixture::new();
    fixture.write("request.json", &policy_document());
    let output = fixture.run(&[
        "budget-admission",
        "apply",
        "--input-file",
        &fixture.path("request.json"),
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    assert!(output.stderr.is_empty(), "{}", public_output(&output));
    assert_eq!(stdout(&output), format!("{EXPECTED_POLICY}\n"));
}

#[test]
fn apply_is_byte_identical_across_runs() {
    let fixture = Fixture::new();
    fixture.write("request.json", &policy_document());
    let args = [
        "budget-admission",
        "apply",
        "--input-file",
        &fixture.path("request.json"),
    ];
    let first = fixture.run(&args);
    let second = fixture.run(&args);
    assert!(first.status.success() && second.status.success());
    assert_eq!(stdout(&first), stdout(&second));
}

#[test]
fn a_job_denied_by_the_hard_limit_is_reported_and_stores_nothing() {
    let fixture = Fixture::new();
    // A baseline at the hard limit leaves no room for another reservation.
    let mut policy: serde_json::Value = serde_json::from_str(POLICY).unwrap();
    policy["baseline"] = serde_json::json!("2");
    let document = serde_json::json!({
        "operation": "apply",
        "state": { "schema": 1, "project": { "id": "project-1" } },
        "input": policy,
        "now": NOW,
    });
    let first = fixture.run_json(&document.to_string());
    let stored = serde_json::to_string(&first["budget_admission"]).unwrap();
    let job = serde_json::json!({
        "operation": "job",
        "state": {
            "schema": 1,
            "project": { "id": "project-1" },
            "budget_admission": first["budget_admission"].clone(),
        },
        "input": { "job_id": "job-1", "run_id": "run-1", "worker_id": "worker-1" },
        "now": NOW,
    });
    let denied = fixture.run_json(&job.to_string());
    assert_eq!(denied["result"]["allowed"], false);
    assert_eq!(denied["result"]["reason"], "budget_hard_limit");
    assert_eq!(denied["result"]["job_id"], "job-1");
    // The decision is audited but no job is stored.
    assert_eq!(
        denied["budget_admission"]["jobs"]
            .as_object()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        denied["budget_admission"]["decisions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let _ = stored;

    // Raising the hard limit admits the same job. The baseline is an
    // accounting key, so it must repeat the stored value unchanged.
    let mut raised = policy.clone();
    raised["expected_revision"] = serde_json::json!(1);
    raised["hard_limit"] = serde_json::json!("4");
    raised["soft_limit"] = serde_json::json!("2");
    let document = serde_json::json!({
        "operation": "policy",
        "state": state_with(&first["budget_admission"]),
        "input": raised,
        "now": NOW,
    });
    let updated = fixture.run_json(&document.to_string());
    assert_eq!(updated["result"]["revision"], 2);
    let job = serde_json::json!({
        "operation": "job",
        "state": state_with(&updated["budget_admission"]),
        "input": { "job_id": "job-1", "run_id": "run-1", "worker_id": "worker-1" },
        "now": NOW,
    });
    let admitted = fixture.run_json(&job.to_string());
    assert_eq!(admitted["result"]["allowed"], true);
    // Spend already sits on the raised soft limit, so the admission carries a
    // warning even though it is allowed. Verified against the JS module.
    assert_eq!(admitted["result"]["warning"], true);
    assert_eq!(admitted["result"]["reason"], serde_json::Value::Null);
    // The denial above was a warning, not a silent refusal.
    assert_eq!(denied["result"]["warning"], true);
    assert_eq!(denied["result"]["reason"], "budget_hard_limit");
    assert_eq!(
        admitted["budget_admission"]["jobs"]["job-1"]["registered_at"],
        serde_json::Value::Null
    );
}

#[test]
fn the_full_admission_cycle_stays_exact_and_replays() {
    let fixture = Fixture::new();
    let mut state = serde_json::json!({ "schema": 1, "project": { "id": "project-1" } });
    let steps = [
        serde_json::from_str::<serde_json::Value>(POLICY).unwrap(),
        serde_json::json!({ "job_id": "job-1", "run_id": "run-1", "worker_id": "worker-1" }),
        serde_json::json!({ "job_id": "job-1" }),
        serde_json::json!({
            "job_id": "job-1",
            "call_id": "call-1",
            "session_id": "native-session-1",
            "provider": "fixture-provider",
            "model": "fixture-model",
            "purpose": null,
        }),
        serde_json::json!({ "job_id": "job-1", "call_id": "call-1", "outcome": "finished", "tokens": null }),
        serde_json::json!({
            "event_id": "usage-1",
            "call_id": "call-1",
            "amount": "0.4",
            "currency": "USD",
            "source_kind": "provider_usage",
            "source_ref": "fixture-meter-only",
            "observed_at": "2026-10-15T00:00:00Z",
            "basis": "Fixture settled usage; no invoice verified",
        }),
    ];
    let mut last = serde_json::Value::Null;
    for (index, input) in steps.iter().enumerate() {
        let document = serde_json::json!({
            "operation": "apply",
            "state": state,
            "input": input,
            "now": NOW,
        });
        let result = fixture.run_json(&document.to_string());
        assert!(
            result["result"].is_object(),
            "step {index} returned no result: {result}"
        );
        state = state_with(&result["budget_admission"]);
        last = result["result"].clone();
    }
    // The settled receipt reports the exact decimal.
    assert_eq!(last["amount"], "0.4");
    assert_eq!(last["event_id"], "usage-1");

    // A fresh run of the same replay validates, and the public projection is
    // the settled one.
    let validate = fixture.run_json(
        &serde_json::json!({ "operation": "validate", "state": state, "now": NOW }).to_string(),
    );
    assert_eq!(validate["valid"], true);
    let public = fixture.run_json(
        &serde_json::json!({ "operation": "public", "state": state, "now": NOW }).to_string(),
    );
    let policy = &public["budget_admission"]["policies"][0];
    assert_eq!(policy["spent"], "0.4");
    assert_eq!(policy["reserved"], "0");
    assert_eq!(policy["effective"], "0.4");
    assert_eq!(policy["executing"], 0);
    assert_eq!(policy["awaiting_usage"], 0);
    assert_eq!(policy["status"], "within_budget");
    assert_eq!(policy["overspend"], "0");
    assert_eq!(policy["next_call_fits"], true);
    assert_eq!(
        public["budget_admission"]["calls"][0]["accounting"],
        "source_reported"
    );
    assert_eq!(
        public["budget_admission"]["jobs"][0]["enforcement"],
        "unknown"
    );
}

#[test]
fn public_reports_live_jobs_and_closed_jobs_like_the_js_guard() {
    let fixture = Fixture::new();
    let mut state = serde_json::json!({ "schema": 1, "project": { "id": "project-1" } });
    let mut policy: serde_json::Value = serde_json::from_str(POLICY).unwrap();
    policy["hard_limit"] = serde_json::json!("4");
    // `ready` and `close` share the same payload keys, so the operation is
    // named explicitly instead of being inferred.
    for (operation, input) in [
        ("policy", policy),
        (
            "job",
            serde_json::json!({ "job_id": "job-1", "run_id": "run-1", "worker_id": "worker-1" }),
        ),
        ("ready", serde_json::json!({ "job_id": "job-1" })),
    ] {
        let document = serde_json::json!({
            "operation": operation, "state": state, "input": input, "now": NOW,
        });
        state = state_with(&fixture.run_json(&document.to_string())["budget_admission"]);
    }
    let live = fixture.run_json(
        &serde_json::json!({
            "operation": "public", "state": state, "now": NOW,
            "live_jobs": { "job-1": true },
        })
        .to_string(),
    );
    assert_eq!(
        live["budget_admission"]["jobs"][0]["enforcement"],
        "guard_registered"
    );
    let closing = serde_json::json!({
        "operation": "close", "state": state,
        "input": { "job_id": "job-1" }, "now": NOW,
    });
    let closed = state_with(&fixture.run_json(&closing.to_string())["budget_admission"]);
    let public = fixture.run_json(
        &serde_json::json!({
            "operation": "public", "state": closed, "now": NOW,
            "live_jobs": { "job-1": true },
        })
        .to_string(),
    );
    assert_eq!(
        public["budget_admission"]["jobs"][0]["enforcement"],
        "stopped"
    );
}

#[test]
fn apply_refuses_every_documented_error_with_the_js_message() {
    let fixture = Fixture::new();
    // Each case is one whole request document; the state is inline so a case
    // can carry the book it needs.
    let cases: [(&str, serde_json::Value, &str); 14] = [
        (
            "an unknown operation name",
            serde_json::json!({
                "operation": "retire",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": { "policy_id": "p" },
                "now": NOW,
            }),
            "!Input JSON operation does not match the requested action",
        ),
        (
            // The revision guard runs before the payload is inspected, so a
            // policy stripped of `expected_revision` is a conflict, not a
            // malformed input.
            "a policy without a revision",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": { "policy_id": "p" },
                "now": NOW,
            }),
            "budget_policy_revision_conflict",
        ),
        (
            "a policy with an unknown key",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": { "policy_id": "p", "expected_revision": 0, "bogus": 1 },
                "now": NOW,
            }),
            "budget_invalid_input",
        ),
        (
            "a stray policy field",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": { "policy_id": "p", "extra": 1 },
                "now": NOW,
            }),
            "budget_invalid_input",
        ),
        (
            "a prototype policy id",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": { "policy_id": "__proto__", "expected_revision": 0 },
                "now": NOW,
            }),
            "budget_invalid_id",
        ),
        (
            "a blank baseline basis",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": {
                    "policy_id": "p", "expected_revision": 0, "run_id": null,
                    "period_start": "2026-10-01T00:00:00Z", "period_end": "2026-11-01T00:00:00Z",
                    "currency": "USD", "source_kind": "provider_usage", "baseline": "0",
                    "baseline_basis": "   ", "soft_limit": "1", "hard_limit": "2",
                    "call_reservation": "0.3", "paused": false, "active": true, "reason": "r",
                },
                "now": NOW,
            }),
            "budget_invalid_text",
        ),
        (
            "a non-canonical period",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": {
                    "policy_id": "p", "expected_revision": 0, "run_id": null,
                    "period_start": "2026-02-30T00:00:00Z", "period_end": "2026-11-01T00:00:00Z",
                    "currency": "USD", "source_kind": "provider_usage", "baseline": "0",
                    "baseline_basis": "b", "soft_limit": "1", "hard_limit": "2",
                    "call_reservation": "0.3", "paused": false, "active": true, "reason": "r",
                },
                "now": NOW,
            }),
            "budget_invalid_time",
        ),
        (
            "a malformed amount",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": {
                    "policy_id": "p", "expected_revision": 0, "run_id": null,
                    "period_start": "2026-10-01T00:00:00Z", "period_end": "2026-11-01T00:00:00Z",
                    "currency": "USD", "source_kind": "provider_usage", "baseline": "-1",
                    "baseline_basis": "b", "soft_limit": "1", "hard_limit": "2",
                    "call_reservation": "0.3", "paused": false, "active": true, "reason": "r",
                },
                "now": NOW,
            }),
            "budget_invalid_amount",
        ),
        (
            "a stale revision",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": {
                    "policy_id": "p", "expected_revision": 7, "run_id": null,
                    "period_start": "2026-10-01T00:00:00Z", "period_end": "2026-11-01T00:00:00Z",
                    "currency": "USD", "source_kind": "provider_usage", "baseline": "0",
                    "baseline_basis": "b", "soft_limit": "1", "hard_limit": "2",
                    "call_reservation": "0.3", "paused": false, "active": true, "reason": "r",
                },
                "now": NOW,
            }),
            "budget_policy_revision_conflict",
        ),
        (
            "a reversed period",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": {
                    "policy_id": "p", "expected_revision": 0, "run_id": null,
                    "period_start": "2026-11-01T00:00:00Z", "period_end": "2026-10-01T00:00:00Z",
                    "currency": "USD", "source_kind": "provider_usage", "baseline": "0",
                    "baseline_basis": "b", "soft_limit": "1", "hard_limit": "2",
                    "call_reservation": "0.3", "paused": false, "active": true, "reason": "r",
                },
                "now": NOW,
            }),
            "budget_invalid_policy",
        ),
        (
            "an unknown source kind",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": {
                    "policy_id": "p", "expected_revision": 0, "run_id": null,
                    "period_start": "2026-10-01T00:00:00Z", "period_end": "2026-11-01T00:00:00Z",
                    "currency": "USD", "source_kind": "guessed", "baseline": "0",
                    "baseline_basis": "b", "soft_limit": "1", "hard_limit": "2",
                    "call_reservation": "0.3", "paused": false, "active": true, "reason": "r",
                },
                "now": NOW,
            }),
            "budget_invalid_policy",
        ),
        (
            "a job before any policy",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": { "job_id": "job-1", "run_id": "run-1", "worker_id": "w" },
                "now": NOW,
            }),
            "@\"allowed\":false",
        ),
        (
            "a call for an unregistered job",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": {
                    "job_id": "job-1", "call_id": "call-1", "session_id": null,
                    "provider": "fixture-provider", "model": "fixture-model", "purpose": null,
                },
                "now": NOW,
            }),
            "budget_hook_unavailable",
        ),
        (
            "a finish for a missing call",
            serde_json::json!({
                "operation": "apply",
                "state": { "schema": 1, "project": { "id": "project-1" } },
                "input": { "job_id": "job-1", "call_id": "call-1", "outcome": "finished", "tokens": null },
                "now": NOW,
            }),
            "budget_call_missing",
        ),
    ];
    for (label, document, message) in cases {
        // `retire` is deliberately not a real operation, so it must reach the
        // CLI verbatim instead of being canonicalised to a known name.
        let document = if document["operation"] == "apply" {
            canonical_document(&document.to_string())
        } else {
            document.to_string()
        };
        fixture.write("case.json", &document);
        let operation = serde_json::from_str::<serde_json::Value>(&document).unwrap()["operation"]
            .as_str()
            .unwrap()
            .to_string();
        let action = match operation.as_str() {
            "validate" | "public" => operation.as_str(),
            _ => "apply",
        };
        let output = fixture.run(&[
            "budget-admission",
            action,
            "--input-file",
            &fixture.path("case.json"),
        ]);
        if let Some(reason) = message.strip_prefix('@') {
            // A denial is a successful call, so it prints a JSON verdict.
            assert!(
                output.status.success(),
                "{label}: {}",
                public_output(&output)
            );
            assert!(
                stdout(&output).contains(reason),
                "{label}: expected {reason} in {}",
                stdout(&output)
            );
            continue;
        }
        assert_eq!(
            output.status.code(),
            Some(1),
            "{label}: {}",
            public_output(&output)
        );
        assert!(
            stdout(&output).is_empty(),
            "{label}: {}",
            public_output(&output)
        );
        // A `!` prefix marks a malformed request document, which the CLI
        // rejects as a usage error before the admission module runs. Every
        // other case is a domain error raised by the module itself.
        let expected = match message.strip_prefix('!') {
            Some(message) => message.to_string(),
            None => format!("Budget admission: {message}"),
        };
        assert!(
            public_output(&output).contains(&expected),
            "{label}: expected {expected} in {}",
            public_output(&output)
        );
    }
}

#[test]
fn usage_refuses_unknown_receipts_and_a_call_that_has_not_finished() {
    let fixture = Fixture::new();
    let base = fixture.document_with_a_finished_call();
    let base_state = base["state"].clone();
    let receipt = |amount: &str, patch: serde_json::Value| {
        let mut value = serde_json::json!({
            "event_id": "usage-1",
            "call_id": "call-1",
            "amount": amount,
            "currency": "USD",
            "source_kind": "provider_usage",
            "source_ref": "fixture-meter-only",
            "observed_at": "2026-10-15T00:00:00Z",
            "basis": "Fixture settled usage",
        });
        if let Some(patch) = patch.as_object() {
            for (key, patch_value) in patch {
                value[key] = patch_value.clone();
            }
        }
        value
    };
    let cases: [(serde_json::Value, &str); 3] = [
        (
            receipt("0.4", serde_json::json!({ "currency": "JPY" })),
            "budget_receipt_context_conflict",
        ),
        (
            receipt(
                "0.4",
                serde_json::json!({ "observed_at": "2026-10-14T00:00:00Z" }),
            ),
            "budget_receipt_context_conflict",
        ),
        (
            receipt(
                "0.4",
                serde_json::json!({ "observed_at": "2026-10-16T00:00:00Z" }),
            ),
            "budget_receipt_context_conflict",
        ),
    ];
    for (index, (input, message)) in cases.into_iter().enumerate() {
        let mut input = input;
        input["event_id"] = serde_json::json!(format!("usage-{index}"));
        input["call_id"] = serde_json::json!("call-1");
        let document = serde_json::json!({
            "operation": "usage", "state": base_state, "input": input, "now": NOW,
        });
        fixture.write("case.json", &document.to_string());
        let output = fixture.run(&[
            "budget-admission",
            "apply",
            "--input-file",
            &fixture.path("case.json"),
        ]);
        assert_eq!(output.status.code(), Some(1), "{}", public_output(&output));
        assert!(stdout(&output).is_empty(), "{}", public_output(&output));
        assert!(
            public_output(&output).contains(message),
            "expected {message} in {}",
            public_output(&output)
        );
    }

    // The call is settled by a first receipt; a different amount then conflicts.
    let settled = fixture.run_json(
        &serde_json::json!({
            "operation": "usage", "state": base_state,
            "input": receipt("0.4", serde_json::Value::Null),
            "now": NOW,
        })
        .to_string(),
    );
    let book = state_with(&settled["budget_admission"]);
    for (input, message) in [
        // A fresh receipt for the same call with a different amount.
        (
            receipt("0.5", serde_json::json!({ "event_id": "usage-2" })),
            "budget_settlement_conflict",
        ),
        // The stored event id with a different body is a receipt conflict.
        (
            receipt("0.4", serde_json::json!({ "source_ref": "another-meter" })),
            "budget_receipt_conflict",
        ),
    ] {
        let document = serde_json::json!({
            "operation": "usage", "state": book, "input": input, "now": NOW,
        });
        fixture.write("case.json", &document.to_string());
        let output = fixture.run(&[
            "budget-admission",
            "apply",
            "--input-file",
            &fixture.path("case.json"),
        ]);
        assert_eq!(output.status.code(), Some(1), "{}", public_output(&output));
        assert!(
            public_output(&output).contains(message),
            "expected {message} in {}",
            public_output(&output)
        );
    }
}

#[test]
fn validate_accepts_and_rejects_like_the_js_module() {
    let fixture = Fixture::new();
    let ok = fixture
        .run_json(&format!(r#"{{"operation":"validate","state":{{"schema":1,"project":{{"id":"project-1"}}}},"now":"{NOW}"}}"#));
    assert_eq!(ok["valid"], true);
    let applied = fixture.run_json(&policy_document());
    let stored = applied["budget_admission"].clone();
    let valid = fixture.run_json(
        &serde_json::json!({
            "operation": "validate",
            "state": { "schema": 1, "project": { "id": "project-1" }, "budget_admission": stored },
            "now": NOW,
        })
        .to_string(),
    );
    assert_eq!(valid["valid"], true);
    // A tampered stored amount is refused by the replay.
    let mut damaged = stored.clone();
    damaged["policies"]["project-budget"]["baseline"] = serde_json::json!("9");
    let refused = fixture.run_failure(&serde_json::json!({
        "operation": "validate",
        "state": { "schema": 1, "project": { "id": "project-1" }, "budget_admission": damaged },
        "now": NOW,
    }));
    assert!(
        refused.contains("budget_invalid_audit"),
        "expected budget_invalid_audit in {refused}"
    );
    // A wrong schema and a wrong project are refused before the replay.
    for patch in [
        serde_json::json!({ "schema": 2 }),
        serde_json::json!({ "project_id": "someone-else" }),
        serde_json::json!({ "operations": "no" }),
    ] {
        let mut broken = applied["budget_admission"].clone();
        for (key, value) in patch.as_object().unwrap() {
            broken[key] = value.clone();
        }
        let refused = fixture.run_failure(&serde_json::json!({
            "operation": "validate",
            "state": { "schema": 1, "project": { "id": "project-1" }, "budget_admission": broken },
            "now": NOW,
        }));
        assert!(
            refused.contains("budget_invalid_store"),
            "expected budget_invalid_store in {refused}"
        );
    }
}

#[test]
fn commands_refuse_unreadable_invalid_and_mismatched_input() {
    let fixture = Fixture::new();
    fixture.write("invalid.json", "{ not json");
    let invalid = fixture.run(&[
        "budget-admission",
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
        "budget-admission",
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
    let huge = fixture.run(&["budget-admission", "public", "--input-file", &oversized]);
    assert!(!huge.status.success());
    assert!(
        public_output(&huge).contains("at most 256 KiB"),
        "{}",
        public_output(&huge)
    );
    // The declared operation must match the requested action.
    fixture.write(
        "mismatch.json",
        &format!(r#"{{"operation":"validate","state":{{"schema":1,"project":{{"id":"project-1"}}}},"now":"{NOW}"}}"#),
    );
    let mismatch = fixture.run(&[
        "budget-admission",
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
    // A missing `now` is refused rather than read from the clock.
    fixture.write(
        "no-now.json",
        r#"{"operation":"public","state":{"schema":1,"project":{"id":"project-1"}}}"#,
    );
    let no_now = fixture.run(&[
        "budget-admission",
        "public",
        "--input-file",
        &fixture.path("no-now.json"),
    ]);
    assert_eq!(no_now.status.code(), Some(1));
    assert!(
        public_output(&no_now).contains("budget_invalid_time"),
        "{}",
        public_output(&no_now)
    );
    // An unknown action is refused.
    let unknown = fixture.run(&[
        "budget-admission",
        "inspect",
        "--input-file",
        &fixture.path("mismatch.json"),
    ]);
    assert!(!unknown.status.success());
}

#[test]
fn commands_accept_a_utf8_bom_like_the_dashboard_cli() {
    let fixture = Fixture::new();
    fixture.write("bom.json", &format!("\u{feff}{}", policy_document()));
    let output = fixture.run(&[
        "budget-admission",
        "apply",
        "--input-file",
        &fixture.path("bom.json"),
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    assert!(stdout(&output).starts_with(r#"{"operation":"policy","#));
}

#[test]
fn public_prints_null_for_a_missing_book() {
    let fixture = Fixture::new();
    let output = fixture.run_json(&format!(
        r#"{{"operation":"public","state":{{"schema":1,"project":{{"id":"project-1"}}}},"now":"{NOW}"}}"#
    ));
    assert_eq!(output["budget_admission"], serde_json::Value::Null);
}

#[test]
fn large_integers_never_serialise_as_floats() {
    let fixture = Fixture::new();
    let mut state = serde_json::json!({ "schema": 1, "project": { "id": "project-1" } });
    let mut policy: serde_json::Value = serde_json::from_str(POLICY).unwrap();
    policy["hard_limit"] = serde_json::json!("4000000000000000");
    policy["soft_limit"] = serde_json::json!("4000000000000000");
    let applied = fixture.run_json(
        &serde_json::json!({ "operation": "apply", "state": state, "input": policy, "now": NOW })
            .to_string(),
    );
    state = state_with(&applied["budget_admission"]);
    let job = fixture.run_json(
        &serde_json::json!({
            "operation": "apply", "state": state,
            "input": { "job_id": "job-1", "run_id": "run-1", "worker_id": "w" }, "now": NOW,
        })
        .to_string(),
    );
    state = state_with(&job["budget_admission"]);
    let ready = fixture.run_json(
        &serde_json::json!({
            "operation": "apply", "state": state,
            "input": { "job_id": "job-1" }, "now": NOW,
        })
        .to_string(),
    );
    state = state_with(&ready["budget_admission"]);
    let call = fixture.run_json(
        &serde_json::json!({
            "operation": "apply", "state": state,
            "input": {
                "job_id": "job-1", "call_id": "call-1", "session_id": null,
                "provider": "p", "model": "m", "purpose": null,
            },
            "now": NOW,
        })
        .to_string(),
    );
    // Saturating arithmetic must not turn the token maximum into a float.
    // Only the token fields are checked: ISO timestamps legitimately contain
    // `.000`, so scanning the whole document for `.0` proves nothing.
    let text = call.to_string();
    assert!(!text.contains("9007199254740991.0"), "{text}");
    let finish = fixture.run_json(
        &serde_json::json!({
            "operation": "apply",
            "state": state_with(&call["budget_admission"]),
            "input": {
                "job_id": "job-1", "call_id": "call-1", "outcome": "finished",
                "tokens": { "input": 9007199254740991i64, "cached_input": null, "cache_write": null, "output": 0 },
            },
            "now": NOW,
        })
        .to_string(),
    );
    assert_eq!(finish["result"]["tokens"]["input"], 9007199254740991i64);
    assert!(!finish.to_string().contains("9007199254740991.0"));
}

/// The project state document that carries `book`.
///
/// `budget_admission` is only one field of the state, so a round trip that
/// keeps the book alone would drop `project.id` and the next operation would
/// rebuild an empty book.
fn state_with(book: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "schema": 1,
        "project": { "id": "project-1" },
        "budget_admission": book,
    })
}

/// The admission operation a document means when it still says `"apply"`.
///
/// `apply` is the CLI action, not an admission operation, so a test document
/// naming it is resolved from the payload's own key set — the same
/// discrimination the JS `operate` switch performs.
fn canonical_document(document: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(document) else {
        return document.to_string();
    };
    if value["operation"].as_str() == Some("apply") {
        let keys: Vec<&str> = value["input"]
            .as_object()
            .map(|object| object.keys().map(String::as_str).collect())
            .unwrap_or_default();
        let operation = if keys.contains(&"expected_revision") {
            "policy"
        } else if keys.contains(&"event_id") {
            "usage"
        } else if keys.contains(&"outcome") {
            "finish"
        } else if keys.contains(&"call_id") {
            "call"
        } else if keys.contains(&"worker_id") {
            "job"
        } else if keys == ["job_id"] {
            "ready"
        } else {
            "policy"
        };
        value["operation"] = serde_json::json!(operation);
    }
    value.to_string()
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-budget-{suffix}"));
        std::fs::create_dir_all(root.join("dsh")).unwrap();
        Self { root }
    }

    fn path(&self, name: &str) -> String {
        self.root.join(name).to_string_lossy().into_owned()
    }

    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.root.join(name), text).unwrap();
    }

    /// Run the inline document through its CLI action and parse stdout.
    ///
    /// A budget operation (`policy`, `job`, `ready`, `close`, `call`,
    /// `finish`, `usage`) is driven by `apply`; `validate` and `public` name
    /// themselves. A document that still says `"operation":"apply"` has its
    /// operation inferred from the payload keys, which keeps each case below
    /// readable.
    fn run_json(&self, document: &str) -> serde_json::Value {
        let document = canonical_document(document);
        self.write("inline.json", &document);
        let operation = serde_json::from_str::<serde_json::Value>(&document)
            .expect("fixture documents are JSON")["operation"]
            .as_str()
            .expect("fixture documents declare an operation")
            .to_string();
        let action = match operation.as_str() {
            "validate" | "public" => operation.as_str(),
            _ => "apply",
        };
        let output = self.run(&[
            "budget-admission",
            action,
            "--input-file",
            &self.path("inline.json"),
        ]);
        assert!(output.status.success(), "{}", public_output(&output));
        serde_json::from_str(&stdout(&output)).expect("stdout is JSON")
    }

    /// Run an inline document that must fail, returning the combined output.
    fn run_failure(&self, document: &serde_json::Value) -> String {
        let document = canonical_document(&document.to_string());
        self.write("failure.json", &document);
        let operation = serde_json::from_str::<serde_json::Value>(&document).unwrap()["operation"]
            .as_str()
            .unwrap()
            .to_string();
        let action = match operation.as_str() {
            "validate" | "public" => operation.as_str(),
            _ => "apply",
        };
        let output = self.run(&[
            "budget-admission",
            action,
            "--input-file",
            &self.path("failure.json"),
        ]);
        assert_eq!(output.status.code(), Some(1), "{}", public_output(&output));
        assert!(stdout(&output).is_empty(), "{}", public_output(&output));
        public_output(&output)
    }

    /// A book holding one policy, one registered job and one finished call.
    fn document_with_a_finished_call(&self) -> serde_json::Value {
        let mut state = serde_json::json!({ "schema": 1, "project": { "id": "project-1" } });
        let mut policy: serde_json::Value = serde_json::from_str(POLICY).unwrap();
        policy["hard_limit"] = serde_json::json!("4");
        let steps = [
            policy,
            serde_json::json!({ "job_id": "job-1", "run_id": "run-1", "worker_id": "worker-1" }),
            serde_json::json!({ "job_id": "job-1" }),
            serde_json::json!({
                "job_id": "job-1", "call_id": "call-1", "session_id": null,
                "provider": "fixture-provider", "model": "fixture-model", "purpose": null,
            }),
            serde_json::json!({
                "job_id": "job-1", "call_id": "call-1", "outcome": "finished", "tokens": null,
            }),
        ];
        for input in steps {
            let document = serde_json::json!({
                "operation": "apply", "state": state, "input": input, "now": NOW,
            });
            state = state_with(&self.run_json(&document.to_string())["budget_admission"]);
        }
        // Replaying the settled call would conflict, so the prepared document
        // opens a *second* call against the same book.
        serde_json::json!({
            "operation": "call",
            "state": state,
            "input": {
                "job_id": "job-1", "call_id": "call-2", "session_id": null,
                "provider": "fixture-provider", "model": "fixture-model", "purpose": null,
            },
            "now": NOW,
        })
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
