//! The harness adapter seam: the layer between rdsh's micro-orchestrator and
//! whatever carries the actual agent conversation.
//!
//! The bundled adapter (DshAdapter) delegates to the real DeepSeek Harness
//! CLI with today's full behavior (slim env, web shell assets, the gzip
//! overlay and the web_search bridge). Any other harness - for example an
//! OpenAI-compatible CLI - can join by implementing HarnessAdapter
//! (docs/HARNESS-ADAPTER.md); the orchestrator only ever talks to this seam,
//! never to a concrete harness.

/// One delegated launch, fully described: the adapter owns everything between
/// here and the child process. \`passthrough\` owns the struct.
#[derive(Debug, Clone)]
pub struct LaunchOptions {
    pub profile: String,
    pub from_default: Option<String>,
    pub patches: Vec<String>,
    pub app_args: Vec<String>,
    pub dry: bool,
    pub slim: bool,
    pub locale: crate::locale::Locale,
}

/// Everything an assembled launch produces, just before execution.
pub struct BootedCommand {
    pub command: std::process::Command,
    /// One-line notices that used to go straight to stderr, in order.
    pub notices: Vec<String>,
}

/// The seam every delegating harness joins through. A joining adapter keeps
/// arguments, output echo and session state verbatim by contract (the launch
/// shape this orchestrator assumes); the seam itself has no runtime toggle.
pub trait HarnessAdapter {
    fn resolve_binary(&self) -> Option<String>;

    fn build_command(&self, options: &LaunchOptions) -> anyhow::Result<BootedCommand>;

    /// Authenticate, assemble, and execute (or dry-print) one launch.
    fn launch(&self, options: &LaunchOptions, locale: crate::locale::Locale) -> anyhow::Result<()> {
        let booted = self.build_command(options)?;
        crate::passthrough::finish_launch(booted, options.dry, locale)
    }
}

/// The bundled adapter for the DeepSeek Harness CLI.
pub struct DshAdapter;

impl HarnessAdapter for DshAdapter {
    fn resolve_binary(&self) -> Option<String> {
        crate::passthrough::find_original_dsh()
    }

    fn build_command(&self, options: &LaunchOptions) -> anyhow::Result<BootedCommand> {
        let origin = self.resolve_binary().ok_or_else(|| {
            anyhow::anyhow!(crate::passthrough::original_dsh_not_found_message(
                options.locale
            ))
        })?;
        crate::passthrough::assemble_boot(&origin, options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsh_adapter_resolves_a_declared_binary() {
        let _lock = crate::test_support::env_lock();
        let dir = std::env::temp_dir().join(format!("rdsh-harness-adapter-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("rdsh-adapter-original-dsh");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let previous = std::env::var("DSH_ORIG_BIN").ok();
        std::env::set_var("DSH_ORIG_BIN", bin.display().to_string());
        let adapter: &dyn HarnessAdapter = &DshAdapter;
        let resolved = adapter.resolve_binary();
        match previous {
            Some(value) => std::env::set_var("DSH_ORIG_BIN", value),
            None => std::env::remove_var("DSH_ORIG_BIN"),
        }
        assert!(resolved.is_some(), "declared binary resolves");
        std::fs::remove_dir_all(&dir).ok();
    }
}
