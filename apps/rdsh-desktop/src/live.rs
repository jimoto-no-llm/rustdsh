//! Live connections: the host-wide event stream and the followed conversation.
//!
//! Two background threads keep sockets open and forward what they see:
//!   * events:  the $events logical stream (approvals, questions, list activity)
//!   * follow:  the selected conversation (assistant deltas, durable events)
//!
//! Unary calls (cancel, approve, answer, create, selectModel) stay on the caller
//! so no command channel is needed for them.
//!
//! Both threads survive a host restart or a short drop: a lost socket is retried
//! with an exponential backoff instead of ending the stream for the rest of the
//! run, and each attempt is reported as a note the UI can show.

use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::mux::Mux;

/// First retry delay.
pub const BACKOFF_INITIAL_MS: u64 = 500;
/// Largest retry delay.
pub const BACKOFF_CAP_MS: u64 = 10_000;

/// Retry ceiling for one attempt: 500 ms doubling, then the 10 s cap. This is
/// deterministic so the schedule can be tested; jittered() spreads the actual
/// delay inside the ceiling.
pub fn backoff_ceiling(attempt: u32) -> Duration {
    let shift = attempt.min(5);
    Duration::from_millis((BACKOFF_INITIAL_MS << shift).min(BACKOFF_CAP_MS))
}

/// Spread one retry over the lower half of its ceiling, so independent clients
/// do not retry in lockstep. entropy is only a seed, so tests can pin it.
pub fn jittered(ceiling: Duration, entropy: u64) -> Duration {
    let millis = ceiling.as_millis() as u64;
    let floor = millis / 2;
    Duration::from_millis(floor + entropy % (millis - floor + 1))
}

/// One retry delay taken from the real clock.
pub fn next_delay(attempt: u32) -> Duration {
    jittered(backoff_ceiling(attempt), entropy())
}

fn entropy() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0)
}

/// One selectable answer offered with a question.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

/// One question of a user-questions/request waterfall.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Question {
    /// Caller-provided question id; echo it in the answer.
    pub id: String,
    /// The question to display.
    pub question: String,
    /// Optional short heading/group label.
    pub header: Option<String>,
    /// Optional supporting detail, not part of the option labels.
    pub detail: Option<String>,
    /// Choices the UI can render, each with its optional description.
    pub options: Vec<QuestionOption>,
    /// Whether more than one option may be selected.
    pub multi_select: bool,
    /// Whether the UI may add a free-text Other answer. The current host does
    /// not send this field and the reference UI always offers one, so it
    /// defaults to true; a future host can turn it off with allowCustom.
    pub allow_custom: bool,
}

/// One pending decision the host is waiting on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pending {
    Approval {
        event_id: String,
        tool: String,
        reason: String,
    },
    Question {
        /// Waterfall id, usable with $events/result while the request is live.
        event_id: String,
        /// Tool call that owns the wait; echo it in userQuestions/answer.
        call_id: String,
        /// Agent/session id from the waterfall frame.
        session_id: String,
        /// Every question of the waterfall, in order; answer each by its id.
        questions: Vec<Question>,
        /// First question text, kept for the existing single-line banner.
        question: String,
        /// First question option labels, kept for the existing banner.
        options: Vec<String>,
        /// First question multiSelect, kept for the existing banner.
        multi: bool,
    },
}

#[derive(Clone, Debug)]
pub enum LiveEvent {
    Ready(String),
    Pending(Pending),
    Dismissed(String),
    Delta(String),
    Activity,
    Idle,
    Note(String),
    Closed(String),
}

/// Commands for the live threads. The app owns the sending half so the poller
/// can create the threads once the session cookie exists.
#[derive(Clone, Debug)]
pub enum LiveCmd {
    Follow(String),
}

