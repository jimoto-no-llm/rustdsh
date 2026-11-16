//! OpenAI の Responses API の圧縮。
//!
//! 形は 2 つある。
//! リクエストに context_management を付けておき、サーバーにしきい値で圧縮させる形。
//! /responses/compact を単独で呼ぶ形。

use serde_json::{json, Value};

use super::{is_compaction, responses_usage, NativeError, RequestParts};
use crate::record::Usage;

/// 単独で呼ぶ時のパス。
pub const COMPACT_PATH: &str = "/responses/compact";

/// /responses のリクエストの本文に、しきい値での圧縮を付ける。
///
/// すでに圧縮の設定が入っている時は、新しいしきい値で置き換える。
/// ZDR で使う時は、呼ぶ側が store を false にしておく。
pub fn enable_in_stream(body: &mut Value, compact_threshold: u64) -> Result<(), NativeError> {
    let object = body.as_object_mut().ok_or(NativeError::BodyNotObject)?;
    let entry = json!({ "type": "compaction", "compact_threshold": compact_threshold });
    match object.get_mut("context_management") {
        Some(Value::Array(entries)) => {
            entries.retain(|existing| !is_compaction(existing));
            entries.push(entry);
        }
        Some(_) => return Err(NativeError::UnexpectedShape("context_management")),
        None => {
            object.insert("context_management".to_string(), Value::Array(vec![entry]));
        }
    }
    Ok(())
}

/// /responses/compact に送る本文を作る。
///
/// input には、今の窓の全部を入れる。窓に収まっている必要がある。
/// instructions は入れない。
pub fn standalone_request(model: &str, input: Vec<Value>) -> RequestParts {
    RequestParts {
        path: COMPACT_PATH,
        headers: Vec::new(),
        body: json!({ "model": model, "input": input }),
    }
}

/// /responses/compact が返した、圧縮の後の窓。
#[derive(Debug, Clone, PartialEq)]
pub struct CompactedWindow {
    /// 次のリクエストの input に、そのまま渡す。削らない。
    pub window: Vec<Value>,
    /// 圧縮の呼び出しの使用量。応答に入っていた時だけ。
    pub usage: Option<Usage>,
}

/// /responses/compact の応答を読む。
pub fn read_standalone(response: &Value) -> Result<CompactedWindow, NativeError> {
    let output = response
        .get("output")
        .and_then(Value::as_array)
        .ok_or(NativeError::MissingField("output"))?;
    if !output.iter().any(is_compaction) {
        return Err(NativeError::NoCompactionItem);
    }
    Ok(CompactedWindow {
        window: output.clone(),
        usage: responses_usage(response),
    })
}

/// 次のリクエストの input を作る。圧縮の後の窓をそのまま置き、新しい項目を後ろに足す。
pub fn next_input(window: Vec<Value>, new_items: Vec<Value>) -> Vec<Value> {
    let mut input = window;
    input.extend(new_items);
    input
}

/// いちばん新しい圧縮結果より前の項目を落とす。
///
/// input を自分で並べて送る時だけ使う。
/// previous_response_id でつなぐ時は、手で削らない。
pub fn drop_before_latest_compaction(items: &[Value]) -> &[Value] {
    match items.iter().rposition(is_compaction) {
        Some(index) => &items[index..],
        None => items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_stream_compaction_is_added_to_the_request() {
        let mut body = json!({ "model": "model-x", "input": [], "store": false });
        enable_in_stream(&mut body, 200_000).unwrap();
        assert_eq!(
            body["context_management"],
            json!([{ "type": "compaction", "compact_threshold": 200_000 }])
        );
        assert_eq!(body["store"], json!(false));
    }

    #[test]
    fn in_stream_compaction_replaces_an_older_threshold() {
        let mut body = json!({
            "context_management": [{ "type": "compaction", "compact_threshold": 100_000 }]
        });
        enable_in_stream(&mut body, 200_000).unwrap();
        assert_eq!(
            body["context_management"],
            json!([{ "type": "compaction", "compact_threshold": 200_000 }])
        );
    }

    #[test]
    fn standalone_request_has_only_model_and_input() {
        let parts = standalone_request("model-x", vec![json!({ "role": "user", "content": "hi" })]);
        assert_eq!(parts.path, "/responses/compact");
        assert!(parts.headers.is_empty());
        assert_eq!(
            parts.body,
            json!({ "model": "model-x", "input": [{ "role": "user", "content": "hi" }] })
        );
    }

    #[test]
    fn standalone_output_is_kept_whole() {
        let response = json!({
            "output": [
                { "type": "compaction", "id": "cmp_1", "encrypted_content": "blob" },
                { "role": "user", "content": "kept" }
            ]
        });
        let compacted = read_standalone(&response).unwrap();
        assert_eq!(compacted.window.len(), 2);
        let input = next_input(
            compacted.window,
            vec![json!({ "role": "user", "content": "next" })],
        );
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["encrypted_content"], json!("blob"));
        assert_eq!(input[2]["content"], json!("next"));
    }

    #[test]
    fn standalone_response_without_a_compaction_item_is_an_error() {
        let response = json!({ "output": [{ "role": "user", "content": "kept" }] });
        assert_eq!(
            read_standalone(&response),
            Err(NativeError::NoCompactionItem)
        );
        assert_eq!(
            read_standalone(&json!({})),
            Err(NativeError::MissingField("output"))
        );
    }

    #[test]
    fn items_before_the_latest_compaction_can_be_dropped() {
        let items = vec![
            json!({ "role": "user", "content": "old" }),
            json!({ "type": "compaction", "id": "cmp_1" }),
            json!({ "role": "user", "content": "mid" }),
            json!({ "type": "compaction", "id": "cmp_2" }),
            json!({ "role": "user", "content": "new" }),
        ];
        let kept = drop_before_latest_compaction(&items);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0]["id"], json!("cmp_2"));
    }
}
