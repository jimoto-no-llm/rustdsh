//! Anthropic の Messages API の圧縮。
//!
//! 形は 2 つある。
//! リクエストに compact_20260112 を付けておき、サーバーにしきい値で圧縮させる形。
//! 要約だけを返させるリクエストを単独で送る形。

use serde_json::{json, Map, Value};

use super::{is_compaction, Header, NativeError, RequestParts};
use crate::record::Usage;

/// ベータの機能を使う時のヘッダーの名前。
pub const BETA_HEADER: &str = "anthropic-beta";
/// しきい値の形のヘッダーの値。
pub const THRESHOLD_BETA: &str = "compact-2026-01-12";
/// 単独で呼ぶ形のヘッダーの値。署名つきのブロックを持つ、後のリクエストにも毎回付ける。
pub const ON_DEMAND_BETA: &str = "compact-2026-09-04";
/// Messages API のパス。
pub const MESSAGES_PATH: &str = "/messages";
/// しきい値の形で、発動に指定できる最小の入力トークン数。
pub const MIN_TRIGGER: u64 = 50_000;
/// 単独で呼ぶ形で、指示に書ける最大の文字数。
pub const MAX_INSTRUCTION_CHARS: usize = 16_384;

const THRESHOLD_EDIT: &str = "compact_20260112";

/// しきい値の形の設定。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ThresholdOptions {
    /// 発動する入力トークン数。None の時は API の既定（150,000）になる。
    pub trigger_input_tokens: Option<u64>,
    /// 要約を作った所で止めるか。
    pub pause_after_compaction: bool,
    /// 要約の指示。入れると、API の既定の指示を丸ごと置き換える。
    pub instructions: Option<String>,
}

/// Messages API のリクエストの本文に、しきい値での圧縮を付ける。
///
/// すでに同じ種類の設定が入っている時は、新しいもので置き換える。
/// 返すのは、リクエストに足すヘッダー。
pub fn enable_threshold(
    body: &mut Value,
    options: &ThresholdOptions,
) -> Result<Header, NativeError> {
    if let Some(value) = options.trigger_input_tokens {
        if value < MIN_TRIGGER {
            return Err(NativeError::TriggerTooSmall {
                min: MIN_TRIGGER,
                actual: value,
            });
        }
    }
    let object = body.as_object_mut().ok_or(NativeError::BodyNotObject)?;
    if object.contains_key("compaction") {
        return Err(NativeError::FieldNotAllowed("compaction"));
    }

    let mut edit = Map::new();
    edit.insert("type".to_string(), json!(THRESHOLD_EDIT));
    if let Some(value) = options.trigger_input_tokens {
        edit.insert(
            "trigger".to_string(),
            json!({ "type": "input_tokens", "value": value }),
        );
    }
    if options.pause_after_compaction {
        edit.insert("pause_after_compaction".to_string(), json!(true));
    }
    if let Some(text) = &options.instructions {
        check_instructions_text(text, None)?;
        edit.insert("instructions".to_string(), json!(text));
    }

    let management = object
        .entry("context_management")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or(NativeError::UnexpectedShape("context_management"))?;
    let edits = management
        .entry("edits")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or(NativeError::UnexpectedShape("context_management.edits"))?;
    edits.retain(|existing| existing.get("type").and_then(Value::as_str) != Some(THRESHOLD_EDIT));
    edits.push(Value::Object(edit));
    Ok((BETA_HEADER, THRESHOLD_BETA))
}

/// しきい値の形の応答を読んだ結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThresholdOutcome {
    /// 圧縮は起きていない。
    NotCompacted,
    /// 圧縮が起きて、要約ができた。応答をそのまま履歴に足して続ける。
    Compacted { paused: bool },
    /// 圧縮が起きたが、要約はできなかった。元のメッセージを残して続ける。
    NoSummary { paused: bool },
}

/// しきい値の形の応答を読む。
///
/// 見るのは圧縮のブロックで、stop_reason ではない。
/// 要約が止められた時は、stop_reason が refusal になるため。
pub fn read_threshold(response: &Value) -> Result<ThresholdOutcome, NativeError> {
    let content = response
        .get("content")
        .and_then(Value::as_array)
        .ok_or(NativeError::MissingField("content"))?;
    let paused = response.get("stop_reason").and_then(Value::as_str) == Some("compaction");
    match content.iter().find(|block| is_compaction(block)) {
        None => Ok(ThresholdOutcome::NotCompacted),
        Some(block) => {
            if block.get("content").is_none_or(Value::is_null) {
                Ok(ThresholdOutcome::NoSummary { paused })
            } else {
                Ok(ThresholdOutcome::Compacted { paused })
            }
        }
    }
}

