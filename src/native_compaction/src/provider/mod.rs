//! プロバイダ側の圧縮の、リクエストの本文を作る関数と、応答を読む関数。
//!
//! どの関数も通信をしない。送るのは呼ぶ側。
//! 圧縮結果は JSON の値のまま持ち、中を開けたり並べ替えたりしない。
//! 形は、2026-11-10 に各社のドキュメントで確かめた。

use serde_json::Value;

use crate::record::Usage;

pub mod anthropic;
pub mod openai;
pub mod xai;

/// 足すヘッダー 1 つ。名前と値の組。
pub type Header = (&'static str, &'static str);

/// 送る 1 回分。接続先の先頭の URL と鍵は、呼ぶ側で付ける。
#[derive(Debug, Clone, PartialEq)]
pub struct RequestParts {
    /// 接続先の先頭の URL の後ろにつなぐパス。
    pub path: &'static str,
    /// 足すヘッダー。
    pub headers: Vec<Header>,
    /// リクエストの本文。
    pub body: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeError {
    /// 本文が JSON のオブジェクトになっていない。
    BodyNotObject,
    /// 一緒に送れない欄が入っている。値は欄の名前。
    FieldNotAllowed(&'static str),
    /// 欄の形が、決まりと違う。値は欄の名前。
    UnexpectedShape(&'static str),
    /// 発動のしきい値が小さすぎる。
    TriggerTooSmall { min: u64, actual: u64 },
    /// 指示が空になっている。
    InstructionsEmpty,
    /// 指示が長すぎる。
    InstructionsTooLong { max_chars: usize, actual: usize },
    /// 応答に、あるはずの欄がない。値は欄の名前。
    MissingField(&'static str),
    /// 圧縮結果が入っていない。
    NoCompactionItem,
    /// 圧縮結果が 2 つ以上入っている。
    TooManyCompactionItems,
    /// 圧縮結果のブロックが、決まった位置にない。
    BlockMisplaced,
}

/// type が "compaction" の値か。圧縮結果の項目とブロックは、どの会社もこの形。
pub(crate) fn is_compaction(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("compaction")
}

/// Responses API の形の usage を読む。xAI のドキュメントに載っている形。
pub(crate) fn responses_usage(response: &Value) -> Option<Usage> {
    let usage = response.get("usage")?;
    Some(Usage {
        input: usage.get("input_tokens")?.as_u64()?,
        output: usage.get("output_tokens")?.as_u64()?,
        cache_read: usage
            .get("input_tokens_details")
            .and_then(|details| details.get("cached_tokens"))
            .and_then(Value::as_u64),
        cache_write: None,
    })
}
