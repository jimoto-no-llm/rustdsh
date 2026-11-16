//! 元が取れるかの計算（RQ-05）。

use crate::threshold::ResolvedThreshold;

/// 単価。4 つとも同じ単位で入れる。pi-ai のカタログと同じ並び。
/// cache_read が 0 の時は、読み出しが無料なので費用削減とは数えない。
/// cache_write が 0 の時は、書き込みに別の値段がないものとして input で数える。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Prices {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// 圧縮 1 回の見積もりに使う量。どれもトークン数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CostInput {
    /// 対象より前にあって変わらない部分。system やツールの定義。
    pub prefix: u64,
    /// 要約に置き換える部分。
    pub replaced: u64,
    /// できあがる要約の見積もり。
    pub summary: u64,
    /// そのまま残す直近の部分。
    pub tail: u64,
    /// 要約の指示。
    pub instruction: u64,
    /// 要約の呼び出しが、会話の先頭のキャッシュを使い回せるか。
    /// DSH の既定の実装は使い回す。別の接続先に要約させる時は使い回せない。
    pub summarizer_reuses_prefix: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BreakEven {
    /// 圧縮 1 回の費用。
    pub one_time_cost: f64,
    /// 圧縮の後、1 ターンごとに浮く額。
    pub saving_per_turn: f64,
    /// 元が取れるターン数。浮く額が 0 以下の時は None。
    pub turns: Option<f64>,
}

/// 元が取れるターン数を出す。
///
/// 圧縮 1 回の費用は、次の 2 つの合計。
/// 要約の呼び出しの代金。先頭と対象を読ませ、指示を足し、要約を書かせる。
/// 要約と直近の部分を、キャッシュに書き直す代金。読み出しの単価との差の分。
///
/// 1 ターンで浮く額は「対象 − 要約」にキャッシュ読み出しの単価を掛けた値。
///
/// この式は書き手の試算で、集めた資料に載っているものではない。
pub fn break_even(input: CostInput, prices: Prices) -> BreakEven {
    let cached = prices.cache_read;
    let fresh = if prices.cache_write > 0.0 {
        prices.cache_write
    } else {
        prices.input
    };
    let read_side = if input.summarizer_reuses_prefix {
        cached
    } else {
        prices.input
    };
    let summary_call = (input.prefix as f64 + input.replaced as f64) * read_side
        + input.instruction as f64 * prices.input
        + input.summary as f64 * prices.output;
    let rewrite = (input.summary as f64 + input.tail as f64) * (fresh - cached).max(0.0);
    let one_time_cost = summary_call + rewrite;
    let saving_per_turn = (input.replaced as f64 - input.summary as f64) * cached;
    let turns = if saving_per_turn > 0.0 {
        Some(one_time_cost / saving_per_turn)
    } else {
        None
    };
    BreakEven {
        one_time_cost,
        saving_per_turn,
        turns,
    }
}

/// しきい値の手前で圧縮するかを見る時の材料。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EarlyCheck {
    pub break_even: BreakEven,
    /// この先に続くと見込むターン数。呼ぶ側が決める。
    pub expected_turns: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// しきい値を超えたので、必ず圧縮する。
    CompactOverThreshold,
    /// しきい値の手前だが、元が取れるので圧縮する。
    CompactPaysOff,
    /// 圧縮しない。
    Skip,
}

/// 圧縮するかを決める。
/// early が None の時は、しきい値を超えた時にだけ圧縮する。native-web はこの形。
pub fn decide(current: u64, threshold: ResolvedThreshold, early: Option<EarlyCheck>) -> Decision {
    if current > threshold.trigger {
        return Decision::CompactOverThreshold;
    }
    match early {
        Some(check) => match check.break_even.turns {
            Some(turns) if turns <= check.expected_turns => Decision::CompactPaysOff,
            _ => Decision::Skip,
        },
        None => Decision::Skip,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threshold::Unit;

    fn close(left: f64, right: f64) -> bool {
        (left - right).abs() < 1e-6
    }

    #[test]
    fn break_even_with_a_shared_prefix() {
        let prices = Prices {
            input: 1.0,
            output: 5.0,
            cache_read: 0.1,
            cache_write: 1.25,
        };
        let input = CostInput {
            prefix: 10_000,
            replaced: 130_000,
            summary: 4_000,
            tail: 26_000,
            instruction: 500,
            summarizer_reuses_prefix: true,
        };
        let result = break_even(input, prices);
        // 要約の呼び出し: 140,000 × 0.1 + 500 × 1.0 + 4,000 × 5.0 = 34,500
        // 書き直し: 30,000 × (1.25 − 0.1) = 34,500
        assert!(close(result.one_time_cost, 69_000.0));
        // 浮く額: 126,000 × 0.1 = 12,600
        assert!(close(result.saving_per_turn, 12_600.0));
        assert!(close(result.turns.unwrap(), 69_000.0 / 12_600.0));
    }

    #[test]
    fn never_pays_off_when_the_summary_is_not_smaller() {
        let prices = Prices {
            input: 1.0,
            output: 5.0,
            cache_read: 0.1,
            cache_write: 1.25,
        };
        let input = CostInput {
            prefix: 0,
            replaced: 1_000,
            summary: 1_000,
            tail: 0,
            instruction: 0,
            summarizer_reuses_prefix: true,
        };
        assert_eq!(break_even(input, prices).turns, None);
    }

    #[test]
    fn decide_compacts_over_the_threshold_and_skips_below_it() {
        let threshold = ResolvedThreshold {
            unit: Unit::Bytes,
            trigger: 419_430,
            retain: 83_886,
            clamped: false,
        };
        assert_eq!(
            decide(419_431, threshold, None),
            Decision::CompactOverThreshold
        );
        assert_eq!(decide(419_430, threshold, None), Decision::Skip);
    }
}
