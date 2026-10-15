//! `rdsh question-contracts` integration: the Rust module ports
//! `dashboard/question-contracts.mjs`, so the CLI contract is checked on the
//! real binary — compact JSON on stdout with the JS key order preserved, the
//! JS error message on stderr, exit 1, byte-identical output across runs, and
//! no dependency on settings or the clock.
use std::path::PathBuf;
use std::process::{Command, Output};

/// The instant the CLI takes as `now`, so no wall clock enters a comparison.
const NOW: &str = "2026-06-01T00:00:00.000Z";

/// The approval decision the JS test file builds with `approval()`.
const APPROVAL: &str = r#"{
  "kind": "approval",
  "target": {
    "task_id": "T1",
    "run_id": "run-fixture-1",
    "session_id": "native-fixture-1",
    "action_id": "publish-fixture",
    "revision": "target-v1"
  },
  "choices": [
    { "id": "proceed", "label": "この条件で進める", "detail": "対象の版と上限額を確認" },
    { "id": "hold", "label": "保留する" }
  ],
  "recommended_choice": "hold",
  "recommendation_reason": "公開対象を確認してから進めるため",
  "diff": "fixture.mdのみ公開対象に加える",
  "impact": "公開された文書を他の利用者が閲覧できます",
  "conditions": "T1・run-fixture-1・target-v1に限定。mergeや課金は別判断",
  "cost": {
    "currency": "USD",
    "max": 5,
    "description": "申告された上限。費用の実測ではありません"
  }
}"#;

/// A `question` request holding the [`APPROVAL`] decision.
fn create_document() -> String {
    format!(
        r#"{{"operation":"question","state":{{"questions":[]}},"input":{{"id":"Q1","question":"この版の文書を公開しますか？","decision":{APPROVAL}}},"now":"{NOW}"}}"#
    )
}

/// The canonical card the JS module writes for [`APPROVAL`] at [`NOW`].
///
/// `changeQuestionContract` reads the clock through `new Date().toISOString()`
/// for `created_at`/`updated_at`, so the port cannot be compared against a
/// literal timestamp; every other byte is fixed. This is the shape the
/// differential oracle checks byte-for-byte, with the two clock fields masked.
const CARD_KEYS: &str = concat!(
    r#"{"revision":1,"fingerprint":"c91e69d74a2d58210c82fcf930f379af81d7143a19e4676894090faa862afe37","#,
    r#""snapshot":{"question":"この版の文書を公開しますか？","urgency":"normal","default_action":"","decision":{"#,
    r#""kind":"approval","target":{"task_id":"T1","run_id":"run-fixture-1","#,
    r#""session_id":"native-fixture-1","action_id":"publish-fixture","revision":"target-v1"},"#,
    r#""choices":[{"id":"proceed","label":"この条件で進める","detail":"対象の版と上限額を確認"},"#,
    r#"{"id":"hold","label":"保留する","detail":""}],"recommended_choice":"hold","#,
    r#""recommendation_reason":"公開対象を確認してから進めるため","#,
    r#""diff":"fixture.mdのみ公開対象に加える","#,
    r#""impact":"公開された文書を他の利用者が閲覧できます","#,
    r#""conditions":"T1・run-fixture-1・target-v1に限定。mergeや課金は別判断","#,
    r#""cost":{"currency":"USD","max":5,"description":"申告された上限。費用の実測ではありません"},"expires_at":null}},"#,
    r#""status":"open","created_at":"#,
);

#[test]
fn apply_create_prints_the_js_json_shape_and_key_order() {
    let fixture = Fixture::new();
    let printed = fixture.run_json(&create_document());

    // Key order is part of the contract: `serde_json` runs with
    // `preserve_order`, and the port inserts in the JS literal order.
    let raw = fixture.run_raw(&create_document());
    let card_start = raw.find(CARD_KEYS).unwrap_or_else(|| {
        panic!("card prefix is not the JS insertion order:\n{raw}");
    });
    assert!(card_start > 0, "{raw}");

    // The card the module stores is echoed back under `question_contracts`.
    let card = &printed["question_contracts"]["cards"]["Q1"];
    assert_eq!(card["revision"], 1);
    assert_eq!(
        card["fingerprint"],
        "c91e69d74a2d58210c82fcf930f379af81d7143a19e4676894090faa862afe37"
    );
    assert_eq!(card["status"], "open");
    assert_eq!(card["answer"], serde_json::Value::Null);
    assert_eq!(card["cancel_reason"], serde_json::Value::Null);
    assert_eq!(card["history"], serde_json::json!([]));
    assert_eq!(card["snapshot"]["urgency"], "normal");
    assert_eq!(card["snapshot"]["default_action"], "");
    assert_eq!(card["snapshot"]["decision"]["kind"], "approval");
    assert_eq!(card["snapshot"]["decision"]["cost"]["max"], 5);

    // A mirror record lands in `state.questions` for the dashboard.
    let record = &printed["questions"][0];
    assert_eq!(record["id"], "Q1");
    assert_eq!(record["question"], "この版の文書を公開しますか？");
    assert_eq!(record["urgency"], "normal");
    assert_eq!(record["answer"], serde_json::Value::Null);
    assert_eq!(printed["operation"], "question");
    assert_eq!(printed["result"], serde_json::Value::Null);
}

