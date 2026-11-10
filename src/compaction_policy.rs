//! The policy file behind the `compaction_policy` feature.
//!
//! `$DSH_HOME/rdsh-compaction.json` lists compaction thresholds per
//! provider/model route in absolute tokens:
//!
//! ```json
//! {
//!   "schema": 1,
//!   "policies": [
//!     {
//!       "provider": "hai",
//!       "model": "deepseek-v4-flash",
//!       "context_window": 1000000,
//!       "output_reserve": 8192,
//!       "trigger_tokens": 150000,
//!       "retain_tokens": 20000,
//!       "max_tokens": 8192
//!     }
//!   ]
//! }
//! ```
//!
//! It is a file of its own rather than a section of `rdsh.json`: the settings
//! writer rewrites that file from a fixed set of sections, so a section it does
//! not know would be dropped on the next save, and its dotted get/set keys do
//! not model a list of records.
//!
//! Reading is strict. A missing file means "no policies". An invalid document
//! blocks a boot when the feature is enabled, and doctor reports the reason
//! without starting DSH. Reasons never echo provider or model names, so nothing read
//! from the file reaches the terminal unescaped.
//!
//! `rdsh doctor` shows the same file read-only, see [`report`]. It is the one
//! place that prints route names, after the checks a boot applies and through
//! [`crate::terminal_safe::strip_control`].

use crate::compaction_overlay::{AbsolutePolicy, ModelPolicy, PolicyError};
use crate::locale::Locale;

/// Schema version this build reads.
pub const SCHEMA_VERSION: u64 = 1;

/// File name under `$DSH_HOME`.
pub const FILE_NAME: &str = "rdsh-compaction.json";

const MAX_BYTES: u64 = 256 * 1024;
const MAX_POLICIES: usize = 200;
const NAME_CHARS: usize = 200;

/// How many routes `rdsh doctor` lists before summarizing.
const DOCTOR_ROUTES: usize = 5;

const POLICY_KEYS: [&str; 7] = [
    "provider",
    "model",
    "context_window",
    "output_reserve",
    "trigger_tokens",
    "retain_tokens",
    "max_tokens",
];

/// Where the policy file lives.
pub fn policy_path() -> String {
    format!("{}/{FILE_NAME}", crate::inspect::dsh_home())
}

/// Parse the policy document. Unknown keys are errors, so a typo is reported
/// instead of silently leaving a route on the backend defaults.
pub fn parse(text: &str) -> Result<Vec<AbsolutePolicy>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|_| "is not valid JSON".to_string())?;
    let object = value.as_object().ok_or("must be a JSON object")?;
    if object.keys().any(|key| {
        ![
            "schema",
            "policies",
            "instructions",
            "native_web",
            "routes",
            "early",
        ]
        .contains(&key.as_str())
    }) {
        return Err("has an unknown top-level key".to_string());
    }
    if object.get("schema").and_then(serde_json::Value::as_u64) != Some(SCHEMA_VERSION) {
        return Err(format!("must have \"schema\": {SCHEMA_VERSION}"));
    }
    crate::compaction_config::Options::parse(&value).map_err(|e| e.to_string())?;
    let entries = object
        .get("policies")
        .and_then(serde_json::Value::as_array)
        .ok_or("must have a \"policies\" array")?;
    if entries.len() > MAX_POLICIES {
        return Err(format!("lists more than {MAX_POLICIES} policies"));
    }
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            parse_policy(entry).map_err(|reason| format!("policies[{index}] {reason}"))
        })
        .collect()
}

