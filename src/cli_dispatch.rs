use crate::cli_args::{
    AutoAction, Cli, ContextAction, DepsAction, DesktopAction, FeaturesAction, FilesAction,
    HookAction, ModelsAction, PluginsAction, ProviderAction, RustxngAction, SettingsAction,
    SubagentsAction, UpdateAction, WebUiAction, WorkerScopeAction,
};
use crate::{
    adapter_catalog, answer_applications, auth, budget_admission, cloud, compact, compaction_cli,
    compute, context, context_hook, cost_ledger, deps, desktop, desktop_webui, dsh_args, files,
    guard, inspect, instruction_queue, locale, models, native_harness, passthrough, plugins,
    plugins_release, provider_detect, providers, question_contracts, rdsh_config, rustxng, search,
    serial_proxy, serve, setup_web, subagent_plan, swarm, task_outcomes, tokens, update_auto,
    websearch, worker_git, worker_scopes,
};
use clap::{CommandFactory, Parser};

pub(crate) fn invoked_as_dsh() -> bool {
    let argv0 = std::env::args_os().next().unwrap_or_default();
    std::path::Path::new(&argv0)
        .file_name()
        .and_then(|s| s.to_str())
        // Native Windows installs run as dsh.exe.
        .is_some_and(|s| s == "dsh" || s == "dsh.exe")
}

