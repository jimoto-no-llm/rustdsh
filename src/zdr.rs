//! ZDR mode for compaction (docs/ZDR.md, RQ-10).
//!
//! This is the part of the ZDR requirements that compaction needs: with ZDR
//! mode on, a boot is refused when a compaction would send conversation
//! content to a route that is not verified as zero data retention. The rest of
//! the ZDR requirements (route exclusion, header injection, `rdsh auth`
//! display) is not implemented here.
//!
//! The verdicts come from the hand-maintained table of docs/ZDR.md. A route
//! that is not in the table, or whose verdict is `unknown`, is refused: the
//! check fails closed. A user declaration is not accepted as evidence.

/// Feature switch id (`features.zdr`).
pub const FEATURE_ID: &str = "zdr";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing leaves the machine; no request is needed.
    SelfHosted,
    /// Available when this header is sent with the request.
    Header(&'static str),
    /// Available through a body field or account setting rdsh cannot confirm.
    Unconfirmable,
    Unavailable,
    Unknown,
}

pub struct Entry {
    pub provider: &'static str,
    pub verdict: Verdict,
    pub source_url: Option<&'static str>,
    pub checked_at: &'static str,
}

/// The table of docs/ZDR.md, by route id.
pub const TABLE: [Entry; 5] = [
    Entry {
        provider: "commandcode",
        verdict: Verdict::Header("x-cmd-zdr"),
        source_url: Some("https://commandcode.ai/docs/resources/zdr"),
        checked_at: "2026-10-14",
    },
    Entry {
        provider: "openrouter",
        verdict: Verdict::Unconfirmable,
        source_url: Some("https://openrouter.ai/docs/features/zdr"),
        checked_at: "2026-10-14",
    },
    Entry {
        provider: "sarashina",
        verdict: Verdict::Unavailable,
        source_url: Some("https://www.sbintuitions.co.jp/news/press/20261013_01/"),
        checked_at: "2026-10-14",
    },
    Entry {
        provider: "hai",
        verdict: Verdict::Unknown,
        source_url: None,
        checked_at: "2026-10-14",
    },
    Entry {
        provider: "local-openai",
        verdict: Verdict::SelfHosted,
        source_url: None,
        checked_at: "2026-10-14",
    },
];

pub fn verdict(provider: &str) -> Verdict {
    TABLE
        .iter()
        .find(|entry| entry.provider == provider)
        .map_or(Verdict::Unknown, |entry| entry.verdict)
}

/// Whether ZDR mode is on: `RDSH_ZDR=1` / `RDSH_ZDR=0` wins over the saved
/// feature switch. Any other value of the variable is ignored.
pub fn mode_on(cfg: &crate::rdsh_config::RdshSettings, env: Option<&str>) -> bool {
    match env {
        Some("1") => true,
        Some("0") => false,
        _ => crate::rdsh_config::feature_enabled(cfg, FEATURE_ID),
    }
}

