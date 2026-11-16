//! 要約の指示（RQ-09 と RQ-11）。

/// 指示をどこに入れて送るか。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstructionPlacement {
    /// プロバイダの既定の指示を丸ごと置き換える。Anthropic の形。
    ReplaceDefault,
    /// 会話の最後に、user のメッセージとして足す。DSH の既定の実装と native-web の形。
    LastUserMessage,
    /// 指示を送らない。OpenAI の /responses/compact の形。
    NotSent,
}

/// 接続先ごとの、指示の決まり。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstructionContract {
    pub placement: InstructionPlacement,
    /// 文字数の上限。Anthropic の単独で呼ぶ形は 16,384。
    pub max_chars: Option<usize>,
}

/// 指示の出どころ。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstructionSource {
    /// クレートに入っている既定の指示。
    BuiltIn,
    /// 設定で差し替えた指示。
    Configured,
    /// ACON 式の最適化で作った指示（RQ-11）。id は記録に残すための名前。
    Optimized { id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instructions {
    pub text: String,
    pub source: InstructionSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstructionError {
    Empty,
    TooLong {
        max_chars: usize,
        actual: usize,
    },
    /// 指示を送れない接続先に、差し替えた指示を渡した。
    NotAccepted,
}

/// 指示が接続先の決まりに合うかを見る。合わない時は、黙って切り詰めずにエラーを返す。
/// 文字数は、バイトではなく文字で数える。
pub fn check_instructions(
    instructions: &Instructions,
    contract: InstructionContract,
) -> Result<(), InstructionError> {
    if instructions.text.trim().is_empty() {
        return Err(InstructionError::Empty);
    }
    if contract.placement == InstructionPlacement::NotSent
        && instructions.source != InstructionSource::BuiltIn
    {
        return Err(InstructionError::NotAccepted);
    }
    if let Some(max_chars) = contract.max_chars {
        let actual = instructions.text.chars().count();
        if actual > max_chars {
            return Err(InstructionError::TooLong { max_chars, actual });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instructions(text: &str, source: InstructionSource) -> Instructions {
        Instructions {
            text: text.to_string(),
            source,
        }
    }

    #[test]
    fn instructions_over_the_limit_are_rejected_not_truncated() {
        let contract = InstructionContract {
            placement: InstructionPlacement::ReplaceDefault,
            max_chars: Some(16_384),
        };
        // 日本語は 1 文字が 3 バイト。文字で数えるので、16,384 文字までは通る。
        let fits = instructions(&"あ".repeat(16_384), InstructionSource::Configured);
        let too_long = instructions(&"あ".repeat(16_385), InstructionSource::Configured);
        assert_eq!(check_instructions(&fits, contract), Ok(()));
        assert_eq!(
            check_instructions(&too_long, contract),
            Err(InstructionError::TooLong {
                max_chars: 16_384,
                actual: 16_385
            })
        );
    }

    #[test]
    fn custom_instructions_are_refused_where_none_can_be_sent() {
        let contract = InstructionContract {
            placement: InstructionPlacement::NotSent,
            max_chars: None,
        };
        let built_in = instructions("要約してください", InstructionSource::BuiltIn);
        let custom = instructions("要約してください", InstructionSource::Configured);
        assert_eq!(check_instructions(&built_in, contract), Ok(()));
        assert_eq!(
            check_instructions(&custom, contract),
            Err(InstructionError::NotAccepted)
        );
    }

    #[test]
    fn blank_instructions_are_rejected() {
        let contract = InstructionContract {
            placement: InstructionPlacement::LastUserMessage,
            max_chars: None,
        };
        let blank = instructions("  \n", InstructionSource::Configured);
        assert_eq!(
            check_instructions(&blank, contract),
            Err(InstructionError::Empty)
        );
    }
}
