//! Shared trust checks for executables resolved from the environment.
//!
//! PATH-derived binaries must survive the same policy everywhere: a regular
//! executable file whose own mode and whose parent directory are not
//! group/world writable. Owner equality is additionally required for files
//! under the user home tree because those locations are attacker-shapeable.
use std::path::{Path, PathBuf};

/// Reason the executable fails the trust policy, or `None` when trusted.
#[cfg(unix)]
pub(crate) fn untrusted_reason(path: &Path) -> Option<&'static str> {
    use std::os::unix::fs::MetadataExt;
    let Ok(metadata) = std::fs::metadata(path) else {
        return Some("missing");
    };
    if !metadata.is_file() {
        return Some("not a regular file");
    }
    if metadata.mode() & 0o022 != 0 {
        return Some("group/world-writable");
    }
    if let Some(parent) = path.parent() {
        if let Ok(parent_metadata) = std::fs::metadata(parent) {
            if parent_metadata.mode() & 0o022 != 0 {
                return Some("directory is group/world-writable");
            }
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if let Some(home) = home {
        let in_home = path.canonicalize().ok().is_some_and(|resolved| {
            resolved.starts_with(&home.canonicalize().unwrap_or(home.clone()))
        });
        if in_home && metadata.uid() != unsafe { libc::geteuid() } {
            return Some("home file owned by another user");
        }
    }
    None
}

#[cfg(not(unix))]
pub(crate) fn untrusted_reason(_path: &Path) -> Option<&'static str> {
    None
}

/// `find_trusted_on_path` with well-known absolute fallbacks. Distributions
/// keep these programs in fixed system directories, and minimal environments
/// (systemd timers, hardened shells) may carry a truncated `PATH`.
pub(crate) fn find_trusted_or_well_known(name: &str, fallbacks: &[&str]) -> Option<PathBuf> {
    find_trusted_on_path(name).or_else(|| {
        fallbacks
            .iter()
            .map(Path::new)
            .find(|candidate| {
                crate::executable::is_executable(candidate) && untrusted_reason(candidate).is_none()
            })
            .map(Path::to_path_buf)
    })
}
/// First PATH entry hosting a trusted, executable `name`.
pub(crate) fn find_trusted_on_path(name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    let extension = if cfg!(windows) { ".exe" } else { "" };
    for directory in std::env::split_paths(&path_env) {
        if directory.as_os_str().is_empty() {
            continue;
        }
        let candidate = directory.join(format!("{name}{extension}"));
        if crate::executable::is_executable(&candidate) && untrusted_reason(&candidate).is_none() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn scratch(label: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "rdsh-exec-trust-{label}-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        root
    }

    #[cfg(unix)]
    #[test]
    fn trust_policy_rejects_group_writable_files_and_directories() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("modes");
        let clean = root.join("clean.sh");
        std::fs::write(&clean, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&clean, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(untrusted_reason(&clean), None);
        let loose_file = root.join("loose.sh");
        std::fs::write(&loose_file, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&loose_file, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(untrusted_reason(&loose_file), Some("group/world-writable"));
        let loose_dir = root.join("loose-dir");
        std::fs::create_dir_all(&loose_dir).unwrap();
        std::fs::set_permissions(&loose_dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        let inside = loose_dir.join("tool.sh");
        std::fs::write(&inside, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&inside, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            untrusted_reason(&inside),
            Some("directory is group/world-writable")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn trust_policy_requires_an_existing_regular_file() {
        let root = scratch("regular");
        let directory = root.join("dir.sh");
        std::fs::create_dir_all(&directory).unwrap();
        assert_eq!(untrusted_reason(&directory), Some("not a regular file"));
        assert_eq!(untrusted_reason(&root.join("absent.sh")), Some("missing"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