#[test]
fn apply_is_byte_identical_across_runs() {
    let fixture = Fixture::new();
    let first = fixture.run_raw(&create_document());
    let second = fixture.run_raw(&create_document());
    // `now` is supplied, but the module stamps `created_at` from its own
    // clock; identical input within the same millisecond still has to be
    // stable, and every other byte must match exactly.
    let masked = |text: &str| {
        let mut value: serde_json::Value = serde_json::from_str(text).unwrap();
        for card in value["question_contracts"]["cards"]
            .as_object_mut()
            .into_iter()
            .flatten()
            .map(|(_, card)| card)
        {
            card["created_at"] = serde_json::json!("<masked>");
            card["updated_at"] = serde_json::json!("<masked>");
        }
        for question in value["questions"].as_array_mut().into_iter().flatten() {
            question["created_at"] = serde_json::json!("<masked>");
        }
        value.to_string()
    };
    assert_eq!(masked(&first), masked(&second));
}

#[test]
fn apply_prints_javascript_number_spelling_for_numeric_snapshots() {
    let fixture = Fixture::new();
    for (input_number, expected) in [
        ("1.0", "\"max\":1,\"description\""),
        ("-0.0", "\"max\":0,\"description\""),
        ("1e-6", "\"max\":0.000001,\"description\""),
        ("1e20", "\"max\":100000000000000000000,\"description\""),
        (
            "9007199254740993",
            "\"max\":9007199254740992,\"description\"",
        ),
    ] {
        let document = serde_json::json!({
            "operation": "question",
            "state": { "questions": [] },
            "input": {
                "id": "Q1",
                "question": "numeric fixture",
                "decision": {
                    "kind": "consultation",
                    "cost": { "currency": "USD", "max": "NUMBER_PLACEHOLDER" }
                }
            },
            "now": NOW
        });
        let raw = serde_json::to_string(&document).unwrap().replace(
            "\"max\":\"NUMBER_PLACEHOLDER\"",
            &format!("\"max\":{input_number}"),
        );
        let output = fixture.run_raw(&raw);
        assert!(
            output.contains(expected),
            "input={input_number}, expected={expected}, stdout={output}"
        );
    }
}