/// 要約だけを返させるリクエストを作る。
///
/// body には、会話を今のまま入れる。model、max_tokens、system、tools、messages をそのまま使う。
/// 一緒に送れない欄が入っている時は、黙って外さずにエラーを返す。
pub fn on_demand_request(
    body: Value,
    instructions: Option<&str>,
) -> Result<RequestParts, NativeError> {
    let mut body = body;
    let object = body.as_object_mut().ok_or(NativeError::BodyNotObject)?;
    if object.contains_key("context_management") {
        return Err(NativeError::FieldNotAllowed("context_management"));
    }
    if object.contains_key("stop_sequences") {
        return Err(NativeError::FieldNotAllowed("stop_sequences"));
    }
    let tool_choice = object
        .get("tool_choice")
        .and_then(|choice| choice.get("type"))
        .and_then(Value::as_str);
    if matches!(tool_choice, Some("any") | Some("tool")) {
        return Err(NativeError::FieldNotAllowed("tool_choice"));
    }
    let has_format = object
        .get("output_config")
        .and_then(|config| config.get("format"))
        .is_some();
    if has_format {
        return Err(NativeError::FieldNotAllowed("output_config.format"));
    }

    let mut compaction = Map::new();
    compaction.insert("type".to_string(), json!("summarize"));
    if let Some(text) = instructions {
        check_instructions_text(text, Some(MAX_INSTRUCTION_CHARS))?;
        compaction.insert("instructions".to_string(), json!(text));
    }
    object.insert("compaction".to_string(), Value::Object(compaction));
    Ok(RequestParts {
        path: MESSAGES_PATH,
        headers: vec![(BETA_HEADER, ON_DEMAND_BETA)],
        body,
    })
}

/// 単独で呼ぶ形の応答を読んだ結果。
#[derive(Debug, Clone, PartialEq)]
pub enum OnDemandOutcome {
    /// 要約ができた。block は、署名ごとそのまま持っておく。
    Summary { block: Value, usage: Option<Usage> },
    /// 要約ができなかった。stop_reason は、API が返した理由。この時も課金はされる。
    NoSummary {
        stop_reason: String,
        usage: Option<Usage>,
    },
}

/// 単独で呼ぶ形の応答を読む。先に stop_reason を見てから、ブロックを探す。
pub fn read_on_demand(response: &Value) -> Result<OnDemandOutcome, NativeError> {
    let stop_reason = response
        .get("stop_reason")
        .and_then(Value::as_str)
        .ok_or(NativeError::MissingField("stop_reason"))?;
    let usage = compaction_usage(response);
    if stop_reason != "compaction" {
        return Ok(OnDemandOutcome::NoSummary {
            stop_reason: stop_reason.to_string(),
            usage,
        });
    }
    let content = response
        .get("content")
        .and_then(Value::as_array)
        .ok_or(NativeError::MissingField("content"))?;
    let block = content
        .iter()
        .find(|block| is_compaction(block))
        .ok_or(NativeError::NoCompactionItem)?;
    if block.get("content").and_then(Value::as_str).is_none() {
        return Err(NativeError::MissingField("content[].content"));
    }
    if block.get("signature").and_then(Value::as_str).is_none() {
        return Err(NativeError::MissingField("content[].signature"));
    }
    Ok(OnDemandOutcome::Summary {
        block: block.clone(),
        usage,
    })
}

/// 次のリクエストの messages を作る。
///
/// ブロックを先頭に置く。要約されたメッセージは入れない。
/// later_messages には、要約を頼んだ後に進んだやり取りだけを入れる。
pub fn continue_from_block(block: Value, later_messages: Vec<Value>) -> Vec<Value> {
    let mut messages = vec![json!({ "role": "assistant", "content": [block] })];
    messages.extend(later_messages);
    messages
}

/// 単独で呼ぶ形の後のリクエストで、ブロックの置き方が決まりに合うかを見る。
///
/// 決まりは 2 つ。ブロックは 1 つだけ入れる。messages の先頭に置く。
/// しきい値の形には使わない。そちらは、応答をそのまま足していく決まりになっている。
pub fn check_block_placement(messages: &[Value]) -> Result<(), NativeError> {
    let mut count = 0;
    for (message_index, message) in messages.iter().enumerate() {
        let blocks = match message.get("content").and_then(Value::as_array) {
            Some(blocks) => blocks,
            None => continue,
        };
        for (block_index, block) in blocks.iter().enumerate() {
            if is_compaction(block) {
                count += 1;
                if message_index != 0 || block_index != 0 {
                    return Err(NativeError::BlockMisplaced);
                }
            }
        }
    }
    match count {
        0 => Err(NativeError::NoCompactionItem),
        1 => Ok(()),
        _ => Err(NativeError::TooManyCompactionItems),
    }
}

