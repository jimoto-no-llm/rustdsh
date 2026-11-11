//! 圧縮 1 回の記録（RQ-06）。

use crate::capability::{Method, Trigger};
use crate::threshold::{ResolvedThreshold, Unit};

/// 大きさとハッシュ。本文は持たない。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SizeDigest {
    pub unit: Unit,
    pub size: u64,
    /// SHA-256 の 16 進の文字列。計算するのは呼ぶ側。
    pub sha256_hex: Option<String>,
}

/// プロバイダが返した使用量。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
}

/// 圧縮の結果。履歴を変えなかった時は、その理由を残す（NW-04）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Replaced,
    UnchangedNothingToCut,
    UnchangedSummaryFailed,
    UnchangedSummaryEmpty,
    UnchangedNotSmaller,
    UnchangedCancelled,
}

/// 圧縮 1 回の記録。本文は入れず、大きさとハッシュだけを入れる。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionRecord {
    /// 起きた時刻。UTC で「2026-11-10T07:00:00Z」の形。
    pub at: String,
    pub provider: String,
    pub model: String,
    pub method: Method,
    pub trigger: Trigger,
    pub threshold: ResolvedThreshold,
    pub before: SizeDigest,
    pub after: SizeDigest,
    /// 置き換えた件数。
    pub replaced_items: u64,
    /// 要約の呼び出しの使用量。
    pub summarizer_usage: Option<Usage>,
    /// プロバイダが返した付加情報の写し。名前と値の組。
    pub provider_meta: Vec<(String, String)>,
    pub outcome: Outcome,
}