#[test]
fn apply_rejects_every_documented_error_with_the_js_message() {
    let fixture = Fixture::new();
    let cases: &[(&str, &str, &str)] = &[
        (
            "unknown field",
            r#"{"id":"Q1","question":"q","decision":{"kind":"consultation","target":{"task_id":"T1"}},"bogus":1}"#,
            "Unknown question contract field",
        ),
        (
            "unknown kind",
            r#"{"id":"Q1","question":"q","decision":{"kind":"decision","target":{"task_id":"T1"}}}"#,
            "Invalid question kind",
        ),
        (
            "target needs an entity",
            r#"{"id":"Q1","question":"q","decision":{"kind":"consultation","target":{"revision":"v1"}}}"#,
            "Target requires an entity id",
        ),
        (
            "choices not an array",
            r#"{"id":"Q1","question":"q","decision":{"kind":"approval","target":{"task_id":"T1","action_id":"a","revision":"v1"},"choices":"nope","diff":"d","impact":"i","conditions":"c","cost":{"currency":"USD","max":1}}}"#,
            "At most eight choices are allowed",
        ),
        (
            "nine choices",
            r#"{"id":"Q1","question":"q","decision":{"kind":"approval","target":{"task_id":"T1","action_id":"a","revision":"v1"},"choices":[{"id":"a","label":"1"},{"id":"b","label":"2"},{"id":"c","label":"3"},{"id":"d","label":"4"},{"id":"e","label":"5"},{"id":"f","label":"6"},{"id":"g","label":"7"},{"id":"h","label":"8"},{"id":"i","label":"9"}],"diff":"d","impact":"i","conditions":"c","cost":{"currency":"USD","max":1}}}"#,
            "At most eight choices are allowed",
        ),
        (
            "duplicate choice",
            r#"{"id":"Q1","question":"q","decision":{"kind":"approval","target":{"task_id":"T1","action_id":"a","revision":"v1"},"choices":[{"id":"a","label":"x"},{"id":"a","label":"y"}],"diff":"d","impact":"i","conditions":"c","cost":{"currency":"USD","max":1}}}"#,
            "Duplicate choice id",
        ),
        (
            "recommendation missing",
            r#"{"id":"Q1","question":"q","decision":{"kind":"approval","target":{"task_id":"T1","action_id":"a","revision":"v1"},"choices":[{"id":"a","label":"x"},{"id":"b","label":"y"}],"recommended_choice":"nope"}}"#,
            "Recommended choice does not exist",
        ),
        (
            "recommendation without reason",
            r#"{"id":"Q1","question":"q","decision":{"kind":"approval","target":{"task_id":"T1","action_id":"a","revision":"v1"},"choices":[{"id":"a","label":"x"},{"id":"b","label":"y"}],"recommended_choice":"a","recommendation_reason":""}}"#,
            "A recommendation requires its reason",
        ),
        (
            "cost currency",
            r#"{"id":"Q1","question":"q","decision":{"kind":"approval","target":{"task_id":"T1","action_id":"a","revision":"v1"},"choices":[{"id":"a","label":"x"},{"id":"b","label":"y"}],"cost":{"currency":"JPY","max":1}}}"#,
            "Cost requires USD and a nonnegative limit or null",
        ),
        (
            "cost negative",
            r#"{"id":"Q1","question":"q","decision":{"kind":"approval","target":{"task_id":"T1","action_id":"a","revision":"v1"},"choices":[{"id":"a","label":"x"},{"id":"b","label":"y"}],"cost":{"currency":"USD","max":-1}}}"#,
            "Cost requires USD and a nonnegative limit or null",
        ),
        (
            "cost string limit",
            r#"{"id":"Q1","question":"q","decision":{"kind":"approval","target":{"task_id":"T1","action_id":"a","revision":"v1"},"choices":[{"id":"a","label":"x"},{"id":"b","label":"y"}],"cost":{"currency":"USD","max":"5"}}}"#,
            "Cost requires USD and a nonnegative limit or null",
        ),
        (
            "consumer without run",
            r#"{"id":"Q1","question":"q","decision":{"kind":"consultation","target":{"task_id":"T1","session_id":"session-1","revision":"v1"},"consumer_id":"c"}}"#,
            "An answer consumer requires exact run/session IDs",
        ),
        (
            "approval without diff",
            r#"{"id":"Q1","question":"q","decision":{"kind":"approval","target":{"task_id":"T1","action_id":"a","revision":"v1"},"choices":[{"id":"a","label":"x"},{"id":"b","label":"y"}],"impact":"i","conditions":"c","cost":{"currency":"USD","max":1}}}"#,
            "Approval requires a versioned action, diff, impact, conditions and explicit cost (null means unknown)",
        ),
        (
            "approval without cost",
            r#"{"id":"Q1","question":"q","decision":{"kind":"approval","target":{"task_id":"T1","action_id":"a","revision":"v1"},"choices":[{"id":"a","label":"x"},{"id":"b","label":"y"}],"diff":"d","impact":"i","conditions":"c"}}"#,
            "Approval requires a versioned action, diff, impact, conditions and explicit cost (null means unknown)",
        ),
        (
            "approval with one choice",
            r#"{"id":"Q1","question":"q","decision":{"kind":"approval","target":{"task_id":"T1","action_id":"a","revision":"v1"},"choices":[{"id":"a","label":"x"}],"diff":"d","impact":"i","conditions":"c","cost":{"currency":"USD","max":1}}}"#,
            "Approval requires at least two explicit choices",
        ),
        (
            "urgency",
            r#"{"id":"Q1","question":"q","urgency":"urgent","decision":{"kind":"consultation","target":{"task_id":"T1"}}}"#,
            "Invalid urgency",
        ),
        (
            "action",
            r#"{"id":"Q1","question":"q","action":"destroy","decision":{"kind":"consultation","target":{"task_id":"T1"}}}"#,
            "Invalid question action",
        ),
        (
            "expires",
            r#"{"id":"Q1","question":"q","decision":{"kind":"consultation","target":{"task_id":"T1","run_id":"run-1","session_id":"session-1","revision":"v1"},"expires_at":"not-a-date"}}"#,
            "Invalid expires_at",
        ),
        (
            "prototype id",
            r#"{"id":"__proto__","question":"q","decision":{"kind":"consultation","target":{"task_id":"T1"}}}"#,
            "Invalid question id",
        ),
        (
            "cancel with contents",
            r#"{"id":"Q1","question":"q","action":"cancel","expected_revision":1,"cancel_reason":"r","decision":{"kind":"consultation","target":{"task_id":"T1"}}}"#,
            "Cancellation cannot replace question contents",
        ),
        (
            "cancel reason on create",
            r#"{"id":"Q1","question":"q","cancel_reason":"r","decision":{"kind":"consultation","target":{"task_id":"T1"}}}"#,
            "cancel_reason requires cancellation",
        ),
        (
            "create with expected revision",
            r#"{"id":"Q1","question":"q","expected_revision":1,"decision":{"kind":"consultation","target":{"task_id":"T1","run_id":"run-1","session_id":"session-1","revision":"v1"}}}"#,
            "Creating a question cannot specify an existing revision",
        ),
    ];
    for (name, input, message) in cases {
        let document = format!(
            r#"{{"operation":"question","state":{{"questions":[]}},"input":{input},"now":"{NOW}"}}"#
        );
        let printed = fixture.run_failure_str(&document);
        assert!(
            printed.contains(message),
            "{name}: expected {message:?} in {printed:?}"
        );
    }
}