pub(crate) fn run() {
    // A consumer that closes the pipe early (rdsh doctor | head) must end this
    // process quietly instead of panicking: with panic=abort a panic would dump
    // core. Only the broken-pipe panic is swallowed; every other panic keeps the
    // default hook (and the closed-stderr paths keep running, as their tests
    // require).
    let default_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| text.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        if message.contains("Broken pipe") {
            std::process::exit(0);
        }
        default_panic_hook(info);
    }));

    if invoked_as_dsh() {
        let raw: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
        let first_is_native = raw
            .first()
            .and_then(|s| s.to_str())
            .is_some_and(|s| crate::cli_args::NATIVE_FIRST.contains(&s));
        if !first_is_native {
            std::env::set_var("RDSH_SHARED_FILES", "[]");
            let scfg = rdsh_config::load();
            let slim =
                !passthrough::env_passthrough() && !scfg.general.passthrough && scfg.general.slim;
            let dry = passthrough::env_dry() || scfg.general.dry_run;
            crate::slim::configure(&scfg);
            crate::passthrough::configure_web_search_provider(&scfg);
            crate::tool_security::configure(agent_tool_sandbox(&scfg, false));
            if let Err(e) = passthrough::exec_raw(&raw, dry, slim) {
                eprintln!("[rdsh] error: {e:#}");
                std::process::exit(1);
            }
            return;
        }
        // else: fall through to the normal CLI (rdsh-native subcommand)
    }
    // Avoid reading settings only when Clap itself recognizes a version
    // display. Values after `--` and native positional arguments can use the
    // same bytes, so scanning raw argv would exit before their command runs.
    if let Err(error) = crate::Cli::try_parse_from(std::env::args_os()) {
        if error.kind() == clap::error::ErrorKind::DisplayVersion {
            error.exit();
        }
    }
    // Build the same derive-generated tree for parsing and help.  `dsh`
    // passthrough above never reaches this tree.
    let parse_locale = match requested_locale() {
        Ok(locale) => locale,
        Err((locale, error)) => {
            eprintln!(
                "[rdsh] {}: {error:#}",
                locale::message(locale, locale::Message::SettingsRead)
            );
            std::process::exit(1);
        }
    };
    let cli = crate::cli_args::parse_cli(parse_locale);
    // Fail fast on unusable selections (the tool boundary re-validates).
    if let Err(e) = crate::file_security::validate_share_files(&cli.share_file) {
        eprintln!("[rdsh] error: {e}");
        std::process::exit(2);
    }
    if matches!(cli.command.as_ref(), Some(crate::Commands::WorkerGit)) {
        if let Err(error) = worker_git::cmd() {
            eprintln!("[rdsh] error: {error:#}");
            std::process::exit(1);
        }
        return;
    }
    if let Some(crate::Commands::WorkerScope { action }) = &cli.command {
        let result = match action {
            WorkerScopeAction::Validate => worker_scopes::cmd_validate(parse_locale),
            WorkerScopeAction::Policy => worker_scopes::cmd_policy(parse_locale),
        };
        if let Err(error) = result {
            eprintln!(
                "[rdsh] {}: {error:#}",
                locale::message(parse_locale, locale::Message::Error)
            );
            std::process::exit(2);
        }
        return;
    }

    // Fast path: empty share list is by far the common case; skip JSON serializer.
    // Same bytes out ("[]"), one allocation saved per invocation.
    if cli.share_file.is_empty() {
        std::env::set_var("RDSH_SHARED_FILES", "[]");
    } else {
        std::env::set_var(
            "RDSH_SHARED_FILES",
            serde_json::to_string(&cli.share_file).unwrap(),
        );
    }
    // Recovery, pure task-outcome and cost-ledger validators, and the pure
    // subagent planner do not depend on settings. Commands that use settings
    // still fail closed on a corrupt document.
    // A DSH hook must never block a prompt. `context inject` therefore runs
    // before anything reads the settings document: a corrupt or unreadable
    // rdsh.json must not turn an injection into a failed hook call.
    if let Some(crate::Commands::Context {
        action:
            ContextAction::Inject {
                event,
                query,
                sessions,
                json,
            },
    }) = &cli.command
    {
        let _ = context::cmd_inject(event.as_str(), query.clone(), *sessions, *json);
        std::process::exit(0);
    }
    // Explicit recovery must work even when the current settings cannot be read.
    // Every other command still fails closed on a corrupt settings document.
    let cfg = if matches!(
        &cli.command,
        Some(crate::Commands::Settings {
            action: SettingsAction::Init { force: true }
        }) | Some(crate::Commands::TaskOutcomes { .. })
            | Some(crate::Commands::BudgetAdmission { .. })
            | Some(crate::Commands::Compaction { .. })
            | Some(crate::Commands::QuestionContracts { .. })
            | Some(crate::Commands::AnswerApplications { .. })
            | Some(crate::Commands::InstructionQueue { .. })
            | Some(crate::Commands::Subagents { .. })
            | Some(crate::Commands::CostLedger { .. })
            | Some(crate::Commands::AdapterCatalog)
            | Some(crate::Commands::Swarm { .. })
            | Some(crate::Commands::Cloud { .. })
    ) {
        rdsh_config::RdshSettings::default()
    } else {
        rdsh_config::load_with_locale(parse_locale)
    };
    let locale = locale::current(cli.language.as_deref(), &cfg.general.language);
    // Feature switches (rdsh features) steer the delegated-run env and the
    // native session caches; an explicit environment variable still wins.
    crate::slim::configure(&cfg);
    crate::passthrough::configure_web_search_provider(&cfg);
    crate::tool_security::configure(agent_tool_sandbox(&cfg, !cli.share_file.is_empty()));
    if !rdsh_config::feature_enabled(&cfg, "sessions_token_cache")
        && std::env::var_os("RDSH_TOKENS_CACHE").is_none()
    {
        std::env::set_var("RDSH_TOKENS_CACHE", "0");
    }
    let pass = cli.passthrough || passthrough::env_passthrough() || cfg.general.passthrough;
    let slim = !cli.no_slim && !pass && (cli.slim || cfg.general.slim);
    let dry = cli.dry_run || passthrough::env_dry() || cfg.general.dry_run;
    let mut exit_code = 0;
    let result: anyhow::Result<()> = match cli.command {
        Some(crate::Commands::Swarm { options, action }) => {
            swarm::run(options, action).map(|code| exit_code = code)
        }
        Some(crate::Commands::Cloud { options, action }) => {
            cloud::run(options, action).map(|code| exit_code = code)
        }
        Some(crate::Commands::AdapterCatalog) => adapter_catalog::cmd_adapter_catalog(),
        Some(crate::Commands::Tokens { files, preview }) => {
            tokens::cmd_tokens(files, preview, locale)
        }
        Some(crate::Commands::Prune { max_tokens, file }) => tokens::cmd_prune(
            max_tokens.unwrap_or(cfg.tokens.default_budget),
            file,
            locale,
        ),
        Some(crate::Commands::Search { pattern, dir, max }) => {
            let dir = dir.unwrap_or_else(|| cfg.search.dir.clone());
            search::cmd_search(&pattern, &dir, max.unwrap_or(cfg.search.max), locale)
        }
        Some(crate::Commands::SearchWeb {
            query,
            limit,
            json,
            provider,
            engine,
            auto_start,
        }) => {
            if !rdsh_config::feature_enabled(&cfg, "search-web") {
                extra_disabled("search-web", locale)
            } else {
                websearch::cmd_search_web(
                    &query,
                    limit.unwrap_or(cfg.search.web_limit),
                    json,
                    provider,
                    engine,
                    auto_start,
                    locale,
                )
            }
        }
        Some(crate::Commands::Compact { file, max_tokens }) => {
            compact::cmd_compact(&file, max_tokens.unwrap_or(cfg.compact.max_tokens), locale)
        }
        Some(crate::Commands::Compaction { action }) => compaction_cli::run(action),
        Some(crate::Commands::Doctor { json: true }) => crate::doctor::doctor_json(),
        Some(crate::Commands::Doctor { json: false }) => {
            crate::doctor::doctor(crate::doctor::DoctorMode::from_terminal(locale), locale)
        }
        Some(crate::Commands::Sessions {
            project,
            limit,
            tokens,
            json,
        }) => inspect::cmd_sessions(
            project,
            limit.unwrap_or(cfg.sessions.limit),
            tokens || cfg.sessions.with_tokens,
            json,
            cfg.sessions.stale_secs,
            locale,
        ),
        Some(crate::Commands::Profiles) => inspect::cmd_profiles(locale),
        Some(crate::Commands::Skills) => inspect::cmd_skills(locale),
        Some(crate::Commands::Logs { tail, grep, file }) => {
            inspect::cmd_logs(tail.unwrap_or(cfg.logs.tail), grep, file, locale)
        }
        Some(crate::Commands::NativeTui {
            backend,
            workspace,
            sdk_dir,
            dsh_profile,
            dsh_catalog,
            devin_bin,
            provider,
            model,
        }) => native_harness::cmd_native_tui(
            backend,
            workspace,
            sdk_dir,
            dsh_profile,
            dsh_catalog,
            devin_bin,
            provider,
            model,
            locale,
        ),
        Some(crate::Commands::NativeWeb {
            port,
            workspace,
            sdk_dir,
            dsh_profile,
            dsh_catalog,
            devin_bin,
        }) => native_harness::cmd_native_web(
            port,
            workspace,
            sdk_dir,
            dsh_profile,
            dsh_catalog,
            devin_bin,
            locale,
        ),
        Some(crate::Commands::Serve { port }) => {
            if !rdsh_config::feature_enabled(&cfg, "serve") {
                extra_disabled("serve", locale)
            } else {
                serve::cmd_serve(port.unwrap_or(cfg.serve.port), locale)
            }
        }
        Some(crate::Commands::SerialProxy {
            upstream,
            port,
            host,
            allow_remote,
            max,
            queue_timeout,
            max_queue,
            tool_choice_default,
            max_body_bytes,
            rpm,
        }) => serial_proxy::cmd_serial_proxy(
            serial_proxy::SerialProxyOptions {
                upstream,
                port,
                host,
                allow_remote,
                max,
                queue_timeout,
                max_queue,
                tool_choice_default: tool_choice_default.map(|choice| choice.as_str().to_string()),
                max_body_bytes,
                rpm,
            },
            locale,
        ),
        Some(crate::Commands::WorkerGit) => unreachable!("worker-git handled before settings load"),
        Some(crate::Commands::Rustxng { action }) => match action {
            RustxngAction::Status { json } => rustxng::cmd_status(json, locale),
            RustxngAction::Start => rustxng::cmd_start(locale),
            RustxngAction::Stop => rustxng::cmd_stop(locale),
            RustxngAction::Install => rustxng::cmd_install(locale),
            RustxngAction::Update {
                check,
                json,
                background,
            } => rustxng::update::cmd_update(check, json, background, locale),
        },
        Some(crate::Commands::Bench { n }) => bench(n.unwrap_or(cfg.bench.n), locale),
        Some(crate::Commands::Compute { once }) => compute::cmd_compute(once, locale),
        Some(crate::Commands::WorkerScope { .. }) => {
            unreachable!("worker-scope returns before settings load")
        }

        Some(crate::Commands::Guard {
            deny,
            policy_file,
            reason,
            json,
        }) => {
            let mut merged = cfg.guard.deny.clone();
            merged.extend(deny);
            let reason = reason.or_else(|| {
                let r = cfg.guard.reason.trim().to_string();
                if r.is_empty() {
                    None
                } else {
                    Some(r)
                }
            });
            guard::cmd_guard(merged, reason, json, policy_file, locale)
        }
        Some(crate::Commands::Update { action }) => match action {
            UpdateAction::Auto { action } => match action {
                AutoAction::Status { json } => {
                    update_auto::cmd_update_auto("status", false, json, false, locale)
                }
                AutoAction::On {
                    dry_run,
                    json,
                    force,
                } => update_auto::cmd_update_auto("on", dry_run, json, force, locale),
                AutoAction::Off { dry_run, json } => {
                    update_auto::cmd_update_auto("off", dry_run, json, false, locale)
                }
            },
        },
        Some(crate::Commands::Settings { action }) => match action {
            SettingsAction::Path => {
                println!("{}", rdsh_config::settings_path());
                Ok(())
            }
            SettingsAction::Show { json } => {
                // Reuse outer cfg (same file, same parse); second load was pure overhead.
                let v = cfg.to_value();
                if json {
                    match serde_json::to_string_pretty(&v) {
                        Ok(text) => {
                            println!("{text}");
                            Ok(())
                        }
                        Err(e) => Err(anyhow::anyhow!(e)),
                    }
                } else {
                    // Effective values per editable key with their source:
                    // `config` = explicitly present in rdsh.json,
                    // `default` = built-in fallback. `settings keys` remains
                    // the editable-key list.
                    println!(
                        "{}: {}",
                        crate::locale::pick(locale, "config", "配置", "設定"),
                        rdsh_config::settings_path()
                    );
                    let raw: serde_json::Value =
                        std::fs::read_to_string(rdsh_config::settings_path())
                            .ok()
                            .and_then(|text| serde_json::from_str(&text).ok())
                            .unwrap_or_default();
                    for annotated in rdsh_config::RdshSettings::keys() {
                        let key = annotated.split('(').next().unwrap_or(annotated);
                        let value = cfg.get_dotted(key).unwrap_or_default();
                        let rendered = match value {
                            serde_json::Value::String(s) => s,
                            v => serde_json::to_string(&v).unwrap_or_else(|_| "-".to_string()),
                        };
                        let source = if settings_key_in_file(&raw, key) {
                            crate::locale::pick(locale, "config", "配置", "設定")
                        } else {
                            crate::locale::pick(locale, "default", "默认", "既定値")
                        };
                        println!("{key}  {rendered}  {source}");
                    }
                    // Features show their effective state, not just what is written.
                    for annotated in rdsh_config::RdshSettings::feature_keys() {
                        let key = annotated.split('(').next().unwrap_or(annotated.as_str());
                        let id = key.strip_prefix("features.").unwrap_or(key);
                        let state = if rdsh_config::feature_enabled(&cfg, id) {
                            "true"
                        } else {
                            "false"
                        };
                        let source = if rdsh_config::feature_is_explicit(&cfg, id) {
                            crate::locale::pick(locale, "config", "配置", "設定")
                        } else {
                            crate::locale::pick(locale, "default", "默认", "既定値")
                        };
                        println!("{key}  {state}  {source}");
                    }
                    Ok(())
                }
            }
            SettingsAction::Init { force } => {
                let path = rdsh_config::settings_path();
                match rdsh_config::initialize(force, locale) {
                    Ok(true) => {
                        println!("{path}");
                        Ok(())
                    }
                    Ok(false) => {
                        eprintln!(
                            "[rdsh] {} {path} ({})",
                            locale::message(locale, locale::Message::SettingsExists),
                            crate::locale::pick(
                                locale,
                                "use --force to overwrite",
                                "使用 --force 覆盖",
                                "上書きするには --force を使います"
                            )
                        );
                        std::process::exit(2);
                    }
                    Err(e) => Err(e),
                }
            }
            SettingsAction::Get { key, json } => match cfg.get_dotted(&key) {
                Some(v) => {
                    if json || v.is_object() || v.is_array() {
                        match serde_json::to_string_pretty(&v) {
                            Ok(text) => {
                                println!("{text}");
                                Ok(())
                            }
                            Err(e) => Err(anyhow::anyhow!(e)),
                        }
                    } else if let Some(s) = v.as_str() {
                        println!("{s}");
                        Ok(())
                    } else {
                        println!("{v}");
                        Ok(())
                    }
                }
                None => {
                    eprintln!(
                        "[rdsh] {}: {key} ({})",
                        locale::message(locale, locale::Message::UnknownSetting),
                        crate::locale::pick(
                            locale,
                            "try: rdsh settings keys",
                            "请尝试: rdsh settings keys",
                            "rdsh settings keys を実行してください"
                        )
                    );
                    std::process::exit(2);
                }
            },
            SettingsAction::Set { key, value } => {
                match rdsh_config::update(locale, |cfg| {
                    cfg.set_dotted_with_locale(&key, &value, locale)
                }) {
                    Err(e) => Err(e),
                    Ok((cfg, ())) => match cfg.get_dotted(&key) {
                        Some(v) => {
                            if v.is_string() {
                                println!("{}={}", key.trim(), v.as_str().unwrap_or_default());
                                Ok(())
                            } else {
                                match serde_json::to_string(&v) {
                                    Ok(text) => {
                                        println!("{}={text}", key.trim());
                                        Ok(())
                                    }
                                    Err(e) => Err(anyhow::anyhow!(e)),
                                }
                            }
                        }
                        None => Err(anyhow::anyhow!(crate::locale::pick(
                            locale,
                            format!("set failed: {key}"),
                            format!("设置失败: {key}"),
                            format!("設定に失敗しました: {key}")
                        ))),
                    },
                }
            }
            SettingsAction::Unset { key } => {
                match rdsh_config::update(locale, |cfg| cfg.reset_dotted_with_locale(&key, locale))
                {
                    Err(e) => Err(e),
                    Ok(_) => {
                        println!(
                            "{} {} ({})",
                            locale::message(locale, locale::Message::Reset),
                            key.trim(),
                            crate::locale::pick(
                                locale,
                                format!("saved to {}", rdsh_config::settings_path()),
                                format!("已保存到 {}", rdsh_config::settings_path()),
                                format!("{} に保存しました", rdsh_config::settings_path())
                            ),
                        );
                        Ok(())
                    }
                }
            }
            SettingsAction::Keys => {
                for k in rdsh_config::RdshSettings::keys() {
                    println!("{k}");
                }
                for k in rdsh_config::RdshSettings::feature_keys() {
                    println!("{k}");
                }
                Ok(())
            }
        },
        Some(crate::Commands::TaskOutcomes { action, input_file }) => {
            task_outcomes::cmd_task_outcomes(&action, &input_file, locale)
        }
        Some(crate::Commands::BudgetAdmission { action, input_file }) => {
            budget_admission::cmd_budget_admission(&action, &input_file, locale)
        }
        Some(crate::Commands::QuestionContracts { action, input_file }) => {
            question_contracts::cmd_question_contracts(&action, &input_file, locale)
        }
        Some(crate::Commands::AnswerApplications { action, input_file }) => {
            answer_applications::cmd_answer_applications(&action, &input_file, locale)
        }
        Some(crate::Commands::InstructionQueue { action, input_file }) => match action.as_str() {
            "serve" if input_file.is_none() => instruction_queue::cmd_instruction_queue_serve(),
            "serve" => Err(anyhow::anyhow!(
                "instruction-queue serve does not accept --input-file"
            )),
            _ => match input_file {
                Some(input_file) => {
                    instruction_queue::cmd_instruction_queue(&action, &input_file, locale)
                }
                None => Err(anyhow::anyhow!(
                    "--input-file is required for instruction-queue actions"
                )),
            },
        },
        Some(crate::Commands::Features { action, json }) => match action {
            None => features_list(&cfg, json, locale),
            Some(FeaturesAction::On { id }) => features_toggle(&id, true, locale),
            Some(FeaturesAction::Off { id }) => features_toggle(&id, false, locale),
        },
        Some(crate::Commands::Subagents { action }) => match action {
            SubagentsAction::Plan { input_file, .. } => {
                subagent_plan::cmd_plan(&input_file, locale)
            }
            SubagentsAction::Defaults { .. } => subagent_plan::cmd_defaults(locale),
        },
        Some(crate::Commands::CostLedger { action, input_file }) => {
            cost_ledger::cmd_cost_ledger(&action, &input_file, locale)
        }
        Some(crate::Commands::Desktop { action, json }) => match action {
            None => desktop::cmd_status(json, locale),
            Some(DesktopAction::Status { json: inner }) => {
                desktop::cmd_status(json || inner, locale)
            }
            Some(DesktopAction::Install {
                dry_run,
                plugins_dir,
                compute,
                no_sound,
                no_gitview,
                no_intelligent_ui,
                package,
                no_bundled,
                json: inner,
            }) => desktop::cmd_install(
                desktop::InstallOptions {
                    plugins_dir,
                    packages: package,
                    no_bundled,
                    dry_run,
                    compute,
                    no_sound: no_sound || !rdsh_config::feature_enabled(&cfg, "sound"),
                    no_gitview: no_gitview || !rdsh_config::feature_enabled(&cfg, "gitview"),
                    no_intelligent_ui,
                    json: json || inner,
                },
                locale,
            ),
            Some(DesktopAction::Verify {
                require,
                json: inner,
            }) => desktop::cmd_verify(&require, json || inner, locale),
            Some(DesktopAction::WebUi { action }) => match action {
                WebUiAction::Status { json: inner } => {
                    desktop_webui::cmd_web_ui("status", json || inner, locale)
                }
                WebUiAction::On { json: inner } => {
                    desktop_webui::cmd_web_ui("on", json || inner, locale)
                }
                WebUiAction::Off { json: inner } => {
                    desktop_webui::cmd_web_ui("off", json || inner, locale)
                }
            },
        },
        Some(crate::Commands::Plugins { action, json }) => {
            // The default profile comes from settings/env, so resolution is
            // fallible; the arm itself still returns Result for the outer match.
            profile_or_default(cli.profile.clone(), &cfg.general.default_profile, locale).and_then(
                |profile| match action {
                    None => plugins::cmd_status(&profile, None, json, locale),
                    Some(PluginsAction::Status {
                        plugins_dir,
                        json: inner,
                    }) => {
                        plugins::cmd_status(&profile, plugins_dir.as_deref(), json || inner, locale)
                    }
                    Some(PluginsAction::Install {
                        dry_run,
                        plugins_dir,
                        recommended,
                        no_bundled,
                        latest,
                        json: inner,
                    }) => plugins::cmd_install(
                        plugins::InstallRequest {
                            profile,
                            plugins_dir,
                            recommended,
                            no_bundled,
                            latest,
                            dry_run,
                            json: json || inner,
                        },
                        locale,
                    ),
                    Some(PluginsAction::Update {
                        check,
                        json: inner,
                        background,
                    }) => plugins_release::cmd_update(
                        &profile,
                        check,
                        json || inner,
                        background,
                        locale,
                    ),
                },
            )
        }
        Some(crate::Commands::Context { action }) => {
            // inject runs as a DSH hook: it must never block a prompt, so it
            // decides internally (feature switch + fail-open) and always exits 0.
            if let ContextAction::Inject {
                event,
                query,
                sessions,
                json,
            } = action
            {
                context::cmd_inject(&event, query, sessions, json)
            } else {
                let engine_on = rdsh_config::feature_enabled(&cfg, "context_engine");
                match action {
                    // Hook wiring edits a config file; it stays usable with the
                    // engine off, but says plainly that nothing will be injected.
                    ContextAction::Hook { action } => {
                        if !engine_on {
                            eprintln!(
                                "[rdsh] note: context_engine is OFF — the hook injects nothing until: rdsh features on context_engine"
                            );
                        }
                        match action {
                            HookAction::Install {
                                path,
                                rdsh,
                                dry_run,
                                json,
                            } => context_hook::cmd_hook("install", path, rdsh, dry_run, json),
                            HookAction::Status { path, json } => {
                                context_hook::cmd_hook("status", path, None, false, json)
                            }
                            HookAction::Remove {
                                path,
                                dry_run,
                                json,
                            } => context_hook::cmd_hook("remove", path, None, dry_run, json),
                        }
                    }
                    _ if !engine_on => {
                        eprintln!(
                            "[rdsh] {}",
                            locale::ui_message(locale, locale::UiMessage::ContextDisabled)
                        );
                        std::process::exit(2);
                    }
                    ContextAction::Build {
                        query,
                        budget,
                        sessions,
                        require_stable,
                        json,
                    } => context::cmd_build(
                        context::BuildOptions {
                            query,
                            budget,
                            sessions,
                            require_stable,
                            json,
                        },
                        locale,
                    ),
                    ContextAction::Search { query, max } => {
                        context::cmd_search(query, max.unwrap_or(cfg.context.max_code_hits), locale)
                    }
                    ContextAction::Status { json } => context::cmd_status(json, locale),
                    ContextAction::Explain { query, budget } => {
                        context::cmd_explain(query, budget, locale)
                    }
                    ContextAction::Remember { text, kind, json } => {
                        context::cmd_remember(text, kind, json)
                    }
                    ContextAction::Memory { json } => context::cmd_memory(json),
                    ContextAction::Distill {
                        session,
                        apply,
                        json,
                    } => context::cmd_distill(session, apply, json),
                    ContextAction::Forget { id, json } => context::cmd_forget(id, json),
                    // inject and hook are handled above.
                    ContextAction::Inject { .. } => Ok(()),
                }
            }
        }
        Some(crate::Commands::Deps { action }) => {
            if !rdsh_config::feature_enabled(&cfg, "dep_graph") {
                eprintln!(
                    "[rdsh] {}",
                    locale::ui_message(locale, locale::UiMessage::DepGraphDisabled)
                );
                std::process::exit(2);
            }
            match action {
                DepsAction::Build { root, force, json } => deps::cmd_build(root, force, json),
                DepsAction::Query { symbol, json } => deps::cmd_query(symbol, json),
                DepsAction::Impact {
                    target,
                    depth,
                    json,
                } => deps::cmd_impact(target, depth.unwrap_or(3).clamp(1, 8), json),
            }
        }
        Some(crate::Commands::Files { action }) => match action {
            FilesAction::List { session, json } => {
                files::cmd_list(session.as_deref(), json, locale)
            }
            FilesAction::Get {
                path,
                out,
                session,
                force,
            } => files::cmd_get(&path, out.as_deref(), session.as_deref(), force, locale),
        },
        Some(crate::Commands::Models {
            action,
            provider,
            json,
        }) => match action {
            None => models::cmd_models_show(cli.profile.as_deref(), provider.as_deref(), json),
            Some(ModelsAction::Sync {
                profile,
                provider: sync_provider,
                dry_run,
                auto,
                json: sync_json,
            }) => models::cmd_models_sync(
                profile.or(cli.profile).as_deref(),
                sync_provider.or(provider).as_deref(),
                dry_run || dry,
                auto,
                sync_json || json,
            ),
            Some(ModelsAction::Efforts {
                profile,
                provider: effort_provider,
                dry_run,
                json: effort_json,
            }) => models::cmd_models_efforts(
                profile.or(cli.profile).as_deref(),
                effort_provider.or(provider).as_deref(),
                dry_run || dry,
                effort_json || json,
            ),
        },
        Some(crate::Commands::Auth(args)) => auth::cmd_auth(args, dry, locale),
        Some(crate::Commands::Provider { action }) => match action {
            ProviderAction::List { json } => providers::cmd_list(json, locale),
            ProviderAction::Detect { json } => provider_detect::cmd_detect(json, locale),
            ProviderAction::Import {
                profile,
                only,
                no_discover,
                json,
            } => provider_detect::cmd_import(
                provider_detect::ImportArgs {
                    profile: profile.or(cli.profile),
                    only,
                    discover: !no_discover,
                    dry_run: cli.dry_run,
                    json,
                },
                &cfg.general.default_profile,
                locale,
            ),
            ProviderAction::Add {
                preset,
                profile,
                model,
                from_opencode,
                discover,
                base_url,
                id,
                name,
                key_stdin,
                no_key,
                effort,
                no_probe,
                input,
                replace,
                json,
            } => providers::cmd_add(
                providers::AddArgs {
                    preset,
                    profile: profile.or(cli.profile),
                    models: model,
                    from_opencode,
                    discover,
                    base_url,
                    id,
                    name,
                    key_stdin,
                    no_key,
                    effort,
                    no_probe,
                    input,
                    replace,
                    quiet: false,
                    // The global flag only: general.dry_run in settings is
                    // about delegated launches, not about file edits.
                    dry_run: cli.dry_run,
                    json,
                },
                &cfg.general.default_profile,
                locale,
            ),
        },
        Some(crate::Commands::Setup {
            open,
            login,
            json,
            yes,
            web,
            port,
            no_auto_import,
        }) => {
            // 明示された --profile を尊重し、無ければ既定（無ければ web）へ倒す。
            let setup_profile =
                profile_or_default(cli.profile.clone(), &cfg.general.default_profile, locale)
                    .unwrap_or_else(|_| "web".to_string());
            if web && !dry {
                if rdsh_config::feature_enabled(&cfg, "setup_web") {
                    setup_web::cmd_setup_web(
                        port.unwrap_or(cfg.setup.web_port),
                        &setup_profile,
                        !no_auto_import,
                        locale,
                    )
                } else {
                    Err(anyhow::anyhow!(match locale {
                        locale::Locale::English => {
                            "rdsh setup --web is off; enable with: rdsh features on setup_web"
                        }
                        locale::Locale::Chinese => {
                            "rdsh setup --web 已关闭；请启用：rdsh features on setup_web"
                        }
                        locale::Locale::Japanese => {
                            "rdsh setup --web はオフです。有効化: rdsh features on setup_web"
                        }
                    }))
                }
            } else {
                auth::cmd_setup(
                    open,
                    login,
                    json,
                    yes,
                    dry,
                    &setup_profile,
                    !no_auto_import,
                    locale,
                )
            }
        }
        Some(crate::Commands::DumpConfig { profile, native }) => profile_or_default(
            profile.or(cli.profile),
            &cfg.general.default_profile,
            locale,
        )
        .and_then(|p| {
            if native {
                dump_config_native(&p, &cli.patch, locale)
            } else {
                passthrough::exec_dump_config(
                    &p,
                    None,
                    dsh_args::DumpKind::Config,
                    &cli.patch,
                    dry,
                    slim,
                    locale,
                )
            }
        }),
        Some(crate::Commands::Boot {
            profile,
            from_default_profile,
            args,
        }) => profile_or_default(
            profile.or(cli.profile),
            &cfg.general.default_profile,
            locale,
        )
        .and_then(|p| {
            passthrough::exec_boot(
                &p,
                from_default_profile.as_deref(),
                &cli.patch,
                &args,
                dry,
                slim,
                locale,
            )
        }),
        None => {
            let explicit_profile = cli.profile.is_some();
            let parsed = dsh_args::split_launcher_args(cli.profile, cli.extra);
            match parsed {
                dsh_args::Launcher::Help => {
                    let _ = crate::cli_args::localized_command(locale).print_help();
                    Ok(())
                }
                dsh_args::Launcher::Plugin { profile, pnpm_args } => {
                    passthrough::exec_plugin(&profile, &pnpm_args, dry, slim, locale)
                }
                dsh_args::Launcher::Boot {
                    profile,
                    from_default,
                    patches,
                    app_args,
                } => {
                    // A bare `rdsh tui` is the documented terminal entry point, but
                    // DSH ships no tui profile. Rather than failing with a
                    // missing-profile error, fall back to the Rust TUI this binary
                    // carries, and say so. An installed tui profile still wins, and
                    // an explicit --profile never falls back.
                    if profile == "tui"
                        && from_default.is_none()
                        && !explicit_profile
                        && !local_tui_profile()
                    {
                        if dry {
                            // --dry-run reports what would happen instead of
                            // starting the terminal program, so it must not
                            // stop at the built-in TUI's tty guard.
                            println!(
                                "[rdsh dry-run] native-tui --backend dsh --dsh-profile web (no local 'tui' profile: the built-in Rust TUI would start)"
                            );
                            Ok(())
                        } else {
                            announce_builtin_tui(locale);
                            native_harness::cmd_native_tui(
                                "dsh".to_string(),
                                std::env::current_dir()
                                    .unwrap_or_else(|_| std::path::PathBuf::from(".")),
                                None,
                                Some("web".to_string()),
                                None,
                                None,
                                None,
                                None,
                                locale,
                            )
                        }
                    } else {
                        let mut all = cli.patch;
                        all.extend(patches);
                        if !dry {
                            // Decides from local files only; the check itself
                            // runs in a detached worker, so boot never waits.
                            plugins_release::auto_tick();
                        }
                        passthrough::exec_boot(
                            &profile,
                            from_default.as_deref(),
                            &all,
                            &app_args,
                            dry,
                            slim,
                            locale,
                        )
                    }
                }
                dsh_args::Launcher::Dump {
                    profile,
                    from_default,
                    kind,
                    patches,
                } => {
                    let mut all = cli.patch;
                    all.extend(patches);
                    passthrough::exec_dump_config(
                        &profile,
                        from_default.as_deref(),
                        kind,
                        &all,
                        dry,
                        slim,
                        locale,
                    )
                }
                dsh_args::Launcher::Error(msg) => {
                    eprintln!("{}", localized_launcher_error(locale, &msg));
                    std::process::exit(2);
                }
            }
        }
    };
    if let Err(e) = result {
        match e.downcast::<clap::Error>() {
            Ok(error) => crate::cli_args::exit_clap_error(locale, error),
            Err(error) => {
                let diagnostic = error
                    .chain()
                    .map(|cause| {
                        if let Some(error) = cause.downcast_ref::<subagent_plan::PlanError>() {
                            localized_format!(
                                locale,
                                "Subagent plan: {}",
                                "子代理计划：{}",
                                "サブエージェント計画: {}",
                                error.code
                            )
                        } else if let Some(error) =
                            cause.downcast_ref::<task_outcomes::OutcomeError>()
                        {
                            let translated = locale::diagnostic(locale, &error.message);
                            let message = if translated != error.message {
                                translated.to_string()
                            } else if let Some(key) = error.message.strip_prefix("Invalid outcome ")
                            {
                                localized_format!(
                                    locale,
                                    "Invalid outcome {key}",
                                    "结果 {key} 无效",
                                    "結果の {key} が無効です"
                                )
                            } else {
                                locale::diagnostic(locale, &error.message).to_string()
                            };
                            localized_format!(
                                locale,
                                "Task outcomes: {message}",
                                "任务结果：{message}",
                                "タスク結果: {message}"
                            )
                        } else {
                            locale::diagnostic(locale, &cause.to_string()).to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(": ");
                eprintln!(
                    "[rdsh] {}: {diagnostic}",
                    locale::message(locale, locale::Message::Error)
                );
                std::process::exit(1);
            }
        }
    }
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

fn localized_launcher_error(locale: locale::Locale, message: &str) -> String {
    if locale == locale::Locale::English {
        return message.to_string();
    }
    let translated = match message {
        "error: plugin needs pnpm arguments to forward (e.g. add <package>)" => crate::locale::pick(locale, message, "错误：plugin 需要转发 pnpm 参数（例如 add <package>）", "エラー: plugin には転送する pnpm 引数が必要です（例: add <package>）"),
        "error: --profile <name> is required" => crate::locale::pick(locale, message, "错误：需要 --profile <name>", "エラー: --profile <name> が必要です"),
        "error: select a profile only once" => crate::locale::pick(locale, message, "错误：只能选择一次配置文件", "エラー: プロファイルは一度だけ選択してください"),
        "error: --profile needs a name" => crate::locale::pick(locale, message, "错误：--profile 需要名称", "エラー: --profile には名前が必要です"),
        "error: --from-default-profile needs a name" => crate::locale::pick(locale, message, "错误：--from-default-profile 需要名称", "エラー: --from-default-profile には名前が必要です"),
        "error: --patch needs a path" => crate::locale::pick(locale, message, "错误：--patch 需要路径", "エラー: --patch にはパスが必要です"),
        "error: profile desktop is managed exclusively by the Electron application" => crate::locale::pick(locale, message, "错误：desktop 配置文件仅由 Electron 应用管理", "エラー: desktop プロファイルは Electron アプリケーションのみが管理します"),
        "error: --dump-config, --dump-default-config, and --dump-config-schema are mutually exclusive" => crate::locale::pick(locale, message, "错误：--dump-config、--dump-default-config 和 --dump-config-schema 不能同时使用", "エラー: --dump-config、--dump-default-config、--dump-config-schema は同時に使用できません"),
        "error: config dumps take no app arguments" => crate::locale::pick(locale, message, "错误：配置转储不接受应用参数", "エラー: 設定ダンプはアプリ引数を受け取りません"),
        "error: --dump-default-config prints the bundle layers and takes no --patch" => crate::locale::pick(locale, message, "错误：--dump-default-config 打印捆绑层且不接受 --patch", "エラー: --dump-default-config はバンドルレイヤーを出力し、--patch を受け取りません"),
        _ => message,
    };
    translated.to_string()
}

fn requested_locale() -> Result<locale::Locale, (locale::Locale, anyhow::Error)> {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let explicit = args.iter().enumerate().find_map(|(index, arg)| {
        let arg = arg.to_str()?;
        arg.strip_prefix("--language=").or_else(|| {
            (arg == "--language")
                .then(|| args.get(index + 1).and_then(|value| value.to_str()))
                .flatten()
        })
    });
    let early_locale = locale::current(explicit, "auto");
    if settings_independent_invocation() {
        return Ok(early_locale);
    }
    let settings = match rdsh_config::try_load_with_locale(early_locale) {
        Ok(settings) => settings,
        Err(error) => {
            // Pure worker-scope help has the same settings independence as its commands.
            if worker_scope_help_requested() {
                return Ok(early_locale);
            }
            return Err((early_locale, error));
        }
    };
    let setting = settings.general.language;
    Ok(locale::current(explicit, &setting))
}

/// Classify help with Clap's grammar, keeping option values and literal flags out.
fn worker_scope_help_requested() -> bool {
    if !matches!(Cli::try_parse_from(std::env::args_os()), Err(help) if help.kind() == clap::error::ErrorKind::DisplayHelp)
    {
        return false;
    }
    fn parse_help_as_flag(command: clap::Command) -> clap::Command {
        command
            .disable_help_flag(true)
            .disable_help_subcommand(true)
            .subcommand_required(false)
            .arg_required_else_help(false)
            .arg(
                clap::Arg::new("help")
                    .long("help")
                    .short('h')
                    .action(clap::ArgAction::SetTrue),
            )
            .mut_subcommands(parse_help_as_flag)
    }
    let command = parse_help_as_flag(Cli::command())
        .subcommand(clap::Command::new("help").arg(clap::Arg::new("command").num_args(0..)));
    let Ok(matches) = command.try_get_matches() else {
        return false;
    };
    if matches.get_flag("help") {
        return false;
    }
    match matches.subcommand() {
        Some(("worker-scope", worker)) => {
            let mut selected = worker;
            loop {
                if selected.get_flag("help") {
                    break true;
                }
                let Some((_, child)) = selected.subcommand() else {
                    break false;
                };
                selected = child;
            }
        }
        Some(("help", help)) => help
            .get_many::<String>("command")
            .and_then(|mut path| path.next())
            .is_some_and(|name| name == "worker-scope"),
        _ => false,
    }
}

/// Recovery, hook injection and pure JSON commands resolve language from flags
/// or the process environment without opening an unrelated settings file.
fn settings_independent_invocation() -> bool {
    matches!(
        Cli::try_parse_from(std::env::args_os()),
        Ok(Cli {
            command: Some(
                crate::Commands::Settings {
                    action: SettingsAction::Init { force: true }
                } | crate::Commands::Context {
                    // The hook path runs before any settings read and must stay
                    // fail-open, so the locale bootstrap skips the document too.
                    action: ContextAction::Inject { .. }
                } | crate::Commands::TaskOutcomes { .. }
                    | crate::Commands::Subagents { .. }
                    | crate::Commands::BudgetAdmission { .. }
                    | crate::Commands::Compaction { .. }
                    | crate::Commands::QuestionContracts { .. }
                    | crate::Commands::AnswerApplications { .. }
                    | crate::Commands::InstructionQueue { .. }
                    | crate::Commands::CostLedger { .. }
                    | crate::Commands::AdapterCatalog
                    | crate::Commands::Swarm { .. }
                    | crate::Commands::Cloud { .. }
                    | crate::Commands::WorkerScope { .. }
            ),
            ..
        })
    )
}

// Default profile order: RDSH_DEFAULT_PROFILE, then a local tui profile,
// else a guided error (dsh 0.2.0 ships acp, web, headless, sdk and
// sdk-minimal templates, but no tui template, so a bare default of tui
// would fail on fresh environments).
/// Whether this machine has an installed DSH tool profile named `tui`.
fn local_tui_profile() -> bool {
    std::path::Path::new(&format!("{}/profiles/tui", inspect::dsh_home())).is_dir()
}

/// Say once, in the caller's language, that a bare `rdsh tui` opened the Rust TUI.
fn announce_builtin_tui(locale: crate::locale::Locale) {
    eprintln!(
        "[rdsh] {}",
        crate::locale::pick(locale, "no local 'tui' profile; starting the built-in Rust TUI (install a tui profile with 'dsh plugin --profile tui add <package>' to delegate instead)", "本地没有 'tui' 配置文件；将启动内置的 Rust TUI（如需委托，请用 'dsh plugin --profile tui add <package>' 安装 tui 配置文件）", "ローカルに 'tui' プロファイルが無いため、組み込みの Rust TUI を起動します（委譲したい場合は 'dsh plugin --profile tui add <package>' で導入してください）")
    );
}

fn pick_default_profile(env: Option<&str>, local_tui: bool) -> Result<String, String> {
    if let Some(name) = env.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(name.to_string());
    }
    if local_tui {
        return Ok("tui".to_string());
    }
    Err("no profile specified and no local \u{2018}tui\u{2019} profile found (dsh 0.2.0 ships acp, web, headless, sdk and sdk-minimal templates, but no tui template). Boot with --profile <name> (e.g. --profile web) or set RDSH_DEFAULT_PROFILE=<name>".to_string())
}

pub(crate) fn profile_or_default(
    opt: Option<String>,
    configured_default: &str,
    locale: locale::Locale,
) -> anyhow::Result<String> {
    match opt {
        Some(p) => Ok(p),
        None => resolve_default_profile(configured_default, locale),
    }
}

fn resolve_default_profile(
    configured_default: &str,
    locale: locale::Locale,
) -> anyhow::Result<String> {
    let env = std::env::var("RDSH_DEFAULT_PROFILE").ok();
    if env.as_deref().is_none_or(|e| e.trim().is_empty()) && !configured_default.trim().is_empty() {
        return Ok(configured_default.trim().to_string());
    }
    let home = crate::inspect::dsh_home();
    let local_tui = std::path::Path::new(&format!("{home}/profiles/tui")).is_dir();
    pick_default_profile(env.as_deref(), local_tui).map_err(|m| {
        anyhow::anyhow!(crate::locale::pick(locale, m, "未指定配置文件且未找到本地 ‘tui’ 配置文件（dsh 0.2.0 提供 acp、web、headless、sdk 和 sdk-minimal 模板，但不提供 tui 模板）。请使用 --profile <name> 启动（例如 --profile web），或设置 RDSH_DEFAULT_PROFILE=<name>".to_string(), "プロファイルが指定されず、ローカルの ‘tui’ プロファイルも見つかりません（dsh 0.2.0 には acp、web、headless、sdk、sdk-minimal テンプレートがありますが tui テンプレートはありません）。--profile <name>（例: --profile web）で起動するか、RDSH_DEFAULT_PROFILE=<name> を設定してください".to_string()))
    })
}

/// True when `dotted` (e.g. `search.max`) is explicitly present (non-null)
/// in the raw rdsh.json text. Used by `settings show` to label each
/// effective value `config` vs `default`.
fn settings_key_in_file(raw: &serde_json::Value, dotted: &str) -> bool {
    let mut node = raw;
    for part in dotted.split('.') {
        match node.get(part) {
            Some(next) if !next.is_null() => node = next,
            _ => return false,
        }
    }
    true
}

fn dump_config_native(
    profile: &str,
    patches: &[String],
    locale: locale::Locale,
) -> anyhow::Result<()> {
    let home = crate::inspect::dsh_home();
    println!("{}", native_dump_config_json(profile, &home, patches));
    let root = format!("{home}/profiles/{profile}");
    match std::fs::read_dir(&root) {
        Ok(entries) => {
            println!(
                "# {} {root}:",
                crate::locale::pick(locale, "layers under", "以下层级", "次の配下のレイヤー")
            );
            let mut names: Vec<String> = entries
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            for n in names.iter().take(50) {
                println!("  - {n}");
            }
        }
        Err(_) => {
            println!(
                "# {} {root} ({})",
                crate::locale::pick(
                    locale,
                    "no local profile dir at",
                    "没有本地配置文件目录：",
                    "ローカルプロファイルディレクトリがありません:"
                ),
                crate::locale::pick(
                    locale,
                    "shipped template will be used by dsh",
                    "dsh 将使用随附模板",
                    "dsh は同梱テンプレートを使用します"
                )
            )
        }
    }
    Ok(())
}

fn native_dump_config_json(profile: &str, home: &str, patches: &[String]) -> String {
    serde_json::json!({
        "profile": profile,
        "dsh_home": home,
        "patches": patches,
    })
    .to_string()
}

/// Delegated agent tools: normal file access by default. The strict boundary
/// applies when the setting is explicit, when `--share-file` is used, or when
/// `RDSH_SECURITY=1` forces it.
fn agent_tool_sandbox(cfg: &rdsh_config::RdshSettings, share_files_requested: bool) -> bool {
    if rdsh_config::feature_is_explicit(cfg, "agent_tool_sandbox") {
        return rdsh_config::feature_enabled(cfg, "agent_tool_sandbox");
    }
    share_files_requested
}

/// `rdsh features`: every optional capability with its effective state.
fn features_list(
    cfg: &rdsh_config::RdshSettings,
    json: bool,
    locale: locale::Locale,
) -> anyhow::Result<()> {
    use std::io::Write;
    // `let _` on purpose: piping to `head` closes early (EPIPE) and must not
    // abort the listing with a panic.
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    if json {
        let payload = serde_json::json!({
            "config": rdsh_config::settings_path(),
            "features": rdsh_config::RdshSettings::feature_state(cfg),
        });
        let _ = writeln!(out, "{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }
    let _ = writeln!(
        out,
        "{}: {}",
        crate::locale::pick(locale, "config", "配置", "設定"),
        rdsh_config::settings_path()
    );
    let _ = writeln!(
        out,
        "{:<24} {:<5} {:<7} {}",
        crate::locale::pick(locale, "feature", "功能", "機能"),
        crate::locale::pick(locale, "state", "状态", "状態"),
        crate::locale::pick(locale, "default", "默认", "既定"),
        crate::locale::pick(locale, "what it does", "说明", "説明")
    );
    for def in rdsh_config::FEATURES {
        let _ = writeln!(
            out,
            "{:<24} {:<5} {:<7} {}",
            def.id,
            if rdsh_config::feature_enabled(cfg, def.id) {
                crate::locale::pick(locale, "on", "开启", "オン")
            } else {
                crate::locale::pick(locale, "off", "关闭", "オフ")
            },
            if def.default {
                crate::locale::pick(locale, "on", "开启", "オン")
            } else {
                crate::locale::pick(locale, "off", "关闭", "オフ")
            },
            feature_summary(locale, def)
        );
    }
    let _ = writeln!(
        out,
        "{}",
        crate::locale::pick(locale, "change one: rdsh features on <id> | rdsh features off <id> | rdsh settings set features.<id> true|false", "修改一项：rdsh features on <id> | rdsh features off <id> | rdsh settings set features.<id> true|false", "変更: rdsh features on <id> | rdsh features off <id> | rdsh settings set features.<id> true|false")
    );
    Ok(())
}

fn feature_summary(locale: locale::Locale, def: &rdsh_config::FeatureDef) -> &'static str {
    if locale == locale::Locale::English {
        return def.summary;
    }
    let (chinese, japanese) = match def.id {
        "discord" => ("Discord Rich Presence（默认关闭，需要运行 DSH Web 服务）", "Discord Rich Presence（既定OFF。DSH Web サービスの起動が必要）"),
        "telemetry" => ("允许委派的 DSH 发送会话遥测（OpenTelemetry）", "委譲先 DSH のセッション telemetry 送信を許可（OpenTelemetry）"),
        "update_check" => ("检查 rustdsh 更新并显示更新横幅", "rustdsh の更新を確認して更新バナーを表示"),
        "update_notifications" => ("发现更新时发送通知", "更新が見つかったときに通知する"),
        "sound" => ("允许安装 DSH 声音通知（installer SOUND=1）", "DSH サウンド通知の導入を許可（installer SOUND=1）"),
        "serve" => ("本地只读仪表板（rdsh serve）", "ローカル読み取り専用ダッシュボード（rdsh serve）"),
        "search-web" => ("SearXNG / Ollama Web 搜索（rdsh search-web）", "SearXNG / Ollama Web 検索（rdsh search-web）"),
        "context_engine" => ("实验性的每轮上下文引擎（rdsh context）", "実験的なターン単位コンテキストエンジン（rdsh context）"),
        "compute" => ("允许常驻计算桥（RDSH_COMPUTE=1）", "常駐コンピュートブリッジを許可（RDSH_COMPUTE=1）"),
        "budget_guard" => ("DSH 插件中的预算保护 hook", "DSH プラグイン内の予算ガードフック"),
        "feedback" => ("DSH 的 Like/Dislike 与 /feedback 反馈界面（默认 OFF；OFF 时安装 rdsh-no-feedback）", "DSH の Like/Dislike と /feedback のフィードバック画面（既定OFF。OFF で rdsh-no-feedback を導入）"),
        "agent_tool_sandbox" => ("将委派的代理工具限制为 --share-file 文件（无网络、无主机写入）", "委譲したエージェントツールを --share-file のファイルに制限（ネットワーク・ホスト書き込みなし）"),
        "release_probe" => ("在设置环境时运行发布资格检查", "環境設定時にリリース適格性プローブを実行"),
        "setup_web" => ("rdsh setup --web 本地设置页面", "rdsh setup --web ローカル設定ページ"),
        "sessions_token_cache" => ("缓存解压后会话的令牌数", "展開済みセッションのトークン数をキャッシュ"),
        "node_compile_cache" => ("委派运行的 Node 编译缓存（Node >= 22.1）", "委譲実行用の Node コンパイルキャッシュ（Node >= 22.1）"),
        _ => return def.summary,
    };
    crate::locale::pick(locale, def.summary, chinese, japanese)
}

/// `rdsh features on|off <id>`: writes features.<id> through the shared lock.
fn features_toggle(id: &str, on: bool, locale: locale::Locale) -> anyhow::Result<()> {
    let id = id.trim();
    let def = rdsh_config::feature_def(id).ok_or_else(|| {
        anyhow::anyhow!(
            "{}: {id} ({})",
            crate::locale::pick(locale, "unknown feature id", "未知功能 ID", "不明な機能 ID"),
            crate::locale::pick(
                locale,
                "try: rdsh features",
                "请尝试: rdsh features",
                "rdsh features を実行してください"
            )
        )
    })?;
    rdsh_config::update(locale, |cfg| {
        cfg.set_dotted_with_locale(
            &format!("features.{id}"),
            if on { "true" } else { "false" },
            locale,
        )
    })?;
    println!(
        "features.{id} = {} ({})",
        if on { "true" } else { "false" },
        def.summary
    );
    // Turning the switch back on must also bring the surface back: the patch is
    // a package, and the switch alone does not uninstall it.
    if id == "feedback" && on {
        let env = desktop::OsEnv::from_process();
        match plugins::detach_feedback_bundles(&env, locale) {
            Ok(done) => {
                for (profile, ok) in done {
                    println!(
                        "features.feedback: {} {profile}",
                        if ok {
                            crate::locale::pick(
                                locale,
                                "removed the feedback patch from",
                                "已从以下配置移除反馈补丁：",
                                "フィードバック無効化を外しました:",
                            )
                        } else {
                            match locale {
                                locale::Locale::English => {
                                    "could not remove the feedback patch from"
                                }
                                locale::Locale::Chinese => "无法从以下配置移除反馈补丁：",
                                locale::Locale::Japanese => {
                                    "フィードバック無効化を外せませんでした:"
                                }
                            }
                        }
                    );
                }
            }
            Err(error) => eprintln!("features.feedback: {error}"),
        }
    }
    Ok(())
}

/// Server-type extras are off by default: refuse with enable guidance.
/// Setup is not an extra: `features.setup_web` (default on) gates it instead.
fn extra_disabled(id: &str, locale: locale::Locale) -> anyhow::Result<()> {
    let text = crate::locale::pick(locale, format!("extra '{id}' is disabled by default; enable with: rdsh features on {id} (or rdsh settings set extras.enable {id})"), format!("附加功能 '{id}' 默认关闭；请使用以下命令启用：rdsh features on {id}（或 rdsh settings set extras.enable {id}）"), format!("追加機能 '{id}' は既定で無効です。有効化: rdsh features on {id}（または rdsh settings set extras.enable {id}）"));
    Err(anyhow::Error::msg(text))
}

fn bench(n: u32, locale: locale::Locale) -> anyhow::Result<()> {
    use std::time::Instant;
    if n == 0 {
        anyhow::bail!(crate::locale::pick(
            locale,
            "--n must be >= 1",
            "--n 必须 >= 1",
            "--n は 1 以上である必要があります"
        ));
    }
    let me = std::env::current_exe()?;
    let mut mine = vec![];
    for _ in 0..n {
        let t = Instant::now();
        let st = std::process::Command::new(&me).arg("--version").status()?;
        if !st.success() {
            anyhow::bail!(crate::locale::pick(
                locale,
                "self --version failed",
                "自身的 --version 失败",
                "自身の --version が失敗しました"
            ));
        }
        mine.push(t.elapsed());
    }
    println!("[rdsh] rdsh --version x{n}: {}", summarize(&mine, locale));
    if let Some(orig) = passthrough::find_original_dsh() {
        let mut theirs = vec![];
        for _ in 0..n {
            let t = Instant::now();
            let _ = std::process::Command::new(&orig)
                .arg("--version")
                .status()?;
            theirs.push(t.elapsed());
        }
        println!("[dsh ] dsh --version x{n}: {}", summarize(&theirs, locale));
    } else {
        println!(
            "[dsh ] {}",
            crate::locale::pick(
                locale,
                "skipped (original not found)",
                "已跳过（未找到原始版本）",
                "スキップ（元のバージョンが見つかりません）"
            )
        );
    }
    Ok(())
}

fn summarize(v: &[std::time::Duration], locale: locale::Locale) -> String {
    let mut s = v.to_vec();
    s.sort();
    let mid = s[s.len() / 2];
    match locale {
        locale::Locale::English => {
            format!("median={mid:?} min={:?} max={:?}", s[0], s[s.len() - 1])
        }
        locale::Locale::Chinese => format!(
            "中位数={mid:?} 最小值={:?} 最大值={:?}",
            s[0],
            s[s.len() - 1]
        ),
        locale::Locale::Japanese => {
            format!("中央値={mid:?} 最小={:?} 最大={:?}", s[0], s[s.len() - 1])
        }
    }
}

#[cfg(test)]
mod default_profile_tests {
    use super::pick_default_profile;

    #[test]
    fn env_wins() {
        assert_eq!(pick_default_profile(Some("web"), false).unwrap(), "web");
        assert_eq!(pick_default_profile(Some(" web "), true).unwrap(), "web");
    }

    #[test]
    fn local_tui_fallback() {
        assert_eq!(pick_default_profile(None, true).unwrap(), "tui");
        assert_eq!(pick_default_profile(Some(""), true).unwrap(), "tui");
    }

    #[test]
    fn guided_error_without_either() {
        let err = pick_default_profile(None, false).unwrap_err();
        assert!(err.contains("RDSH_DEFAULT_PROFILE"), "{err}");
        assert!(err.contains("--profile"), "{err}");
    }
}

#[cfg(test)]
mod native_dump_tests {
    use super::native_dump_config_json;

    #[test]
    fn native_dump_escapes_untrusted_profile_and_home_strings() {
        let profile = "profile \"quoted\"\\name\nnext";
        let home = "C:\\Users\\a \"quoted\"\\folder";
        let patches = vec!["patch \"one\"\\overlay.yml".to_string()];

        let encoded = native_dump_config_json(profile, home, &patches);
        let decoded: serde_json::Value = serde_json::from_str(&encoded).unwrap();

        assert_eq!(decoded["profile"], profile);
        assert_eq!(decoded["dsh_home"], home);
        assert_eq!(decoded["patches"], serde_json::json!(patches));
    }
}