fn parse_policy(entry: &serde_json::Value) -> Result<AbsolutePolicy, String> {
    let object = entry.as_object().ok_or("must be an object")?;
    if object
        .keys()
        .any(|key| !POLICY_KEYS.contains(&key.as_str()))
    {
        return Err("has an unknown key".to_string());
    }
    let name = |key: &str| -> Result<String, String> {
        let text = object
            .get(key)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("needs a string \"{key}\""))?;
        if text.chars().count() > NAME_CHARS {
            return Err(format!(
                "has a \"{key}\" longer than {NAME_CHARS} characters"
            ));
        }
        Ok(text.to_string())
    };
    let count = |key: &str| -> Result<u64, String> {
        object
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| format!("needs a non-negative integer \"{key}\""))
    };
    Ok(AbsolutePolicy {
        provider: name("provider")?,
        model: name("model")?,
        context_window: count("context_window")?,
        output_reserve: count("output_reserve")?,
        trigger_tokens: count("trigger_tokens")?,
        retain_tokens: count("retain_tokens")?,
        max_tokens: count("max_tokens")?,
    })
}

fn describe(error: PolicyError) -> &'static str {
    match error {
        PolicyError::EmptyTarget => "has a blank provider or model",
        PolicyError::UnsafeTarget => "has a control character in provider or model",
        PolicyError::ZeroTrigger => "has a zero trigger_tokens",
        PolicyError::TriggerOutOfWindow => {
            "has a trigger_tokens that does not fit in context_window - output_reserve"
        }
        PolicyError::RetainNotBelowTrigger => "needs retain_tokens below trigger_tokens",
        PolicyError::ZeroMaxTokens => "has a zero max_tokens",
        PolicyError::DuplicateTarget => "repeats a provider/model pair",
    }
}

/// Turn parsed policies into the entries the backend takes.
pub fn resolve(policies: &[AbsolutePolicy]) -> Result<Vec<ModelPolicy>, String> {
    let mut resolved = Vec::with_capacity(policies.len());
    for (index, policy) in policies.iter().enumerate() {
        resolved.push(
            policy
                .to_model_policy()
                .map_err(|error| format!("policies[{index}] {}", describe(error)))?,
        );
    }
    crate::compaction_overlay::validate(&resolved)
        .map_err(|error| format!("policies list {}", describe(error)))?;
    Ok(resolved)
}

/// Read the policy document at `path`. `Ok(None)` when the file does not
/// exist. `Err` carries a validation failure, phrased to follow the file name.
fn read_document(path: &str) -> Result<Option<String>, String> {
    use std::io::Read;
    // Windows refuses opening a directory before file.metadata() can classify it.
    if std::fs::metadata(path).is_ok_and(|metadata| !metadata.is_file()) {
        return Err("is not a regular file".to_string());
    }
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("cannot be read".to_string()),
    };
    let metadata = file.metadata().map_err(|_| "cannot be read".to_string())?;
    if !metadata.is_file() {
        return Err("is not a regular file".to_string());
    }
    if metadata.len() > MAX_BYTES {
        return Err(format!("is larger than {MAX_BYTES} bytes"));
    }
    let mut text = String::new();
    file.take(MAX_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|_| "cannot be read".to_string())?;
    if text.len() as u64 > MAX_BYTES {
        return Err(format!("is larger than {MAX_BYTES} bytes"));
    }
    Ok(Some(text))
}

/// Read and resolve the policy file at `path`.
///
/// `Ok(None)` when the file does not exist. `Err` carries the reason the file
/// is rejected, phrased to follow the file name.
pub fn load_at(path: &str) -> Result<Option<Vec<ModelPolicy>>, String> {
    let Some(text) = read_document(path)? else {
        return Ok(None);
    };
    resolve(&parse(&text)?).map(Some)
}

/// What the policy file holds, as far as it can be told without composing a
/// profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileState {
    /// There is no policy file.
    Absent,
    /// The file passes the checks a boot applies; its policies in file order.
    Policies(Vec<AbsolutePolicy>),
    /// An enabled boot would reject the file for this reason, phrased to follow the
    /// file's name.
    Invalid(String),
}