#[test]
fn create_twice_refuses_and_revise_requires_a_change() {
    let fixture = Fixture::new();
    let created = fixture.run_json(&create_document());
    let state = serde_json::json!({
        "question_contracts": created["question_contracts"],
        "questions": created["questions"],
    });
    let document = |input: &str| {
        format!(
            r#"{{"operation":"question","state":{state},"input":{input},"now":"{NOW}"}}"#,
            state = state
        )
    };

    // A second create on the same id must go through `revise`.
    let printed = fixture.run_failure_str(&document(
        r#"{"id":"Q1","question":"この版の文書を公開しますか？","decision":{"kind":"consultation","target":{"task_id":"T1","revision":"target-v1"}}}"#,
    ));
    assert!(
        printed.contains("Question id already exists; use revise for a typed question"),
        "{printed}"
    );

    // Revising to an identical snapshot is refused by fingerprint.
    let printed = fixture.run_failure_str(&document(&format!(
        r#"{{"id":"Q1","question":"この版の文書を公開しますか？","action":"revise","expected_revision":1,"decision":{APPROVAL}}}"#
    )));
    assert!(
        printed.contains("Question contract is unchanged"),
        "{printed}"
    );

    // A revision with a changed cost supersedes the old card.
    let revised = fixture.run_json(&document(
        r#"{"id":"Q1","question":"この版の文書を公開しますか？","action":"revise","expected_revision":1,"decision":{"kind":"approval","target":{"task_id":"T1","run_id":"run-fixture-1","session_id":"native-fixture-1","action_id":"publish-fixture","revision":"target-v2"},"choices":[{"id":"proceed","label":"この条件で進める"},{"id":"hold","label":"保留する"}],"diff":"d","impact":"i","conditions":"c","cost":{"currency":"USD","max":9,"description":"x"}}}"#,
    ));
    let card = &revised["question_contracts"]["cards"]["Q1"];
    assert_eq!(card["revision"], 2);
    assert_eq!(card["history"].as_array().unwrap().len(), 1);
    assert_eq!(card["history"][0]["status"], "superseded");
    assert_eq!(
        card["history"][0]["invalidation_reason"],
        "question_contract_changed"
    );
    assert_eq!(
        card["revision"].as_i64().unwrap(),
        card["history"][0]["revision"].as_i64().unwrap() + 1
    );
}

#[test]
fn revise_with_a_stale_revision_conflicts_with_the_js_message() {
    let fixture = Fixture::new();
    let created = fixture.run_json(&create_document());
    let state = serde_json::json!({
        "question_contracts": created["question_contracts"],
        "questions": created["questions"],
    });
    let document = format!(
        r#"{{"operation":"question","state":{state},"input":{{"id":"Q1","question":"この版の文書を公開しますか？","action":"revise","expected_revision":99,"decision":{{"kind":"consultation","target":{{"task_id":"T1","revision":"target-v1"}}}}}},"now":"{NOW}"}}"#
    );
    let printed = fixture.run_failure_str(&document);
    assert!(
        printed.contains("質問の版が変わりました。対象と条件を確認して再判断してください。"),
        "{printed}"
    );
}

