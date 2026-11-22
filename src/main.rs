//! rustdsh launcher entry point: crate wiring only.
//!
//! The CLI surface lives in [`cli_args`], dispatch in [`cli_dispatch`], host
//! diagnostics in [`doctor`], and wrapper/shadowing checks in [`wrapper_diag`].

// Textual macro scoping: `localized_format!` must be introduced before every
// module that expands it, so this deliberately breaks the alphabetical order
// below (the macro is crate-internal, not #[macro_export]ed).
#[macro_use]
mod localized_format;

mod adapter_catalog;
mod answer_applications;
mod auth;
mod auth_sharing;
mod budget_admission;
mod cli_args;
mod cli_dispatch;
mod cloud;
mod compact;
mod compaction_cli;
mod compaction_config;
mod compaction_native;
mod compaction_overlay;
mod compaction_policy;
mod compute;
mod context;
mod context_hook;
mod cost_ledger;
mod deps;
mod desktop;
mod desktop_webui;
mod distro;
mod doctor;
mod dsh_args;
mod dsh_env;
mod exec_trust;
mod executable;
mod file_lock;
mod file_security;
mod files;
mod guard;
mod harness_adapter;
mod inspect;
mod instruction_queue;
mod js_json;
mod local_http;
mod locale;
#[cfg(test)]
mod locale_test;
mod models;
mod native_harness;
mod opencode_header;
mod passthrough;
mod plugins;
mod plugins_release;
mod plugins_tar;
mod provider_detect;
mod providers;
mod question_contracts;
mod rdsh_config;
mod rustxng;
mod search;
mod searxng;
mod serial_proxy;
mod serve;
mod setup_models;
mod setup_web;
mod setup_wizard;
mod shutdown;
mod slim;
mod subagent_plan;
mod swarm;
mod task_outcomes;
mod terminal_safe;
#[cfg(test)]
mod test_support;
mod tmp_guard;
mod token_handoff;
mod tokens;
mod tool_security;
mod update_auto;
mod websearch;
mod webui_assets;
mod webui_gzip;
mod worker_git;
mod worker_scopes;
mod wrapper_diag;
mod zdr;

pub(crate) use cli_args::{Cli, Commands, ContextAction};

fn main() {
    cli_dispatch::run();
}
