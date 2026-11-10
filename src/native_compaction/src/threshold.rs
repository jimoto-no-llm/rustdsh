//! しきい値（RQ-01 と NW-01）。

/// 大きさを何で数えるか。
/// DSH と汎用のものはトークンで数え、native-web の上限はバイトで数える。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Tokens,
    Bytes,
}

/// 量の書き方。
/// 絶対値をもとの書き方にする。割合は、容量が分かる時だけ使える。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Amount {
    Absolute(u64),
    /// 0 より大きく 1 以下。容量（出力の分を引く前）に掛ける。
    Ratio(f64),
}

/// 圧縮を起こす点と、直近として残す量。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThresholdPolicy {
    pub trigger: Amount,
    pub retain: Amount,
}

/// 測る相手の大きさ。モデルの窓か、履歴の上限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capacity {
    pub unit: Unit,
    /// 窓や上限の大きさ。分からない時は None。
    pub size: Option<u64>,
    /// 出力のために空けておく量。バイトで数える時は 0。
    pub output_reserve: u64,
}

/// 絶対値に直した後のしきい値。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedThreshold {
    pub unit: Unit,
    pub trigger: u64,
    pub retain: u64,
    /// 発動点を「容量 − 出力の分」まで下げた時に true。
    pub clamped: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThresholdError {
    /// 割合で書いてあるのに、容量が分からない。
    CapacityUnknown,
    /// 割合が「0 より大きく 1 以下」に入っていない。
    RatioOutOfRange,
    /// 出力の分を引くと、容量が残らない。
    NoRoom,
    /// 残す量が発動点以上になっている。
    RetainNotBelowTrigger,
}

/// 書かれたしきい値を絶対値に直す。
///
/// 決まりは 3 つ。
/// 絶対値はそのまま使う。容量が変わっても動かない。
/// 発動点が「容量 − 出力の分」を超える時は、そこまで下げる。
/// 残す量が発動点以上の時は、エラーにする。
pub fn resolve_threshold(
    policy: ThresholdPolicy,
    capacity: Capacity,
) -> Result<ResolvedThreshold, ThresholdError> {
    let usable = match capacity.size {
        Some(size) => {
            if size <= capacity.output_reserve {
                return Err(ThresholdError::NoRoom);
            }
            Some(size - capacity.output_reserve)
        }
        None => None,
    };
    let trigger_raw = resolve_amount(policy.trigger, capacity.size)?;
    let retain = resolve_amount(policy.retain, capacity.size)?;
    let (trigger, clamped) = match usable {
        Some(limit) if trigger_raw > limit => (limit, true),
        _ => (trigger_raw, false),
    };
    if retain >= trigger {
        return Err(ThresholdError::RetainNotBelowTrigger);
    }
    Ok(ResolvedThreshold {
        unit: capacity.unit,
        trigger,
        retain,
        clamped,
    })
}

fn resolve_amount(amount: Amount, size: Option<u64>) -> Result<u64, ThresholdError> {
    match amount {
        Amount::Absolute(value) => Ok(value),
        Amount::Ratio(ratio) => {
            if !(ratio > 0.0 && ratio <= 1.0) {
                return Err(ThresholdError::RatioOutOfRange);
            }
            let size = size.ok_or(ThresholdError::CapacityUnknown)?;
            Ok((size as f64 * ratio).floor() as u64)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_web_byte_defaults() {
        let policy = ThresholdPolicy {
            trigger: Amount::Ratio(0.8),
            retain: Amount::Ratio(0.16),
        };
        let capacity = Capacity {
            unit: Unit::Bytes,
            size: Some(512 * 1024),
            output_reserve: 0,
        };
        let resolved = resolve_threshold(policy, capacity).unwrap();
        assert_eq!(resolved.trigger, 419_430);
        assert_eq!(resolved.retain, 83_886);
        assert!(!resolved.clamped);
    }

    #[test]
    fn absolute_trigger_does_not_move_with_the_window() {
        let policy = ThresholdPolicy {
            trigger: Amount::Absolute(150_000),
            retain: Amount::Absolute(20_000),
        };
        let small = Capacity {
            unit: Unit::Tokens,
            size: Some(200_000),
            output_reserve: 8_192,
        };
        let large = Capacity {
            unit: Unit::Tokens,
            size: Some(400_000),
            output_reserve: 8_192,
        };
        let first = resolve_threshold(policy, small).unwrap();
        let second = resolve_threshold(policy, large).unwrap();
        assert_eq!(first.trigger, 150_000);
        assert_eq!(second.trigger, 150_000);
    }

    #[test]
    fn small_window_is_clamped_to_leave_room_for_output() {
        let policy = ThresholdPolicy {
            trigger: Amount::Ratio(0.8),
            retain: Amount::Ratio(0.16),
        };
        let capacity = Capacity {
            unit: Unit::Tokens,
            size: Some(32_000),
            output_reserve: 8_192,
        };
        let resolved = resolve_threshold(policy, capacity).unwrap();
        assert_eq!(resolved.trigger, 23_808);
        assert_eq!(resolved.retain, 5_120);
        assert!(resolved.clamped);
    }

    #[test]
    fn ratio_needs_a_known_capacity() {
        let policy = ThresholdPolicy {
            trigger: Amount::Ratio(0.8),
            retain: Amount::Absolute(1_000),
        };
        let capacity = Capacity {
            unit: Unit::Tokens,
            size: None,
            output_reserve: 0,
        };
        assert_eq!(
            resolve_threshold(policy, capacity),
            Err(ThresholdError::CapacityUnknown)
        );
    }

    #[test]
    fn retain_must_stay_below_trigger() {
        let policy = ThresholdPolicy {
            trigger: Amount::Absolute(10_000),
            retain: Amount::Absolute(10_000),
        };
        let capacity = Capacity {
            unit: Unit::Tokens,
            size: Some(100_000),
            output_reserve: 0,
        };
        assert_eq!(
            resolve_threshold(policy, capacity),
            Err(ThresholdError::RetainNotBelowTrigger)
        );
    }
}