/// The read-only view of the policy layer that `rdsh doctor` prints.
///
/// It covers the feature switch and the policy file only. Which rows of a
/// profile receive the policies is decided at boot from `dsh --dump-config`,
/// and doctor does not start DSH for that; the boot notice reports the rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    /// Whether the `compaction_policy` feature is on.
    pub enabled: bool,
    /// What the policy file holds.
    pub file: FileState,
}

/// Build the report for the policy file at `path`.
pub fn report_at(enabled: bool, path: &str) -> Report {
    let checked = read_document(path).and_then(|text| match text {
        None => Ok(None),
        Some(text) => {
            let policies = parse(&text)?;
            resolve(&policies)?;
            Ok(Some(policies))
        }
    });
    let file = match checked {
        Ok(None) => FileState::Absent,
        Ok(Some(policies)) => FileState::Policies(policies),
        Err(reason) => FileState::Invalid(reason),
    };
    Report { enabled, file }
}

/// The report for this process: the saved feature switch and `$DSH_HOME`.
pub fn report() -> Report {
    report_at(
        crate::rdsh_config::feature_enabled(
            &crate::rdsh_config::load(),
            crate::compaction_overlay::FEATURE_ID,
        ),
        &policy_path(),
    )
}

/// One route as doctor lists it, in the numbers the policy file uses.
fn route_text(policy: &AbsolutePolicy, locale: Locale) -> String {
    let provider = crate::terminal_safe::strip_control(&policy.provider);
    let model = crate::terminal_safe::strip_control(&policy.model);
    let (trigger, retain, cap) = (
        policy.trigger_tokens,
        policy.retain_tokens,
        policy.max_tokens,
    );
    match locale {
        Locale::English => format!(
            "  {provider} / {model}: compacts at {trigger} tokens, keeps the last {retain}, summary cap {cap}"
        ),
        Locale::Chinese => format!(
            "  {provider} / {model}：达到 {trigger} token 时压缩，保留最近 {retain} token，摘要上限 {cap} token"
        ),
        Locale::Japanese => format!(
            "  {provider} / {model}: {trigger} トークンで圧縮、直近の {retain} トークンを残す、要約の上限 {cap} トークン"
        ),
    }
}