#[test]
fn cancel_requires_a_reason_and_is_idempotent_only_for_the_same_one() {
    let fixture = Fixture::new();
    let created = fixture.run_json(&create_document());
    let state = serde_json::json!({
        "question_contracts": created["question_contracts"],
        "questions": created["questions"],
    });

    // A cancel with no reason is invalid.
    let printed = fixture.run_failure_str(&format!(
        r#"{{"operation":"question","state":{state},"input":{{"id":"Q1","action":"cancel","expected_revision":1}},"now":"{NOW}"}}"#
    ));
    assert!(printed.contains("Invalid cancel reason"), "{printed}");

    // The first cancel closes the card.
    let cancelled = fixture.run_json(&format!(
        r#"{{"operation":"question","state":{state},"input":{{"id":"Q1","action":"cancel","expected_revision":1,"cancel_reason":"不要になった"}},"now":"{NOW}"}}"#
    ));
    let card = &cancelled["question_contracts"]["cards"]["Q1"];
    assert_eq!(card["status"], "cancelled");
    assert_eq!(card["cancel_reason"], "不要になった");
    assert!(card["updated_at"].is_string(), "{}", cancelled);

    let closed = serde_json::json!({
        "question_contracts": cancelled["question_contracts"],
        "questions": cancelled["questions"],
    });
    let cancel = |reason: &str| {
        format!(
            r#"{{"operation":"question","state":{closed},"input":{{"id":"Q1","action":"cancel","expected_revision":1,"cancel_reason":"{reason}"}},"now":"{NOW}"}}"#
        )
    };

    // Repeating the same reason is accepted; a different one conflicts.
    let repeated = fixture.run_json(&cancel("不要になった"));
    assert_eq!(
        repeated["question_contracts"]["cards"]["Q1"]["status"],
        "cancelled"
    );
    let printed = fixture.run_failure_str(&cancel("別の理由"));
    assert!(
        printed.contains("Question already cancelled for another reason"),
        "{printed}"
    );
}