/// Start the live threads; they report through the supplied sender.
pub fn spawn(origin: &str, cookie: &str, commands: Receiver<LiveCmd>, event_tx: Sender<LiveEvent>) {
    let events_origin = origin.to_string();
    let events_cookie = cookie.to_string();
    let events_out = event_tx.clone();
    std::thread::spawn(move || run_events(&events_origin, &events_cookie, &events_out));

    let follow_origin = origin.to_string();
    let follow_cookie = cookie.to_string();
    let follow_out = event_tx;
    std::thread::spawn(move || {
        run_follow(&follow_origin, &follow_cookie, &commands, &follow_out);
    });
}

/// Read a waterfall item value from $events into the pending decision it
/// carries. A waterfall this client does not answer yields None.
pub fn parse_waterfall(value: &Value) -> Option<Pending> {
    let name = value
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let event_id = field(value, "eventId");
    let agent_id = field(value, "agentId");
    let request = value.get("request").cloned().unwrap_or(Value::Null);
    match name {
        "approval/request" => Some(Pending::Approval {
            event_id,
            tool: {
                let tool = field(&request, "toolName");
                if tool.is_empty() {
                    "tool".to_string()
                } else {
                    tool
                }
            },
            reason: request
                .get("displayReason")
                .or_else(|| request.get("reason"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        "user-questions/request" => Some(parse_questions(&event_id, &agent_id, &request)),
        _ => None,
    }
}

/// Read a whole user-questions/request into the batch of questions it asks.
///
/// The waterfall frame carries the agent id at the top level; the tool call id
/// lives in request.wait.callId (older frames may put it directly on the
/// request).
pub fn parse_questions(event_id: &str, session_id: &str, request: &Value) -> Pending {
    let questions = request
        .get("questions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, item)| parse_question(item, index))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let call_id = request
        .get("wait")
        .and_then(|wait| wait.get("callId"))
        .or_else(|| request.get("callId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let first = questions.first();
    Pending::Question {
        event_id: event_id.to_string(),
        call_id,
        session_id: session_id.to_string(),
        question: first.map(|item| item.question.clone()).unwrap_or_default(),
        options: first
            .map(|item| {
                item.options
                    .iter()
                    .map(|option| option.label.clone())
                    .collect()
            })
            .unwrap_or_default(),
        multi: first.map(|item| item.multi_select).unwrap_or(false),
        questions,
    }
}

fn parse_question(item: &Value, index: usize) -> Question {
    let options = item
        .get("options")
        .and_then(Value::as_array)
        .map(|options| options.iter().filter_map(parse_option).collect())
        .unwrap_or_default();
    Question {
        id: {
            let id = field(item, "id");
            if id.is_empty() {
                format!("q{}", index + 1)
            } else {
                id
            }
        },
        question: {
            let question = field(item, "question");
            if question.is_empty() {
                field(item, "header")
            } else {
                question
            }
        },
        header: optional(item, "header"),
        detail: optional(item, "detail"),
        options,
        multi_select: item
            .get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        allow_custom: item
            .get("allowCustom")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    }
}

fn parse_option(item: &Value) -> Option<QuestionOption> {
    let label = item
        .get("label")
        .or_else(|| item.get("header"))
        .and_then(Value::as_str)?;
    Some(QuestionOption {
        label: label.to_string(),
        description: optional(item, "description"),
    })
}

fn field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn optional(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Keep the $events stream open forever, re-opening it after any end or error
/// with an exponential backoff.
fn run_events(origin: &str, cookie: &str, out: &Sender<LiveEvent>) {
    let mut attempt: u32 = 0;
    let mut down = false;
    loop {
        // down tracks an outage, so its drop note is emitted exactly once.
        match run_events_session(origin, cookie, out, down) {
            // Reached the ready frame: the next drop is a fresh outage.
            Ok(true) => {
                attempt = 0;
                down = false;
            }
            Ok(false) => down = true,
            Err(error) => {
                if !down {
                    let _ = out.send(LiveEvent::Note(format!(
                        "イベント接続が切れました: {error}"
                    )));
                }
                down = true;
            }
        }
        let delay = next_delay(attempt);
        attempt = attempt.saturating_add(1);
        if down {
            let _ = out.send(LiveEvent::Note(format!(
                "イベント接続を再接続します ({}回目, {:.1}秒後)",
                attempt,
                delay.as_secs_f64()
            )));
        }
        std::thread::sleep(delay);
    }
}

/// One connection lifetime of the $events stream. Returns whether the ready
/// frame arrived before the host ended it; Err carries the reason it dropped.
/// The first ready frame after a drop is reported as a reconnection note.
fn run_events_session(
    origin: &str,
    cookie: &str,
    out: &Sender<LiveEvent>,
    reconnecting: bool,
) -> anyhow::Result<bool> {
    let mut mux = Mux::connect(origin, cookie)?;
    let stream = mux.open("$events", serde_json::json!({}))?;
    let mut ready = false;
    loop {
        let message = mux.read()?;
        let kind = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if kind == "error" {
            let detail = message
                .get("error")
                .map(|error| error.to_string())
                .unwrap_or_else(|| message.to_string());
            return Err(anyhow::anyhow!("{detail}"));
        }
        if kind == "end" {
            return Ok(ready);
        }
        let value = message.get("value").cloned().unwrap_or(Value::Null);
        match value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "ready" => {
                ready = true;
                if reconnecting {
                    let _ = out.send(LiveEvent::Note("イベント接続を再接続しました".to_string()));
                }
                let id = value
                    .get("clientId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let _ = out.send(LiveEvent::Ready(id));
            }
            "waterfall" => match parse_waterfall(&value) {
                Some(pending) => {
                    let _ = out.send(LiveEvent::Pending(pending));
                }
                None => {
                    let name = value
                        .get("event")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let _ = out.send(LiveEvent::Note(format!("未対応の要求: {name}")));
                }
            },
            "cancel" => {
                let event_id = value
                    .get("eventId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let _ = out.send(LiveEvent::Dismissed(event_id));
            }
            "emit" => {
                let _ = out.send(LiveEvent::Activity);
            }
            _ => {}
        }
        let _ = &stream;
    }
}

/// Follow the selected conversation, reconnecting whenever its mux drops.
fn run_follow(origin: &str, cookie: &str, commands: &Receiver<LiveCmd>, out: &Sender<LiveEvent>) {
    let mut current: Option<String> = None;
    let mut following: Option<String> = None;
    let mut mux: Option<Mux> = None;
    let mut stream = String::new();
    let mut attempt: u32 = 0;
    loop {
        // Apply pending commands without blocking the socket read for long.
        while let Ok(command) = commands.try_recv() {
            let LiveCmd::Follow(session) = command;
            current = Some(session);
        }
        if current != following {
            // (re)open for the requested session
            if let Some(session) = current.clone() {
                match follow_open(origin, cookie, &session) {
                    Ok((new_mux, new_stream)) => {
                        mux = Some(new_mux);
                        stream = new_stream;
                        following = Some(session);
                        if attempt > 0 {
                            let _ = out.send(LiveEvent::Note(
                                "会話ストリームを再接続しました".to_string(),
                            ));
                        }
                        attempt = 0;
                        let _ = out.send(LiveEvent::Activity);
                    }
                    Err(error) => {
                        following = None;
                        let delay = next_delay(attempt);
                        if attempt == 0 {
                            let _ =
                                out.send(LiveEvent::Note(format!("会話に接続できません: {error}")));
                        }
                        attempt = attempt.saturating_add(1);
                        std::thread::sleep(delay);
                        continue;
                    }
                }
            } else {
                mux = None;
                stream.clear();
                following = None;
            }
        }

        let Some(active) = mux.as_mut() else {
            std::thread::sleep(Duration::from_millis(120));
            continue;
        };
        match active.try_read() {
            Ok(Some(message)) => {
                let kind = message
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if kind == "error" {
                    let _ = out.send(LiveEvent::Note(format!(
                        "会話ストリーム: {}",
                        message
                            .get("error")
                            .map(|error| error.to_string())
                            .unwrap_or_default()
                    )));
                    mux = None;
                    stream.clear();
                    following = None;
                    continue;
                }
                if kind == "end" {
                    let _ = out.send(LiveEvent::Idle);
                    mux = None;
                    stream.clear();
                    following = None;
                    // A normal end reconnects promptly; only open failures back off.
                    attempt = 0;
                    continue;
                }
                let value = message.get("value").cloned().unwrap_or(Value::Null);
                match value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "assistant-stream" => {
                        let frame = value.get("frame").cloned().unwrap_or(Value::Null);
                        match frame.get("type").and_then(Value::as_str) {
                            Some("chunk") => {
                                let mut text = String::new();
                                crate::app::collect_text(
                                    frame.get("chunk").unwrap_or(&Value::Null),
                                    &mut text,
                                );
                                if !text.is_empty() {
                                    let _ = out.send(LiveEvent::Delta(text));
                                }
                            }
                            Some("end") => {
                                let _ = out.send(LiveEvent::Idle);
                            }
                            _ => {}
                        }
                    }
                    "event" => {
                        let _ = out.send(LiveEvent::Activity);
                    }
                    _ => {}
                }
            }
            Ok(None) => {}
            Err(error) => {
                let _ = out.send(LiveEvent::Closed(error.to_string()));
                mux = None;
                stream.clear();
                following = None;
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        let _ = stream.as_str();
    }
}

fn follow_open(origin: &str, cookie: &str, session: &str) -> anyhow::Result<(Mux, String)> {
    let mut mux = Mux::connect(origin, cookie)?;
    mux.set_read_timeout(Duration::from_millis(300))?;
    let address = serde_json::json!({ "kind": "session", "sessionId": session });
    let stream = mux.open(
        "session/follow",
        serde_json::json!({
            "request": { "address": address, "maxMessages": 40, "assistantStream": true }
        }),
    )?;
    // The opening snapshot arrives first; report it as activity so the caller
    // loads the durable timeline.
    let _opening = mux.read()?;
    Ok((mux, stream))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn backoff_doubles_from_500ms_then_caps_at_10s() {
        assert_eq!(backoff_ceiling(0), ms(500));
        assert_eq!(backoff_ceiling(1), ms(1000));
        assert_eq!(backoff_ceiling(2), ms(2000));
        assert_eq!(backoff_ceiling(3), ms(4000));
        assert_eq!(backoff_ceiling(4), ms(8000));
        assert_eq!(backoff_ceiling(5), ms(10_000));
        // A long outage stays at the cap instead of overflowing the shift.
        assert_eq!(backoff_ceiling(40), ms(10_000));
    }

    #[test]
    fn jitter_stays_between_half_and_the_ceiling() {
        let ceiling = ms(8000);
        for entropy in [0, 1, 1234, u64::MAX] {
            let delay = jittered(ceiling, entropy);
            assert!(delay >= ms(4000) && delay <= ceiling, "{delay:?}");
        }
        // The seed is pinned, so both edges are deterministic.
        assert_eq!(jittered(ms(500), 0), ms(250));
        assert_eq!(jittered(ms(500), 250), ms(500));
    }

    #[test]
    fn parses_an_approval_waterfall() {
        // Frame shape from protocol.md section 2.9.
        let frame = serde_json::json!({
            "type": "waterfall",
            "event": "approval/request",
            "eventId": "evt-approval",
            "agentId": "agent-7",
            "request": {
                "toolName": "bash",
                "callId": "call-9",
                "reason": "needs to run a command",
                "displayReason": "Delete the build directory"
            }
        });
        assert_eq!(
            parse_waterfall(&frame),
            Some(Pending::Approval {
                event_id: "evt-approval".to_string(),
                tool: "bash".to_string(),
                reason: "Delete the build directory".to_string(),
            })
        );
    }

    #[test]
    fn approval_falls_back_to_reason_and_generic_tool() {
        let frame = serde_json::json!({
            "event": "approval/request",
            "eventId": "evt-1",
            "agentId": "agent-1",
            "request": { "reason": "why" }
        });
        assert_eq!(
            parse_waterfall(&frame),
            Some(Pending::Approval {
                event_id: "evt-1".to_string(),
                tool: "tool".to_string(),
                reason: "why".to_string(),
            })
        );
    }

    #[test]
    fn parses_every_question_of_a_waterfall() {
        // Shape from protocol.md section 2.9 / AskUserQuestionRequestEvent: the
        // agent id is on the frame, the tool call id is under request.wait.
        let frame = serde_json::json!({
            "type": "waterfall",
            "event": "user-questions/request",
            "eventId": "evt-question",
            "agentId": "session-9",
            "request": {
                "questions": [
                    {
                        "id": "q1",
                        "question": "Which database should I use?",
                        "header": "Storage",
                        "options": [
                            { "label": "Postgres", "description": "Relational and mature" },
                            { "label": "SQLite" }
                        ]
                    },
                    {
                        "id": "q2",
                        "question": "Which features?",
                        "header": "Scope",
                        "detail": "Pick every feature in this release.",
                        "multiSelect": true,
                        "options": [
                            { "label": "Auth" },
                            { "label": "Billing", "description": "Stripe checkout" }
                        ]
                    }
                ],
                "wait": { "callId": "call-42", "timed": true }
            }
        });
        let Pending::Question {
            event_id,
            call_id,
            session_id,
            questions,
            question,
            options,
            multi,
        } = parse_waterfall(&frame).expect("a question waterfall")
        else {
            panic!("expected Pending::Question");
        };
        assert_eq!(event_id, "evt-question");
        assert_eq!(call_id, "call-42");
        assert_eq!(session_id, "session-9");
        assert_eq!(questions.len(), 2);

        let first = &questions[0];
        assert_eq!(first.id, "q1");
        assert_eq!(first.question, "Which database should I use?");
        assert_eq!(first.header.as_deref(), Some("Storage"));
        assert_eq!(first.detail, None);
        assert!(!first.multi_select);
        assert!(first.allow_custom);
        assert_eq!(
            first.options,
            vec![
                QuestionOption {
                    label: "Postgres".to_string(),
                    description: Some("Relational and mature".to_string()),
                },
                QuestionOption {
                    label: "SQLite".to_string(),
                    description: None,
                },
            ]
        );

        let second = &questions[1];
        assert_eq!(second.id, "q2");
        assert_eq!(second.header.as_deref(), Some("Scope"));
        assert_eq!(
            second.detail.as_deref(),
            Some("Pick every feature in this release.")
        );
        assert!(second.multi_select);
        assert_eq!(
            second.options[1].description.as_deref(),
            Some("Stripe checkout")
        );

        // The single-line banner still gets the first question.
        assert_eq!(question, "Which database should I use?");
        assert_eq!(options, vec!["Postgres".to_string(), "SQLite".to_string()]);
        assert!(!multi);
    }

    #[test]
    fn honours_allow_custom_and_names_questions_without_ids() {
        let request = serde_json::json!({
            "questions": [
                { "question": "First?", "allowCustom": false, "options": [{ "label": "Yes" }] },
                { "header": "Second", "multiSelect": true }
            ],
            "callId": "call-legacy"
        });
        let Pending::Question {
            call_id, questions, ..
        } = parse_questions("evt", "agent", &request)
        else {
            panic!("expected Pending::Question");
        };
        // Older frames may carry callId directly on the request.
        assert_eq!(call_id, "call-legacy");
        assert_eq!(questions[0].id, "q1");
        assert!(!questions[0].allow_custom);
        assert_eq!(questions[1].id, "q2");
        // A question with no text falls back to its header.
        assert_eq!(questions[1].question, "Second");
        assert!(questions[1].multi_select);
    }

    #[test]
    fn ignores_waterfalls_a_client_does_not_answer() {
        let frame = serde_json::json!({
            "type": "waterfall",
            "event": "some/other-request",
            "eventId": "evt-x",
            "agentId": "agent-x",
            "request": {}
        });
        assert_eq!(parse_waterfall(&frame), None);
    }
}