fn check_instructions_text(text: &str, max_chars: Option<usize>) -> Result<(), NativeError> {
    if text.trim().is_empty() {
        return Err(NativeError::InstructionsEmpty);
    }
    if let Some(max_chars) = max_chars {
        let actual = text.chars().count();
        if actual > max_chars {
            return Err(NativeError::InstructionsTooLong { max_chars, actual });
        }
    }
    Ok(())
}

/// usage.iterations の中の、圧縮の分の使用量を読む。
fn compaction_usage(response: &Value) -> Option<Usage> {
    let iterations = response.get("usage")?.get("iterations")?.as_array()?;
    let iteration = iterations
        .iter()
        .find(|iteration| is_compaction(iteration))?;
    Some(Usage {
        input: iteration.get("input_tokens")?.as_u64()?,
        output: iteration.get("output_tokens")?.as_u64()?,
        cache_read: None,
        cache_write: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_edit_is_added_with_the_beta_header() {
        let mut body = json!({ "model": "model-x", "max_tokens": 1024, "messages": [] });
        let header = enable_threshold(&mut body, &ThresholdOptions::default()).unwrap();
        assert_eq!(header, ("anthropic-beta", "compact-2026-01-12"));
        assert_eq!(
            body["context_management"],
            json!({ "edits": [{ "type": "compact_20260112" }] })
        );
    }

    #[test]
    fn threshold_options_are_written_and_other_edits_are_kept() {
        let mut body = json!({
            "context_management": {
                "edits": [
                    { "type": "clear_tool_uses_20250919" },
                    { "type": "compact_20260112", "trigger": { "type": "input_tokens", "value": 60000 } }
                ]
            }
        });
        let options = ThresholdOptions {
            trigger_input_tokens: Some(150_000),
            pause_after_compaction: true,
            instructions: Some("Keep file paths.".to_string()),
        };
        enable_threshold(&mut body, &options).unwrap();
        assert_eq!(
            body["context_management"]["edits"],
            json!([
                { "type": "clear_tool_uses_20250919" },
                {
                    "type": "compact_20260112",
                    "trigger": { "type": "input_tokens", "value": 150000 },
                    "pause_after_compaction": true,
                    "instructions": "Keep file paths."
                }
            ])
        );
    }

    #[test]
    fn threshold_below_the_minimum_is_refused() {
        let mut body = json!({});
        let options = ThresholdOptions {
            trigger_input_tokens: Some(49_999),
            ..ThresholdOptions::default()
        };
        assert_eq!(
            enable_threshold(&mut body, &options),
            Err(NativeError::TriggerTooSmall {
                min: 50_000,
                actual: 49_999
            })
        );
    }

    #[test]
    fn threshold_response_is_read_by_the_block_not_the_stop_reason() {
        let compacted = json!({
            "content": [
                { "type": "compaction", "content": "Summary of the conversation" },
                { "type": "text", "text": "Based on our conversation so far" }
            ],
            "stop_reason": "end_turn"
        });
        let paused = json!({
            "content": [{ "type": "compaction", "content": "Summary of the conversation" }],
            "stop_reason": "compaction"
        });
        let blocked = json!({
            "content": [{ "type": "compaction", "content": null }],
            "stop_reason": "refusal"
        });
        let plain =
            json!({ "content": [{ "type": "text", "text": "hello" }], "stop_reason": "end_turn" });
        assert_eq!(
            read_threshold(&compacted),
            Ok(ThresholdOutcome::Compacted { paused: false })
        );
        assert_eq!(
            read_threshold(&paused),
            Ok(ThresholdOutcome::Compacted { paused: true })
        );
        assert_eq!(
            read_threshold(&blocked),
            Ok(ThresholdOutcome::NoSummary { paused: false })
        );
        assert_eq!(read_threshold(&plain), Ok(ThresholdOutcome::NotCompacted));
    }

    #[test]
    fn on_demand_request_adds_the_compaction_field_and_header() {
        let body = json!({
            "model": "model-x",
            "max_tokens": 2048,
            "messages": [{ "role": "user", "content": "hi" }]
        });
        let parts = on_demand_request(body, None).unwrap();
        assert_eq!(parts.path, "/messages");
        assert_eq!(
            parts.headers,
            vec![("anthropic-beta", "compact-2026-09-04")]
        );
        assert_eq!(parts.body["compaction"], json!({ "type": "summarize" }));
        assert_eq!(parts.body["messages"][0]["content"], json!("hi"));
    }

    #[test]
    fn on_demand_request_refuses_fields_that_cannot_be_sent_together() {
        let with_management = json!({ "context_management": { "edits": [] } });
        let with_stop = json!({ "stop_sequences": ["END"] });
        let with_choice = json!({ "tool_choice": { "type": "any" } });
        let with_auto_choice = json!({ "tool_choice": { "type": "auto" } });
        assert_eq!(
            on_demand_request(with_management, None),
            Err(NativeError::FieldNotAllowed("context_management"))
        );
        assert_eq!(
            on_demand_request(with_stop, None),
            Err(NativeError::FieldNotAllowed("stop_sequences"))
        );
        assert_eq!(
            on_demand_request(with_choice, None),
            Err(NativeError::FieldNotAllowed("tool_choice"))
        );
        assert!(on_demand_request(with_auto_choice, None).is_ok());
    }

    #[test]
    fn on_demand_instructions_are_limited_by_characters() {
        let fits = "あ".repeat(16_384);
        let too_long = "あ".repeat(16_385);
        let parts = on_demand_request(json!({}), Some(&fits)).unwrap();
        assert_eq!(parts.body["compaction"]["instructions"], json!(fits));
        assert_eq!(
            on_demand_request(json!({}), Some(&too_long)),
            Err(NativeError::InstructionsTooLong {
                max_chars: 16_384,
                actual: 16_385
            })
        );
        assert_eq!(
            on_demand_request(json!({}), Some("  ")),
            Err(NativeError::InstructionsEmpty)
        );
    }

    /// Anthropic のドキュメントに載っている応答の例。要約の文は短くしてある。
    fn documented_response() -> Value {
        json!({
            "id": "msg_013Zva2CMHLNnXjNJJKqJ2EF",
            "type": "message",
            "role": "assistant",
            "model": "claude-opus-5-5",
            "content": [
                {
                    "type": "compaction",
                    "content": "Summary of the conversation: the user is designing the data model for a recipe app.",
                    "signature": "EuYBCkQY..."
                }
            ],
            "stop_reason": "compaction",
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
                "iterations": [{ "type": "compaction", "input_tokens": 144, "output_tokens": 276 }]
            }
        })
    }

    #[test]
    fn documented_on_demand_response_is_read() {
        let outcome = read_on_demand(&documented_response()).unwrap();
        match outcome {
            OnDemandOutcome::Summary { block, usage } => {
                assert_eq!(block["signature"], json!("EuYBCkQY..."));
                assert_eq!(
                    usage,
                    Some(Usage {
                        input: 144,
                        output: 276,
                        cache_read: None,
                        cache_write: None
                    })
                );
            }
            OnDemandOutcome::NoSummary { .. } => panic!("a summary was expected"),
        }
    }

    #[test]
    fn on_demand_response_without_a_summary_keeps_the_reason() {
        let response = json!({ "content": [], "stop_reason": "tool_use" });
        assert_eq!(
            read_on_demand(&response),
            Ok(OnDemandOutcome::NoSummary {
                stop_reason: "tool_use".to_string(),
                usage: None
            })
        );
    }

    #[test]
    fn block_goes_first_and_later_turns_follow_unchanged() {
        let block = documented_response()["content"][0].clone();
        let later = vec![
            json!({ "role": "assistant", "content": "For Recipe, use title." }),
            json!({ "role": "user", "content": "Now do the same for Ingredient." }),
        ];
        let messages = continue_from_block(block.clone(), later);
        assert_eq!(messages.len(), 3);
        assert_eq!(
            messages[0],
            json!({ "role": "assistant", "content": [block] })
        );
        assert_eq!(check_block_placement(&messages), Ok(()));
    }

    #[test]
    fn misplaced_missing_and_repeated_blocks_are_refused() {
        let block = json!({ "type": "compaction", "content": "s", "signature": "x" });
        let user = json!({ "role": "user", "content": "left in front" });
        let holder = json!({ "role": "assistant", "content": [block] });
        assert_eq!(
            check_block_placement(&[user.clone(), holder.clone()]),
            Err(NativeError::BlockMisplaced)
        );
        assert_eq!(
            check_block_placement(&[user]),
            Err(NativeError::NoCompactionItem)
        );
        let doubled = json!({ "role": "assistant", "content": [block, block] });
        assert_eq!(
            check_block_placement(&[doubled]),
            Err(NativeError::BlockMisplaced)
        );
    }
}