#[test]
fn answer_records_the_choice_and_refuses_a_stale_revision() {
    let fixture = Fixture::new();
    let created = fixture.run_json(&create_document());
    let fingerprint = created["question_contracts"]["cards"]["Q1"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_string();
    let state = serde_json::json!({
        "question_contracts": created["question_contracts"],
        "questions": created["questions"],
    });
    let answer = |input: &str| {
        format!(r#"{{"operation":"answer","state":{state},"input":{input},"now":"{NOW}"}}"#)
    };

    let printed = fixture.run_failure_str(&answer(&format!(
        r#"{{"id":"Q1","answer":"この条件で進める","expected_revision":9,"contract_fingerprint":"{fingerprint}"}}"#
    )));
    assert!(
        printed.contains("質問の版が変わりました。対象と条件を確認して再判断してください。"),
        "{printed}"
    );

    let printed = fixture.run_failure_str(&answer(&format!(
        r#"{{"id":"Q1","answer":"この条件で進める","expected_revision":1,"contract_fingerprint":"{fingerprint}","choice_id":"nope"}}"#
    )));
    assert!(
        printed.contains("Choice does not exist in this question revision"),
        "{printed}"
    );

    let printed = fixture.run_failure_str(&answer(&format!(
        r#"{{"id":"Q1","answer":"  ","expected_revision":1,"contract_fingerprint":"{fingerprint}","choice_id":"proceed"}}"#
    )));
    assert!(printed.contains("Invalid answer"), "{printed}");

    let answered = fixture.run_json(&answer(&format!(
        r#"{{"id":"Q1","answer":"この条件で進める","expected_revision":1,"contract_fingerprint":"{fingerprint}","choice_id":"proceed"}}"#
    )));
    let result = &answered["result"];
    assert_eq!(result["choice_id"], "proceed");
    assert_eq!(result["contract_revision"], 1);
    assert_eq!(result["question_kind"], "approval");
    assert_eq!(result["execution_authorized"], false);
    let card = &answered["question_contracts"]["cards"]["Q1"];
    assert_eq!(card["status"], "answered");
    assert_eq!(card["answer"]["text"], "この条件で進める");
    assert_eq!(card["answer"]["choice_id"], "proceed");
    assert_eq!(card["answer"]["answered_at"], NOW);
    assert_eq!(card["answer"]["contract_fingerprint"], fingerprint);
    // The mirror record keeps the answer the dashboard renders.
    assert_eq!(answered["questions"][0]["answer"], "この条件で進める");
    assert_eq!(answered["questions"][0]["answered_at"], NOW);
}

#[test]
fn public_projects_cards_with_changed_fields_and_answers() {
    let fixture = Fixture::new();
    let created = fixture.run_json(&create_document());
    let state = serde_json::json!({
        "question_contracts": created["question_contracts"],
        "questions": created["questions"],
    });

    let projected = fixture.run_json(&format!(
        r#"{{"operation":"public","state":{state},"input":{{}},"now":"{NOW}"}}"#
    ));
    let card = &projected["question_contracts"]["cards"]["Q1"];
    assert_eq!(card["status"], "open");
    assert!(
        card["changed_fields"].as_array().unwrap().is_empty(),
        "{projected}"
    );
    assert_eq!(card["execution_authorized"], false);
    assert_eq!(card["answer"], serde_json::Value::Null);

    // An expired card reports its own status.
    let expired = fixture.run_json(&format!(
        r#"{{"operation":"question","state":{{"questions":[]}},"input":{{"id":"Q1","question":"q","decision":{{"kind":"consultation","target":{{"task_id":"T1","revision":"target-v1"}},"expires_at":"2020-01-01T00:00:00Z"}}}},"now":"{NOW}"}}"#
    ));
    let expired_state = serde_json::json!({
        "question_contracts": expired["question_contracts"],
        "questions": expired["questions"],
    });
    let projected = fixture.run_json(&format!(
        r#"{{"operation":"public","state":{expired_state},"input":{{}},"now":"{NOW}"}}"#
    ));
    assert_eq!(
        projected["question_contracts"]["cards"]["Q1"]["status"],
        "expired"
    );
}

#[test]
fn validate_accepts_a_fresh_card_and_rejects_corrupt_state() {
    let fixture = Fixture::new();
    let created = fixture.run_json(&create_document());
    let state = serde_json::json!({
        "question_contracts": created["question_contracts"],
        "questions": created["questions"],
    });

    let valid = fixture.run_json(&format!(
        r#"{{"operation":"validate","state":{state},"input":{{}},"now":"{NOW}"}}"#
    ));
    assert_eq!(valid["valid"], true, "{valid}");
    assert_eq!(valid["operation"], "validate");

    let corrupt: &[(&str, serde_json::Value, &str)] = &[
        (
            "unsupported schema",
            serde_json::json!({ "schema": 2, "cards": {} }),
            "Unsupported question contract schema",
        ),
        (
            "unknown extension key",
            serde_json::json!({ "schema": 1, "cards": {}, "extra": 1 }),
            "Unknown question contract field",
        ),
    ];
    for (name, contracts, message) in corrupt {
        let state = serde_json::json!({ "question_contracts": contracts, "questions": [] });
        let printed = fixture.run_failure_str(&format!(
            r#"{{"operation":"validate","state":{state},"input":{{}},"now":"{NOW}"}}"#
        ));
        assert!(printed.contains(message), "{name}: {printed}");
    }

    // A mirror record that disagrees with its snapshot is caught.
    let mut disagree = state.clone();
    disagree["questions"][0]["question"] = serde_json::json!("different");
    let printed = fixture.run_failure_str(&format!(
        r#"{{"operation":"validate","state":{disagree},"input":{{}},"now":"{NOW}"}}"#
    ));
    assert!(
        printed.contains("Question and contract snapshot disagree"),
        "{printed}"
    );
}

#[test]
fn commands_refuse_unreadable_invalid_and_mismatched_input() {
    let fixture = Fixture::new();
    let message = fixture.run_failure(&["question-contracts", "apply", "--input-file"]);
    assert!(!message.is_empty());

    let printed = fixture.run(&[
        "question-contracts",
        "apply",
        "--input-file",
        "/nonexistent/qc.json",
    ]);
    assert_eq!(printed.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&printed.stderr).contains("cannot read JSON"));

    let printed = fixture.run_failure_str(
        r#"{"operation":"validate","state":[],"input":{},"now":"2026-06-01T00:00:00.000Z"}"#,
    );
    assert!(printed.contains("Input JSON is invalid"), "{printed}");

    let printed = fixture.run_failure_str(
        r#"{"operation":"nope","state":{"questions":[]},"input":{},"now":"2026-06-01T00:00:00.000Z"}"#,
    );
    assert!(
        printed.contains("does not match the requested action"),
        "{printed}"
    );

    let printed = fixture.run_failure_str(
        r#"{"operation":"validate","state":{"questions":[]},"input":{},"now":"","live_jobs":[]}"#,
    );
    assert!(printed.contains("Invalid expires_at"), "{printed}");

    let printed = fixture.run_failure_str(
        r#"{"operation":"validate","state":{"questions":[]},"input":{},"now":"not-a-clock","live_jobs":[]}"#,
    );
    assert!(printed.contains("Invalid expires_at"), "{printed}");

    let printed = fixture.run_failure_str(
        r#"{"operation":"validate","state":{"questions":[]},"input":{},"now":"2026-06-01T00:00:00.000Z","extra":1}"#,
    );
    assert!(printed.contains("Input JSON is invalid"), "{printed}");

    let printed = fixture.run_failure_str(
        r#"{"operation":"question","state":{"questions":[]},"input":"nope","now":"2026-06-01T00:00:00.000Z"}"#,
    );
    assert!(printed.contains("Input JSON is invalid"), "{printed}");
}

#[test]
fn commands_accept_a_utf8_bom_like_the_dashboard_cli() {
    let fixture = Fixture::new();
    let document = create_document();
    fixture.write("bom.json", &format!("\u{feff}{document}"));
    let output = fixture.run(&[
        "question-contracts",
        "apply",
        "--input-file",
        &fixture.path("bom.json"),
    ]);
    assert!(output.status.success(), "{}", public_output(&output));
    let printed: serde_json::Value = serde_json::from_str(stdout(&output).trim()).unwrap();
    assert_eq!(
        printed["question_contracts"]["cards"]["Q1"]["fingerprint"],
        "c91e69d74a2d58210c82fcf930f379af81d7143a19e4676894090faa862afe37"
    );
}

#[test]
fn large_integers_never_serialise_as_floats() {
    let fixture = Fixture::new();
    let document = format!(
        r#"{{"operation":"question","state":{{"questions":[]}},"input":{{"id":"Q1","question":"q","decision":{{"kind":"approval","target":{{"task_id":"T1","action_id":"publish-fixture","revision":"target-v1"}},"choices":[{{"id":"a","label":"x"}},{{"id":"b","label":"y"}}],"diff":"d","impact":"i","conditions":"c","cost":{{"currency":"USD","max":9007199254740991}}}}}},"now":"{NOW}"}}"#
    );
    let raw = fixture.run_raw(&document);
    assert!(raw.contains("9007199254740991"), "{raw}");
    assert!(!raw.contains("9007199254740991.0"), "{raw}");
    assert!(!raw.contains("9.007199254740991e15"), "{raw}");
}

#[test]
fn validate_normalizes_persisted_snapshots_before_fingerprinting() {
    let fixture = Fixture::new();
    let created = fixture.run_json(&create_document());
    let mut state = serde_json::json!({
        "question_contracts": created["question_contracts"],
        "questions": created["questions"],
    });
    // JavaScript JSON.parse turns 5.0 into the same Number as 5, and
    // JSON.stringify emits "5" when checking the stored fingerprint.
    state["question_contracts"]["cards"]["Q1"]["snapshot"]["decision"]["cost"]["max"] =
        serde_json::json!(5.0);

    let request =
        format!(r#"{{"operation":"validate","state":{state},"input":{{}},"now":"{NOW}"}}"#);
    let validated = fixture.run_json(&request);
    assert_eq!(validated["valid"], true, "{validated}");
}

#[test]
fn revise_drops_the_current_card_history_from_its_superseded_snapshot() {
    let fixture = Fixture::new();
    let created = fixture.run_json(&create_document());
    let state = serde_json::json!({
        "question_contracts": created["question_contracts"],
        "questions": created["questions"],
    });
    let decision: serde_json::Value = serde_json::from_str(APPROVAL).unwrap();
    let request = serde_json::json!({
        "operation": "question",
        "state": state,
        "input": {
            "id": "Q1",
            "question": "改訂後の質問ですか？",
            "decision": decision,
            "action": "revise",
            "expected_revision": 1,
        },
        "now": NOW,
    });
    let revised = fixture.run_json(&request.to_string());
    assert!(revised["question_contracts"]["cards"]["Q1"]["history"][0]
        .get("history")
        .is_none());

    let state = serde_json::json!({
        "question_contracts": revised["question_contracts"],
        "questions": revised["questions"],
    });
    let validated = fixture.run_json(&format!(
        r#"{{"operation":"validate","state":{state},"input":{{}},"now":"{NOW}"}}"#
    ));
    assert_eq!(validated["valid"], true, "{validated}");
}

#[test]
fn explicit_null_question_contract_extension_is_invalid() {
    let fixture = Fixture::new();
    let request = format!(
        r#"{{"operation":"validate","state":{{"question_contracts":null,"questions":[]}},"input":{{}},"now":"{NOW}"}}"#
    );
    let printed = fixture.run_failure_str(&request);
    assert!(
        printed.contains("Unknown question contract field"),
        "{printed}"
    );
}

#[test]
fn approval_cost_requires_an_explicit_max_field() {
    let fixture = Fixture::new();
    let mut decision: serde_json::Value = serde_json::from_str(APPROVAL).unwrap();
    decision["cost"].as_object_mut().unwrap().remove("max");
    let request = serde_json::json!({
        "operation": "question",
        "state": { "questions": [] },
        "input": {
            "id": "Q1",
            "question": "公開しますか？",
            "decision": decision,
        },
        "now": NOW,
    });
    let printed = fixture.run_failure_str(&request.to_string());
    assert!(
        printed.contains("Cost requires USD and a nonnegative limit or null"),
        "{printed}"
    );
}

#[test]
fn date_only_expiry_is_normalized_as_utc() {
    let fixture = Fixture::new();
    let mut decision: serde_json::Value = serde_json::from_str(APPROVAL).unwrap();
    decision["expires_at"] = serde_json::json!("2026-06-01");
    let request = serde_json::json!({
        "operation": "question",
        "state": { "questions": [] },
        "input": {
            "id": "Q1",
            "question": "公開しますか？",
            "decision": decision,
        },
        "now": NOW,
    });
    let created = fixture.run_json(&request.to_string());
    assert_eq!(
        created["question_contracts"]["cards"]["Q1"]["snapshot"]["decision"]["expires_at"],
        "2026-06-01T00:00:00.000Z"
    );
}

#[test]
fn question_mutations_use_the_request_timestamp() {
    let fixture = Fixture::new();
    let created = fixture.run_json(&create_document());
    let card = &created["question_contracts"]["cards"]["Q1"];
    assert_eq!(card["created_at"], NOW);
    assert_eq!(card["updated_at"], NOW);
    assert_eq!(created["questions"][0]["created_at"], NOW);
}

#[test]
fn legacy_answer_updates_the_question_record() {
    let fixture = Fixture::new();
    let request = serde_json::json!({
        "operation": "answer",
        "state": { "questions": [{ "id": "legacy", "question": "旧形式", "answer": null }] },
        "input": { "id": "legacy", "answer": "回答" },
        "now": NOW,
    });
    let output = fixture.run_json(&request.to_string());
    assert_eq!(output["questions"][0]["answer"], "回答");
    assert_eq!(output["questions"][0]["answered_at"], NOW);
}

#[test]
fn validate_rejects_missing_answer_fields() {
    let fixture = Fixture::new();
    let created = fixture.run_json(&create_document());
    let mut state = serde_json::json!({
        "question_contracts": created["question_contracts"],
        "questions": created["questions"],
    });
    state["question_contracts"]["cards"]["Q1"]
        .as_object_mut()
        .unwrap()
        .remove("answer");
    let missing_answer =
        format!(r#"{{"operation":"validate","state":{state},"input":{{}},"now":"{NOW}"}}"#);
    let printed = fixture.run_failure_str(&missing_answer);
    assert!(
        printed.contains("Invalid question contract answer"),
        "{printed}"
    );

    let created = fixture.run_json(&create_document());
    let card = &created["question_contracts"]["cards"]["Q1"];
    let answer = serde_json::json!({
        "operation": "answer",
        "state": {
            "question_contracts": created["question_contracts"],
            "questions": created["questions"],
        },
        "input": {
            "id": "Q1",
            "answer": "保留",
            "choice_id": null,
            "expected_revision": 1,
            "contract_fingerprint": card["fingerprint"],
        },
        "now": NOW,
    });
    let answered = fixture.run_json(&answer.to_string());
    let mut state = serde_json::json!({
        "question_contracts": answered["question_contracts"],
        "questions": answered["questions"],
    });
    state["question_contracts"]["cards"]["Q1"]["answer"]
        .as_object_mut()
        .unwrap()
        .remove("choice_id");
    let missing_choice =
        format!(r#"{{"operation":"validate","state":{state},"input":{{}},"now":"{NOW}"}}"#);
    let printed = fixture.run_failure_str(&missing_choice);
    assert!(
        printed.contains("Invalid question contract answer"),
        "{printed}"
    );
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("rdsh-question-{suffix}"));
        std::fs::create_dir_all(root.join("dsh")).unwrap();
        Self { root }
    }

    fn path(&self, name: &str) -> String {
        self.root.join(name).to_string_lossy().into_owned()
    }

    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.root.join(name), text).unwrap();
    }

    /// The action a document means: `question` and `answer` both run through
    /// `apply`, while `validate` and `public` name themselves.
    fn action_of(document: &str) -> &'static str {
        match serde_json::from_str::<serde_json::Value>(document)
            .expect("fixture documents are JSON")["operation"]
            .as_str()
            .expect("fixture documents declare an operation")
        {
            "validate" => "validate",
            "public" => "public",
            _ => "apply",
        }
    }

    /// Run the inline document through its CLI action and parse stdout.
    fn run_json(&self, document: &str) -> serde_json::Value {
        serde_json::from_str(&self.run_raw(document)).expect("stdout is JSON")
    }

    /// Run the inline document and return raw stdout, preserving key order.
    fn run_raw(&self, document: &str) -> String {
        self.write("inline.json", document);
        let output = self.run(&[
            "question-contracts",
            Self::action_of(document),
            "--input-file",
            &self.path("inline.json"),
        ]);
        assert!(output.status.success(), "{}", public_output(&output));
        stdout(&output)
    }

    /// Run an inline document that must fail, returning the combined output.
    fn run_failure_str(&self, document: &str) -> String {
        self.write("failure.json", document);
        let output = self.run(&[
            "question-contracts",
            Self::action_of(document),
            "--input-file",
            &self.path("failure.json"),
        ]);
        assert_eq!(output.status.code(), Some(1), "{}", public_output(&output));
        assert!(stdout(&output).is_empty(), "{}", public_output(&output));
        public_output(&output)
    }

    fn run_failure(&self, args: &[&str]) -> String {
        let output = self.run(args);
        assert_ne!(output.status.code(), Some(0), "{}", public_output(&output));
        public_output(&output)
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
