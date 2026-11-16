//! 接続先ごとの対応表（RQ-07）。

use crate::instructions::{InstructionContract, InstructionPlacement};

/// 圧縮のやり方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// 呼ぶ側が要約を作って置き換える。
    HostSummary,
    /// プロバイダ側の圧縮を使う。
    ProviderNative(NativeKind),
    /// 自動では圧縮しない。
    Off,
}

/// プロバイダ側の圧縮の種類。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeKind {
    /// OpenAI。リクエストに context_management を付ける形。
    OpenAiInStream,
    /// OpenAI。/responses/compact を単独で呼ぶ形。
    OpenAiStandalone,
    /// Anthropic。しきい値で起きる形（compact_20260112）。
    AnthropicThreshold,
    /// Anthropic。単独で呼ぶ形。
    AnthropicOnDemand,
    /// xAI。/responses/compact を単独で呼ぶ形。
    XaiStandalone,
}

/// 圧縮の起こし方（RQ-08）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Threshold,
    Manual,
    AfterOverflow,
    Background,
}

/// 途中を書き換えた後に、モデルの考えた跡が残るか（RQ-03）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retention {
    NotKept,
    KeptIfConditionsHold,
    Kept,
}

/// 窓あふれのリクエストを救えるか（RQ-04）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rescue {
    Possible,
    Impossible,
    Undeclared,
}

/// 圧縮結果を、次のリクエストのどこに置くか（RQ-02）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// 先頭に、そのまま置く。xAI と、Anthropic の単独で呼ぶ形。
    HeadVerbatim,
    /// 返ってきた位置のまま置く。OpenAI の形。
    WhereReturned,
    /// 要約のメッセージとして置く。HostSummary の形。
    AsSummaryMessage,
}

/// 圧縮結果の中身の形（RQ-10）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultForm {
    OpaqueEncrypted,
    ReadableSigned,
    PlainText,
}