/// Doctor lines while ZDR mode is on: what the mode covers, and the table
/// with its evidence. Nothing is printed while the mode is off.
pub fn doctor_lines(on: bool) -> Vec<String> {
    if !on {
        return Vec::new();
    }
    let mut lines = vec![
        "[rdsh] ZDR mode: on; a boot is refused when compaction would send content to a route below that is not usable (other requests are not checked yet)".to_string(),
    ];
    for entry in &TABLE {
        let verdict = match entry.verdict {
            Verdict::SelfHosted => "available (self-hosted)".to_string(),
            Verdict::Header(header) => format!("available only when the profile sends {header}: 1"),
            Verdict::Unconfirmable => {
                "not usable (the request cannot be confirmed from rdsh)".to_string()
            }
            Verdict::Unavailable => "unavailable".to_string(),
            Verdict::Unknown => "unknown (treated as unavailable)".to_string(),
        };
        lines.push(format!(
            "[rdsh] ZDR mode:   {}: {verdict}; source {}; checked {}",
            entry.provider,
            entry.source_url.unwrap_or("none"),
            entry.checked_at
        ));
    }
    lines.push("[rdsh] ZDR mode:   any other route: unknown (treated as unavailable)".to_string());
    lines
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn scalar(value: &str) -> String {
    value.trim().trim_matches(['\'', '"']).to_string()
}

/// Routes a composed profile sends summaries to without the settings file
/// saying so: the default model's route, and any `summarizationProvider`.
fn profile_destinations(composed: &str) -> Vec<(&'static str, String)> {
    let mut found = Vec::new();
    for entry in crate::webui_gzip::split_entries(composed) {
        let default_model = entry.starts_with("- id: agent-default-model\n");
        for line in entry.lines() {
            let text = line.trim();
            if text.starts_with('#') {
                continue;
            }
            if default_model && indent_of(line) == 4 {
                if let Some(value) = text.strip_prefix("provider:") {
                    found.push(("the default model route", scalar(value)));
                }
            }
            if let Some(value) = text.strip_prefix("summarizationProvider:") {
                found.push(("a summarizationProvider", scalar(value)));
            }
        }
    }
    found
}

/// Only pi-ai's provider-level headers are confirmed here. A header on another
/// route, model, disabled adapter or plugin does not establish what this route
/// sends. Unrecognized dump shapes fail closed.
fn header_sent(composed: &str, provider: &str, header: &str) -> bool {
    for entry in crate::webui_gzip::split_entries(composed) {
        let lines: Vec<_> = entry.lines().collect();
        if lines.first().map(|line| line.trim_end()) != Some("- id: llm-pi-ai")
            || lines
                .iter()
                .any(|line| indent_of(line) == 2 && line.trim() == "disabled: true")
        {
            continue;
        }
        let Some(start) = lines
            .iter()
            .position(|line| indent_of(line) == 4 && line.trim() == "providers:")
        else {
            continue;
        };
        let mut matching_provider = false;
        let mut in_headers = false;
        for line in &lines[start + 1..] {
            let text = line.trim();
            if text.is_empty() || text.starts_with('#') {
                continue;
            }
            match indent_of(line) {
                0..=4 => break,
                6 => {
                    matching_provider = text
                        .strip_suffix(':')
                        .is_some_and(|key| scalar(key) == provider);
                    in_headers = false;
                }
                8 => in_headers = matching_provider && text == "headers:",
                10 if in_headers => {
                    if let Some((key, value)) = text.split_once(':') {
                        if scalar(key) == header && scalar(value) == "1" {
                            return true;
                        }
                    }
                }
                _ => {}
            }
        }
    }
    false
}

fn acceptable(provider: &str, composed: &str) -> bool {
    match verdict(provider) {
        Verdict::SelfHosted => true,
        Verdict::Header(header) => header_sent(composed, provider, header),
        Verdict::Unconfirmable | Verdict::Unavailable | Verdict::Unknown => false,
    }
}

/// Check every route a compaction may send conversation content to.
///
/// `settings` holds the routes named by the compaction settings file, each
/// with a label such as `policies[0]`; routes whose method sends nothing are
/// left out by the caller. Returns the number of routes checked. The reason
/// names where the route was found and never echoes its name.
pub fn check_compaction(settings: &[(String, String)], composed: &str) -> Result<usize, String> {
    let mut all: Vec<(String, String)> = settings.to_vec();
    all.extend(
        profile_destinations(composed)
            .into_iter()
            .map(|(label, provider)| (label.to_string(), provider)),
    );
    for (label, provider) in &all {
        if !acceptable(provider, composed) {
            return Err(format!(
                "ZDR mode: compaction would send conversation content to a route that is not verified as zero data retention ({label}); see docs/ZDR.md"
            ));
        }
    }
    Ok(all.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dump(provider: &str, extra: &str) -> String {
        format!(
            "- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: {provider}\n    model: m\n- id: compaction-basic\n  name: '@deepseek-ai/dsh-compaction-basic'\n{extra}"
        )
    }

    #[test]
    fn unknown_unavailable_and_unlisted_routes_are_refused() {
        let reason = |label: &str| {
            Err(format!("ZDR mode: compaction would send conversation content to a route that is not verified as zero data retention ({label}); see docs/ZDR.md"))
        };
        assert_eq!(check_compaction(&[], &dump("local-openai", "")), Ok(1));
        for provider in ["hai", "sarashina", "openrouter", "some-new-route"] {
            assert_eq!(
                check_compaction(&[], &dump(provider, "")),
                reason("the default model route"),
                "{provider}"
            );
        }
        // A separate summarizer is a destination of its own.
        let split = dump(
            "local-openai",
            "  config:\n    summarizationProvider: hai\n    summarizationModel: flash\n",
        );
        assert_eq!(
            check_compaction(&[], &split),
            reason("a summarizationProvider")
        );
        // Routes named by the settings file are checked with their label.
        let settings = [
            ("policies[0]".to_string(), "local-openai".to_string()),
            ("routes[1]".to_string(), "hai".to_string()),
        ];
        assert_eq!(
            check_compaction(&settings, &dump("local-openai", "")),
            reason("routes[1]")
        );
        assert_eq!(
            check_compaction(&settings[..1], &dump("local-openai", "")),
            Ok(2)
        );
    }

    #[test]
    fn a_header_route_passes_only_when_the_profile_sends_the_header() {
        assert!(check_compaction(&[], &dump("commandcode", "")).is_err());
        for line in [
            "          x-cmd-zdr: '1'\n",
            "          x-cmd-zdr: 1\n",
            "          'x-cmd-zdr': \"1\"\n",
            "          \"x-cmd-zdr\": \"1\"\n",
        ] {
            let with_header = dump("commandcode", &format!("- id: llm-pi-ai\n  config:\n    providers:\n      commandcode:\n        headers:\n{line}"));
            assert_eq!(check_compaction(&[], &with_header), Ok(1), "{line}");
        }
        for line in ["        x-cmd-zdr: '0'\n", "        # x-cmd-zdr: '1'\n"] {
            let without = dump(
                "commandcode",
                &format!("- id: llm-pi-ai\n  config:\n{line}"),
            );
            assert!(check_compaction(&[], &without).is_err(), "{line}");
        }
    }

    #[test]
    fn a_header_outside_the_active_provider_does_not_verify_a_route() {
        let provider_headers =
            "    providers:\n      commandcode:\n        headers:\n          x-cmd-zdr: '1'\n";
        for extra in [
            "- id: llm-pi-ai\n  config:\n    providers:\n      other:\n        headers:\n          x-cmd-zdr: '1'\n".to_string(),
            format!("- id: unrelated\n  config:\n{provider_headers}"),
            format!("- id: llm-pi-ai\n  disabled: true\n  config:\n{provider_headers}"),
            "- id: llm-pi-ai\n  config:\n    providers:\n      commandcode:\n        models:\n          x-cmd-zdr: '1'\n".to_string(),
            "- id: llm-pi-ai\n  config:\n    providers:\n      commandcode:\n        headers:\n          x-cmd-zdr: '0'\n      other:\n        headers:\n          x-cmd-zdr: '1'\n".to_string(),
            "- id: llm-pi-ai\n  config:\n    providers:\n      commandcode:\n        headers:\n          x-cmd-zdr: 'true'\n".to_string(),
        ] {
            assert!(check_compaction(&[], &dump("commandcode", &extra)).is_err());
        }
    }

    #[test]
    fn the_environment_overrides_the_saved_switch_and_other_values_are_ignored() {
        let cfg = crate::rdsh_config::RdshSettings::default();
        assert!(!mode_on(&cfg, None));
        assert!(mode_on(&cfg, Some("1")));
        assert!(!mode_on(&cfg, Some("0")));
        assert!(!mode_on(&cfg, Some("yes")));
        let mut on = crate::rdsh_config::RdshSettings::default();
        on.features.values.insert(FEATURE_ID.to_string(), true);
        assert!(mode_on(&on, None));
        assert!(!mode_on(&on, Some("0")));
        assert!(mode_on(&on, Some("true")));
    }

    #[test]
    fn every_table_entry_names_when_it_was_checked() {
        for entry in &TABLE {
            assert_eq!(entry.checked_at.len(), 10, "{}", entry.provider);
            if matches!(
                entry.verdict,
                Verdict::Header(_) | Verdict::Unconfirmable | Verdict::Unavailable
            ) {
                assert!(entry.source_url.is_some(), "{}", entry.provider);
            }
        }
        assert_eq!(verdict("not-listed"), Verdict::Unknown);
        assert!(doctor_lines(false).is_empty());
        let lines = doctor_lines(true);
        assert_eq!(lines.len(), TABLE.len() + 2);
        assert!(lines[1].contains("commandcode: available only when the profile sends x-cmd-zdr: 1; source https://commandcode.ai/docs/resources/zdr; checked 2026-10-14"));
        assert!(lines
            .iter()
            .any(|line| line.contains("hai: unknown (treated as unavailable); source none")));
    }
}
