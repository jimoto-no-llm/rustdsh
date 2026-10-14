#[test]
fn resolves_explicit_language_before_the_environment() {
    let env = [("RDSH_LANG", "zh-CN"), ("LANG", "ja_JP.UTF-8")];
    assert_eq!(
        crate::locale::resolve(Some("ja"), "auto", &env),
        crate::locale::Locale::Japanese
    );
}

#[test]
fn environment_override_precedes_the_persisted_setting() {
    let env = [("RDSH_LANG", "ja"), ("LANG", "zh_CN.UTF-8")];
    assert_eq!(
        crate::locale::resolve(None, "en", &env),
        crate::locale::Locale::Japanese
    );
}

#[test]
fn resolves_settings_before_the_operating_system_locale() {
    let env = [("LC_ALL", "ja_JP.UTF-8")];
    assert_eq!(
        crate::locale::resolve(None, "zh-CN", &env),
        crate::locale::Locale::Chinese
    );
}

#[test]
fn falls_back_to_english_for_an_unknown_locale() {
    let env = [("LANG", "fr_FR.UTF-8")];
    assert_eq!(
        crate::locale::resolve(None, "auto", &env),
        crate::locale::Locale::English
    );
}

#[test]
fn an_explicit_unsupported_environment_locale_does_not_fall_through() {
    let env = [("LC_ALL", "C"), ("LANG", "ja_JP.UTF-8")];
    assert_eq!(
        crate::locale::resolve(None, "auto", &env),
        crate::locale::Locale::English
    );
}

#[test]
fn recognizes_windows_code_page_locale_names() {
    assert_eq!(
        crate::locale::parse("Japanese_Japan.932"),
        Some(crate::locale::Locale::Japanese)
    );
    assert_eq!(
        crate::locale::parse("Chinese_China.936"),
        Some(crate::locale::Locale::Chinese)
    );
}

#[test]
fn settings_default_to_automatic_language_selection() {
    assert_eq!(
        crate::rdsh_config::RdshSettings::default().general.language,
        "auto"
    );
}

#[test]
fn every_generated_command_and_argument_id_has_a_localized_help_entry() {
    fn assert_tree(command: &clap::Command, locale: crate::locale::Locale) {
        assert!(
            crate::localized_command_about(command.get_name(), locale).is_some(),
            "missing command description for {}",
            command.get_name()
        );
        for arg in command.get_arguments() {
            assert!(
                crate::localized_arg_help(arg.get_id().as_str(), locale).is_some(),
                "missing argument description for {} in {}",
                arg.get_id(),
                command.get_name()
            );
        }
        for subcommand in command.get_subcommands() {
            assert_tree(subcommand, locale);
        }
    }

    let mut command = <crate::Cli as clap::CommandFactory>::command();
    command.build();
    for locale in [
        crate::locale::Locale::Chinese,
        crate::locale::Locale::Japanese,
    ] {
        assert_tree(&command, locale);
    }
}

#[test]
fn english_help_uses_the_derive_generated_tree_unchanged() {
    let mut generated = <crate::Cli as clap::CommandFactory>::command();
    let mut localized = crate::localized_command(crate::locale::Locale::English);
    assert_eq!(
        generated.render_long_help().to_string(),
        localized.render_long_help().to_string()
    );
}

#[test]
fn native_message_catalog_has_text_for_every_supported_language() {
    use crate::locale::{native_message, Locale, NativeMessage};

    let messages = [
        NativeMessage::Preview,
        NativeMessage::Total,
        NativeMessage::SearchUnavailable,
        NativeMessage::CannotReadFile,
        NativeMessage::CannotAccessSearchDirectory,
        NativeMessage::InvalidSearxUrl,
        NativeMessage::OnlyHttpSearxUrl,
        NativeMessage::InvalidIpv6SearxHost,
        NativeMessage::InvalidSearxHost,
        NativeMessage::InvalidSearxPort,
        NativeMessage::SearxRequestTimedOut,
        NativeMessage::SearxRequestClosed,
        NativeMessage::SearxResponseTimedOut,
        NativeMessage::SearxResponseTooLarge,
        NativeMessage::BadSearxResponse,
        NativeMessage::SearxReturnedHttp,
        NativeMessage::NoSearxResultsPage,
    ];
    for locale in [Locale::English, Locale::Chinese, Locale::Japanese] {
        for message in messages {
            assert!(
                !native_message(locale, message).is_empty(),
                "{locale:?} {message:?}"
            );
        }
    }
}

#[test]
fn native_ui_catalog_has_text_for_every_supported_language() {
    use crate::locale::{ui_message, Locale, UiMessage};

    let messages = [
        UiMessage::NoDirectory,
        UiMessage::Items,
        UiMessage::Sessions,
        UiMessage::ShowingUpTo,
        UiMessage::Reading,
        UiMessage::Lines,
        UiMessage::Matching,
        UiMessage::ZstdUnavailable,
        UiMessage::CannotOpenLogFile,
        UiMessage::CannotReadLogFile,
        UiMessage::LogFileMustStayInside,
        UiMessage::NoLogs,
        UiMessage::ContextDisabled,
        UiMessage::ContextStatus,
        UiMessage::ContextBuild,
        UiMessage::ContextSearch,
        UiMessage::ContextExplain,
        UiMessage::NoHits,
        UiMessage::MissingFiles,
        UiMessage::GoalUnset,
        UiMessage::DesktopApp,
        UiMessage::DesktopCommand,
        UiMessage::DesktopProfile,
        UiMessage::DesktopPlugin,
        UiMessage::NotFound,
        UiMessage::Initialized,
        UiMessage::NotInitialized,
        UiMessage::Installed,
        UiMessage::Failed,
        UiMessage::DryRun,
        UiMessage::Guard,
        UiMessage::PatternHit,
        UiMessage::InvalidJsonInput,
        UiMessage::UnreadableOrOversizedInput,
        UiMessage::DesktopPluginMissing,
        UiMessage::DesktopProfileNotInitialized,
        UiMessage::DesktopNothingToInstall,
        UiMessage::DesktopInstallFailed,
    ];
    for locale in [Locale::English, Locale::Chinese, Locale::Japanese] {
        for message in messages {
            assert!(
                !ui_message(locale, message).is_empty(),
                "{locale:?} {message:?}"
            );
        }
    }
}

#[test]
fn chinese_log_path_diagnostic_uses_chinese_copy() {
    assert_eq!(
        crate::locale::ui_message(
            crate::locale::Locale::Chinese,
            crate::locale::UiMessage::LogFileMustStayInside
        ),
        "日志文件必须位于以下目录内："
    );
}
