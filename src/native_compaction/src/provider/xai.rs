//! xAI の圧縮。/responses/compact を単独で呼ぶ形だけがある。
//!
//! 窓に収まっていない会話は救えない。送る前に、呼ぶ側が大きさを確かめる。

use serde_json::{json, Value};

use super::{is_compaction, responses_usage, NativeError, RequestParts};
use crate::record::Usage;

/// 単独で呼ぶ時のパス。
pub const COMPACT_PATH: &str = "/responses/compact";

/// /responses/compact に送る本文を作る。
pub fn standalone_request(model: &str, input: Vec<Value>) -> RequestParts {
    RequestParts {
        path: COMPACT_PATH,
        headers: Vec::new(),
        body: json!({ "model": model, "input": input }),
    }
}

/// /responses/compact が返した圧縮結果。
#[derive(Debug, Clone, PartialEq)]
pub struct Compaction {
    /// 圧縮結果の項目。次のリクエストの先頭に、そのまま置く。
    pub item: Value,
    /// 圧縮の呼び出しの使用量。
    pub usage: Option<Usage>,
    /// 圧縮結果にまとめられたメッセージの数。
    pub dropped_message_count: Option<u64>,
}

/// /responses/compact の応答を読む。output には、圧縮結果が 1 つだけ入っている決まり。
pub fn read_standalone(response: &Value) -> Result<Compaction, NativeError> {
    let output = response
        .get("output")
        .and_then(Value::as_array)
        .ok_or(NativeError::MissingField("output"))?;
    let item = match output.as_slice() {
        [item] => item,
        _ => return Err(NativeError::UnexpectedShape("output")),
    };
    if !is_compaction(item) {
        return Err(NativeError::NoCompactionItem);
    }
    if item
        .get("encrypted_content")
        .and_then(Value::as_str)
        .is_none()
    {
        return Err(NativeError::MissingField("encrypted_content"));
    }
    Ok(Compaction {
        item: item.clone(),
        usage: responses_usage(response),
        dropped_message_count: response
            .get("usage")
            .and_then(|usage| usage.get("dropped_message_count"))
            .and_then(Value::as_u64),
    })
}

/// 次のリクエストの input を作る。圧縮結果を先頭に置き、新しい項目はその後ろにだけ足す。
pub fn next_input(item: Value, new_items: Vec<Value>) -> Vec<Value> {
    let mut input = vec![item];
    input.extend(new_items);
    input
}

#[cfg(test)]
mod tests {
    use super::*;

    /// xAI のドキュメントに載っている応答の例。
    fn documented_response() -> Value {
        json!({
            "id": "cmp_01HZ9P0V8M2YQK3F7C4G6N5R2A",
            "object": "response.compaction",
            "created_at": 1748895600,
            "model": "grok-4.7",
            "output": [
                {
                    "type": "compaction",
                    "id": "cmp_01HZ9P0V8M2YQK3F7C4G6N5R2A",
                    "encrypted_content": "<opaque blob>"
                }
            ],
            "usage": {
                "input_tokens": 12000,
                "input_tokens_details": { "cached_tokens": 0 },
                "output_tokens": 800,
                "output_tokens_details": { "reasoning_tokens": 240 },
                "total_tokens": 12800,
                "dropped_message_count": 45
            }
        })
    }

    #[test]
    fn documented_response_is_read() {
        let compaction = read_standalone(&documented_response()).unwrap();
        assert_eq!(compaction.item["encrypted_content"], json!("<opaque blob>"));
        assert_eq!(compaction.dropped_message_count, Some(45));
        assert_eq!(
            compaction.usage,
            Some(Usage {
                input: 12000,
                output: 800,
                cache_read: Some(0),
                cache_write: None
            })
        );
    }

    #[test]
    fn compaction_item_goes_first_and_unchanged() {
        let compaction = read_standalone(&documented_response()).unwrap();
        let item = compaction.item.clone();
        let input = next_input(
            compaction.item,
            vec![json!({ "role": "user", "content": "next" })],
        );
        assert_eq!(input.len(), 2);
        assert_eq!(input[0], item);
        assert_eq!(input[1]["content"], json!("next"));
    }

    #[test]
    fn output_with_more_than_one_item_is_refused() {
        let mut response = documented_response();
        response["output"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "role": "user", "content": "extra" }));
        assert_eq!(
            read_standalone(&response),
            Err(NativeError::UnexpectedShape("output"))
        );
    }

    #[test]
    fn item_without_encrypted_content_is_refused() {
        let response = json!({ "output": [{ "type": "compaction", "id": "cmp_1" }] });
        assert_eq!(
            read_standalone(&response),
            Err(NativeError::MissingField("encrypted_content"))
        );
    }
}