/// 対応表の 1 行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capability {
    pub provider: String,
    /// None の時は、その接続先の全部のモデルに当てる。
    pub model: Option<String>,
    pub method: Method,
    pub triggers: Vec<Trigger>,
    pub retention: Retention,
    pub rescue: Rescue,
    pub placement: Placement,
    pub result_form: ResultForm,
    pub instruction: InstructionContract,
    /// 根拠にしたページ。
    pub source_url: Option<String>,
    /// 確かめた日。「2026-11-10」の形。
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityTable {
    pub entries: Vec<Capability>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unsupported {
    MethodNotAvailable,
    TriggerNotAvailable,
}

/// HostSummary で、表に行がなくても使える起こし方。
const HOST_TRIGGERS: [Trigger; 2] = [Trigger::Threshold, Trigger::Manual];

impl Capability {
    /// 表にない接続先に当てる行。呼ぶ側が要約を作って置き換える。
    pub fn host_summary(provider: &str, model: &str) -> Capability {
        Capability {
            provider: provider.to_string(),
            model: Some(model.to_string()),
            method: Method::HostSummary,
            triggers: HOST_TRIGGERS.to_vec(),
            retention: Retention::NotKept,
            rescue: Rescue::Undeclared,
            placement: Placement::AsSummaryMessage,
            result_form: ResultForm::PlainText,
            instruction: InstructionContract {
                placement: InstructionPlacement::LastUserMessage,
                max_chars: None,
            },
            source_url: None,
            checked_at: None,
        }
    }
}

impl CapabilityTable {
    /// 接続先とモデルの行を引く。
    /// モデルまで合う行があれば、それを返す。なければ、モデルを決めていない行を返す。
    /// 表にない時は HostSummary の行を返す。
    pub fn lookup(&self, provider: &str, model: &str) -> Capability {
        let exact = self
            .entries
            .iter()
            .find(|entry| entry.provider == provider && entry.model.as_deref() == Some(model));
        let any_model = self
            .entries
            .iter()
            .find(|entry| entry.provider == provider && entry.model.is_none());
        match exact.or(any_model) {
            Some(entry) => entry.clone(),
            None => Capability::host_summary(provider, model),
        }
    }

    /// やり方と起こし方の組み合わせが使えるかを見る。
    /// 使えない時は、近いものに置き換えずにエラーを返す（RQ-08）。
    ///
    /// Off はいつでも使える。
    /// HostSummary は、どの接続先でも使える。
    /// ProviderNative は、表の行と同じ種類の時だけ使える。
    pub fn require(
        &self,
        provider: &str,
        model: &str,
        method: Method,
        trigger: Trigger,
    ) -> Result<(), Unsupported> {
        let row = self.lookup(provider, model);
        match method {
            Method::Off => Ok(()),
            Method::HostSummary => {
                let allowed = if row.method == Method::HostSummary {
                    row.triggers.contains(&trigger)
                } else {
                    HOST_TRIGGERS.contains(&trigger)
                };
                if allowed {
                    Ok(())
                } else {
                    Err(Unsupported::TriggerNotAvailable)
                }
            }
            Method::ProviderNative(_) => {
                if row.method != method {
                    return Err(Unsupported::MethodNotAvailable);
                }
                if row.triggers.contains(&trigger) {
                    Ok(())
                } else {
                    Err(Unsupported::TriggerNotAvailable)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anthropic_row(model: Option<&str>, triggers: Vec<Trigger>) -> Capability {
        Capability {
            provider: "anthropic".to_string(),
            model: model.map(|name| name.to_string()),
            method: Method::ProviderNative(NativeKind::AnthropicThreshold),
            triggers,
            retention: Retention::KeptIfConditionsHold,
            rescue: Rescue::Undeclared,
            placement: Placement::WhereReturned,
            result_form: ResultForm::ReadableSigned,
            instruction: InstructionContract {
                placement: InstructionPlacement::ReplaceDefault,
                max_chars: None,
            },
            source_url: None,
            checked_at: None,
        }
    }

    #[test]
    fn unknown_route_falls_back_to_host_summary() {
        let table = CapabilityTable {
            entries: vec![anthropic_row(None, vec![Trigger::Threshold])],
        };
        let row = table.lookup("hai", "deepseek-v4-flash");
        assert_eq!(row.method, Method::HostSummary);
        assert_eq!(row.triggers, vec![Trigger::Threshold, Trigger::Manual]);
    }

    #[test]
    fn exact_model_row_wins_over_the_any_model_row() {
        let table = CapabilityTable {
            entries: vec![
                anthropic_row(None, vec![Trigger::Threshold]),
                anthropic_row(Some("model-x"), vec![Trigger::Threshold, Trigger::Manual]),
            ],
        };
        assert_eq!(
            table.lookup("anthropic", "model-x").triggers,
            vec![Trigger::Threshold, Trigger::Manual]
        );
        assert_eq!(
            table.lookup("anthropic", "model-y").triggers,
            vec![Trigger::Threshold]
        );
    }

    #[test]
    fn unsupported_combinations_are_refused_not_approximated() {
        let table = CapabilityTable {
            entries: vec![anthropic_row(None, vec![Trigger::Threshold])],
        };
        let native = Method::ProviderNative(NativeKind::AnthropicThreshold);
        assert_eq!(
            table.require("anthropic", "model-x", native, Trigger::Threshold),
            Ok(())
        );
        assert_eq!(
            table.require("anthropic", "model-x", native, Trigger::Background),
            Err(Unsupported::TriggerNotAvailable)
        );
        assert_eq!(
            table.require(
                "hai",
                "deepseek-v4-flash",
                Method::ProviderNative(NativeKind::OpenAiStandalone),
                Trigger::Threshold
            ),
            Err(Unsupported::MethodNotAvailable)
        );
    }

    #[test]
    fn host_summary_and_off_stay_available_on_a_native_route() {
        let table = CapabilityTable {
            entries: vec![anthropic_row(None, vec![Trigger::Threshold])],
        };
        assert_eq!(
            table.require("anthropic", "model-x", Method::HostSummary, Trigger::Manual),
            Ok(())
        );
        assert_eq!(
            table.require("anthropic", "model-x", Method::Off, Trigger::Threshold),
            Ok(())
        );
        assert_eq!(
            table.require(
                "anthropic",
                "model-x",
                Method::HostSummary,
                Trigger::Background
            ),
            Err(Unsupported::TriggerNotAvailable)
        );
    }
}