/// Localized doctor lines.
///
/// Nothing is printed while the feature is off and no policy file exists,
/// which is the state of an install that never used the feature. Reasons stay
/// in English in every locale, like the boot notice that carries the same
/// text.
pub fn doctor_lines(report: &Report, locale: Locale) -> Vec<String> {
    let label = match locale {
        Locale::English => "compaction policy",
        Locale::Chinese => "压缩阈值",
        Locale::Japanese => "圧縮のしきい値",
    };
    let line = |text: String| format!("[rdsh] {label}: {text}");
    let summary = match (report.enabled, &report.file) {
        (false, FileState::Absent) => return Vec::new(),
        (false, FileState::Policies(policies)) => {
            let count = policies.len();
            match locale {
                Locale::English => format!(
                    "OFF; {FILE_NAME} lists {count} route(s) that are not passed to DSH — enable with: rdsh features on {id}",
                    id = crate::compaction_overlay::FEATURE_ID
                ),
                Locale::Chinese => format!(
                    "已关闭；{FILE_NAME} 中的 {count} 条路由不会传给 DSH — 使用以下命令启用：rdsh features on {id}",
                    id = crate::compaction_overlay::FEATURE_ID
                ),
                Locale::Japanese => format!(
                    "OFFです。{FILE_NAME} の {count} 件は DSH に渡しません。有効化: rdsh features on {id}",
                    id = crate::compaction_overlay::FEATURE_ID
                ),
            }
        }
        (false, FileState::Invalid(reason)) => match locale {
            Locale::English => format!("OFF; {FILE_NAME} {reason}"),
            Locale::Chinese => format!("已关闭；{FILE_NAME} 无法使用（{FILE_NAME} {reason}）"),
            Locale::Japanese => {
                format!("OFFです。{FILE_NAME} は使えません（{FILE_NAME} {reason}）")
            }
        },
        (true, FileState::Absent) => match locale {
            Locale::English => format!(
                "ON, but DSH_HOME has no {FILE_NAME}; routes stay on the DSH defaults"
            ),
            Locale::Chinese => {
                format!("已开启，但 DSH_HOME 中没有 {FILE_NAME}；各路由沿用 DSH 默认值")
            }
            Locale::Japanese => format!(
                "ONですが、DSH_HOME に {FILE_NAME} がありません。接続先は DSH の既定のままです"
            ),
        },
        (true, FileState::Policies(policies)) if policies.is_empty() => match locale {
            Locale::English => {
                format!("ON, but {FILE_NAME} lists no routes; routes stay on the DSH defaults")
            }
            Locale::Chinese => {
                format!("已开启，但 {FILE_NAME} 中没有路由；各路由沿用 DSH 默认值")
            }
            Locale::Japanese => format!(
                "ONですが、{FILE_NAME} に接続先がありません。接続先は DSH の既定のままです"
            ),
        },
        (true, FileState::Policies(policies)) => {
            let count = policies.len();
            match locale {
                Locale::English => format!(
                    "ON, {count} route(s) from {FILE_NAME}; a boot passes them to the compaction rows it finds in the profile"
                ),
                Locale::Chinese => format!(
                    "已开启，{FILE_NAME} 中有 {count} 条路由；启动时会传给配置文件中找到的压缩行"
                ),
                Locale::Japanese => format!(
                    "ONです。{FILE_NAME} の {count} 件を、起動時にプロファイルの圧縮の行へ渡します"
                ),
            }
        }
        (true, FileState::Invalid(reason)) => match locale {
            Locale::English => {
                format!("ON, but {FILE_NAME} {reason}; routes stay on the DSH defaults")
            }
            Locale::Chinese => format!(
                "已开启，但 {FILE_NAME} 无法使用（{FILE_NAME} {reason}）；各路由沿用 DSH 默认值"
            ),
            Locale::Japanese => format!(
                "ONですが、{FILE_NAME} は使えません（{FILE_NAME} {reason}）。接続先は DSH の既定のままです"
            ),
        },
    };
    let mut lines = vec![line(summary)];
    if let (true, FileState::Policies(policies)) = (report.enabled, &report.file) {
        lines.extend(
            policies
                .iter()
                .take(DOCTOR_ROUTES)
                .map(|policy| line(route_text(policy, locale))),
        );
        if let Some(more) = policies.len().checked_sub(DOCTOR_ROUTES).filter(|n| *n > 0) {
            lines.push(line(match locale {
                Locale::English => format!("  ... and {more} more route(s)"),
                Locale::Chinese => format!("  另有 {more} 条路由"),
                Locale::Japanese => format!("  ほか {more} 件"),
            }));
        }
    }
    lines
}

/// Lines for the `warnings` list of `rdsh doctor --json`: only the case where
/// the feature is on and the file cannot be used, which leaves every route on
/// the DSH defaults against what the settings ask for.
pub fn doctor_warnings(report: &Report) -> Vec<String> {
    match (report.enabled, &report.file) {
        (true, FileState::Invalid(_)) => doctor_lines(report, Locale::English),
        _ => Vec::new(),
    }
}

/// Machine-readable projection for `rdsh doctor --json`. Route names and
/// numbers stay in the policy file; the report says whether a boot would use
/// it.
pub fn doctor_json(report: &Report) -> serde_json::Value {
    let (file, policies, reason) = match &report.file {
        FileState::Absent => ("absent", None, None),
        FileState::Policies(policies) => ("valid", Some(policies.len()), None),
        FileState::Invalid(reason) => ("invalid", None, Some(reason.as_str())),
    };
    serde_json::json!({
        "enabled": report.enabled,
        "file": file,
        "policies": policies,
        "reason": reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCUMENT: &str = r#"{
      "schema": 1,
      "policies": [
        {
          "provider": "hai",
          "model": "deepseek-v4-flash",
          "context_window": 1000000,
          "output_reserve": 8192,
          "trigger_tokens": 150000,
          "retain_tokens": 20000,
          "max_tokens": 8192
        }
      ]
    }"#;

    #[test]
    fn documented_shape_resolves_to_backend_policies() {
        let policies = parse(DOCUMENT).unwrap();
        assert_eq!(policies.len(), 1);
        assert_eq!(policies[0].trigger_tokens, 150_000);
        let resolved = resolve(&policies).unwrap();
        assert_eq!(resolved[0].provider, "hai");
        assert_eq!(resolved[0].headroom_tokens, 841_808);
        assert_eq!(resolved[0].retain_tokens, 20_000);
        assert_eq!(resolved[0].max_tokens, 8_192);
    }

    #[test]
    fn shapes_outside_the_schema_are_reported() {
        let cases = [
            ("not json", "is not valid JSON"),
            ("[]", "must be a JSON object"),
            (
                r#"{"schema":1,"policies":[],"extra":1}"#,
                "has an unknown top-level key",
            ),
            (r#"{"schema":2,"policies":[]}"#, "must have \"schema\": 1"),
            (r#"{"policies":[]}"#, "must have \"schema\": 1"),
            (r#"{"schema":1}"#, "must have a \"policies\" array"),
            (
                r#"{"schema":1,"policies":[7]}"#,
                "policies[0] must be an object",
            ),
        ];
        for (text, reason) in cases {
            assert_eq!(parse(text), Err(reason.to_string()), "{text}");
        }
    }

    #[test]
    fn a_typo_in_a_policy_key_is_an_error_not_a_default() {
        let typo = DOCUMENT.replace("trigger_tokens", "trigger_token");
        assert_eq!(
            parse(&typo),
            Err("policies[0] has an unknown key".to_string())
        );
        let negative = DOCUMENT.replace("150000", "-1");
        assert_eq!(
            parse(&negative),
            Err("policies[0] needs a non-negative integer \"trigger_tokens\"".to_string())
        );
        let fractional = DOCUMENT.replace("20000", "0.5");
        assert_eq!(
            parse(&fractional),
            Err("policies[0] needs a non-negative integer \"retain_tokens\"".to_string())
        );
        let numeric_name = DOCUMENT.replace("\"hai\"", "7");
        assert_eq!(
            parse(&numeric_name),
            Err("policies[0] needs a string \"provider\"".to_string())
        );
    }

    #[test]
    fn reasons_point_at_the_entry_without_echoing_names() {
        let too_large = DOCUMENT.replace("150000", "999999");
        assert_eq!(
            resolve(&parse(&too_large).unwrap()),
            Err(
                "policies[0] has a trigger_tokens that does not fit in context_window - output_reserve"
                    .to_string()
            )
        );
        let hostile = DOCUMENT.replace("deepseek-v4-flash", "evil\\u001b[2Jname");
        let reason = resolve(&parse(&hostile).unwrap()).unwrap_err();
        assert_eq!(
            reason,
            "policies[0] has a control character in provider or model"
        );
        assert!(!reason.contains("evil"));
    }

    #[test]
    fn duplicate_routes_are_reported() {
        let mut policies = parse(DOCUMENT).unwrap();
        policies.push(policies[0].clone());
        assert_eq!(
            resolve(&policies),
            Err("policies list repeats a provider/model pair".to_string())
        );
    }

    #[test]
    fn a_missing_file_means_no_policies() {
        let dir = std::env::temp_dir().join(format!(
            "rdsh-compaction-policy-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        let path_text = path.to_string_lossy().to_string();

        assert_eq!(load_at(&path_text), Ok(None));

        std::fs::write(&path, DOCUMENT).unwrap();
        let loaded = load_at(&path_text).unwrap().unwrap();
        assert_eq!(loaded.len(), 1);

        std::fs::write(&path, "{").unwrap();
        assert_eq!(load_at(&path_text), Err("is not valid JSON".to_string()));

        assert_eq!(
            load_at(&dir.to_string_lossy()),
            Err("is not a regular file".to_string())
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The doctor report for a policy file holding `document`, or for no file.
    fn report_for(tag: &str, enabled: bool, document: Option<&str>) -> Report {
        let dir = std::env::temp_dir().join(format!(
            "rdsh-compaction-doctor-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        if let Some(document) = document {
            std::fs::write(&path, document).unwrap();
        }
        let report = report_at(enabled, &path.to_string_lossy());
        std::fs::remove_dir_all(&dir).unwrap();
        report
    }

    #[test]
    fn doctor_is_quiet_for_an_install_that_never_used_the_feature() {
        let report = report_for("quiet", false, None);
        assert_eq!(
            report,
            Report {
                enabled: false,
                file: FileState::Absent
            }
        );
        for locale in [Locale::English, Locale::Chinese, Locale::Japanese] {
            assert!(doctor_lines(&report, locale).is_empty());
        }
        assert!(doctor_warnings(&report).is_empty());
        assert_eq!(
            doctor_json(&report),
            serde_json::json!({
                "enabled": false,
                "file": "absent",
                "policies": null,
                "reason": null
            })
        );
    }

    #[test]
    fn doctor_lists_the_routes_a_boot_would_pass_on() {
        let report = report_for("routes", true, Some(DOCUMENT));
        assert_eq!(
            doctor_lines(&report, Locale::English),
            vec![
                "[rdsh] compaction policy: ON, 1 route(s) from rdsh-compaction.json; a boot passes them to the compaction rows it finds in the profile".to_string(),
                "[rdsh] compaction policy:   hai / deepseek-v4-flash: compacts at 150000 tokens, keeps the last 20000, summary cap 8192".to_string(),
            ]
        );
        assert!(doctor_warnings(&report).is_empty());
        assert_eq!(
            doctor_json(&report),
            serde_json::json!({
                "enabled": true,
                "file": "valid",
                "policies": 1,
                "reason": null
            })
        );
    }

    #[test]
    fn doctor_names_the_reason_an_enabled_boot_would_reject_the_file() {
        // The same check a boot applies: a trigger outside the window.
        let report = report_for("invalid", true, Some(&DOCUMENT.replace("150000", "999999")));
        let reason =
            "policies[0] has a trigger_tokens that does not fit in context_window - output_reserve";
        assert_eq!(report.file, FileState::Invalid(reason.to_string()));
        let lines = doctor_lines(&report, Locale::English);
        assert_eq!(
            lines,
            vec![format!(
                "[rdsh] compaction policy: ON, but rdsh-compaction.json {reason}; routes stay on the DSH defaults"
            )]
        );
        assert_eq!(doctor_warnings(&report), lines);
        assert_eq!(doctor_json(&report)["file"], "invalid");
        assert_eq!(doctor_json(&report)["reason"], reason);

        // With the feature off the file is still described, but nothing the
        // settings ask for is lost, so it is not a warning.
        let off = Report {
            enabled: false,
            ..report
        };
        assert_eq!(
            doctor_lines(&off, Locale::English),
            vec![format!(
                "[rdsh] compaction policy: OFF; rdsh-compaction.json {reason}"
            )]
        );
        assert!(doctor_warnings(&off).is_empty());
    }

    #[test]
    fn doctor_says_when_the_feature_and_the_file_do_not_line_up() {
        let unused = report_for("unused", false, Some(DOCUMENT));
        assert_eq!(
            doctor_lines(&unused, Locale::English),
            vec![
                "[rdsh] compaction policy: OFF; rdsh-compaction.json lists 1 route(s) that are not passed to DSH — enable with: rdsh features on compaction_policy".to_string()
            ]
        );
        let missing = report_for("missing", true, None);
        assert_eq!(
            doctor_lines(&missing, Locale::English),
            vec![
                "[rdsh] compaction policy: ON, but DSH_HOME has no rdsh-compaction.json; routes stay on the DSH defaults".to_string()
            ]
        );
        let empty = report_for("empty", true, Some(r#"{"schema":1,"policies":[]}"#));
        assert_eq!(
            doctor_lines(&empty, Locale::English),
            vec![
                "[rdsh] compaction policy: ON, but rdsh-compaction.json lists no routes; routes stay on the DSH defaults".to_string()
            ]
        );
        for report in [&unused, &missing, &empty] {
            assert!(doctor_warnings(report).is_empty());
        }
    }

    #[test]
    fn doctor_caps_the_route_list() {
        let policies: Vec<AbsolutePolicy> = (0..DOCTOR_ROUTES + 2)
            .map(|index| AbsolutePolicy {
                provider: "hai".to_string(),
                model: format!("model-{index}"),
                context_window: 1_000_000,
                output_reserve: 8_192,
                trigger_tokens: 150_000,
                retain_tokens: 20_000,
                max_tokens: 8_192,
            })
            .collect();
        let at_the_cap = Report {
            enabled: true,
            file: FileState::Policies(policies[..DOCTOR_ROUTES].to_vec()),
        };
        assert_eq!(
            doctor_lines(&at_the_cap, Locale::English).len(),
            1 + DOCTOR_ROUTES
        );

        let over_the_cap = Report {
            enabled: true,
            file: FileState::Policies(policies),
        };
        let lines = doctor_lines(&over_the_cap, Locale::English);
        assert_eq!(lines.len(), 1 + DOCTOR_ROUTES + 1);
        assert!(lines[0].contains("7 route(s)"), "{lines:?}");
        assert!(lines[DOCTOR_ROUTES].contains("model-4"), "{lines:?}");
        assert_eq!(
            lines[DOCTOR_ROUTES + 1],
            "[rdsh] compaction policy:   ... and 2 more route(s)"
        );
    }

    #[test]
    fn doctor_lines_are_localized_and_terminal_safe() {
        // U+202E is not a control character, so it passes the checks of a
        // boot and reaches doctor. It must not reach the terminal.
        let document = DOCUMENT.replace("deepseek-v4-flash", "flash\\u202egnp");
        let report = report_for("locale", true, Some(&document));
        assert!(
            matches!(&report.file, FileState::Policies(policies) if policies[0].model.contains('\u{202e}')),
            "{report:?}"
        );
        for (locale, summary, route) in [
            (
                Locale::English,
                "[rdsh] compaction policy: ON, 1 route(s) from rdsh-compaction.json",
                "  hai / flashgnp: compacts at 150000 tokens, keeps the last 20000, summary cap 8192",
            ),
            (
                Locale::Chinese,
                "[rdsh] 压缩阈值: 已开启，rdsh-compaction.json 中有 1 条路由",
                "  hai / flashgnp：达到 150000 token 时压缩，保留最近 20000 token，摘要上限 8192 token",
            ),
            (
                Locale::Japanese,
                "[rdsh] 圧縮のしきい値: ONです。rdsh-compaction.json の 1 件",
                "  hai / flashgnp: 150000 トークンで圧縮、直近の 20000 トークンを残す、要約の上限 8192 トークン",
            ),
        ] {
            let lines = doctor_lines(&report, locale);
            assert_eq!(lines.len(), 2, "{lines:?}");
            assert!(lines[0].starts_with(summary), "{lines:?}");
            assert!(lines[1].ends_with(route), "{lines:?}");
            assert!(!lines.concat().contains('\u{202e}'), "{lines:?}");
        }
    }
}
