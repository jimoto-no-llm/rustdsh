//! Linux distribution hints: what an rpm-based host still needs to install.
//!
//! rdsh itself is a single Rust binary; the optional tools below only unlock
//! extra features (session token unpacking, the agent-tool sandbox). Detection
//! is read-only, never writes, and never fails a command. Everything here is
//! silent on hosts that are not rpm-based.

use std::ffi::OsStr;

/// One optional tool, the package that ships it on rpm-based hosts, and the
/// feature that stays unavailable without it.
struct Optional {
    /// Names looked up on PATH (first match wins).
    names: &'static [&'static str],
    /// Package name for `dnf install`.
    package: &'static str,
    /// What the user loses while the tool is missing.
    feature: &'static str,
}

const OPTIONAL: &[Optional] = &[
    Optional {
        names: &["zstd"],
        package: "zstd",
        feature: "rdsh sessions --tokens",
    },
    Optional {
        names: &["bwrap", "bubblewrap"],
        package: "bubblewrap",
        feature: "--share-file sandbox",
    },
];

/// `ID=` from `/etc/os-release`, lowercased. Pure so tests can feed a fixture.
pub fn distro_id_from(os_release: &str) -> Option<String> {
    os_release.lines().find_map(|line| {
        line.strip_prefix("ID=")
            .map(|value| value.trim().trim_matches('"').to_ascii_lowercase())
            .filter(|value| !value.is_empty())
    })
}

/// Read the host distribution id, if the file exists and names one.
pub fn distro_id() -> Option<String> {
    let text = std::fs::read_to_string("/etc/os-release").ok()?;
    distro_id_from(&text)
}

/// rpm-based families that use dnf for the packages above.
pub fn is_rpm_family(id: &str) -> bool {
    matches!(
        id,
        "fedora" | "rhel" | "centos" | "rocky" | "almalinux" | "oracle"
    )
}

fn executable_on_path(name: &str, path: Option<&OsStr>) -> bool {
    let Some(path) = path else {
        return false;
    };
    std::env::split_paths(path).any(|dir| crate::executable::is_executable(&dir.join(name)))
}

/// Optional tools this host is missing, as (package, feature) pairs.
pub fn missing_optional(path: Option<&OsStr>) -> Vec<(&'static str, &'static str)> {
    OPTIONAL
        .iter()
        .filter(|tool| !tool.names.iter().any(|name| executable_on_path(name, path)))
        .map(|tool| (tool.package, tool.feature))
        .collect()
}

/// Doctor lines for an rpm-based host. Empty everywhere else, so the output of
/// `rdsh doctor` is unchanged on Debian, macOS and Windows.
pub fn doctor_notes() -> Vec<String> {
    let Some(id) = distro_id() else {
        return Vec::new();
    };
    if !is_rpm_family(&id) {
        return Vec::new();
    }
    let path = std::env::var_os("PATH");
    let missing = missing_optional(path.as_deref());
    if missing.is_empty() {
        let present: Vec<&str> = OPTIONAL.iter().map(|tool| tool.package).collect();
        return vec![format!(
            "[rdsh] {id}: optional tools present ({})",
            present.join(", ")
        )];
    }
    let listed: Vec<String> = missing
        .iter()
        .map(|(package, feature)| format!("{package} ({feature})"))
        .collect();
    let packages: Vec<&str> = missing.iter().map(|(package, _)| *package).collect();
    vec![
        format!("[rdsh] {id}: missing {}", listed.join(", ")),
        format!("[rdsh] {id}: sudo dnf install -y {}", packages.join(" ")),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("rdsh-distro-{tag}-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn os_release_id_is_parsed_and_quoted_values_are_accepted() {
        assert_eq!(
            distro_id_from("NAME=Fedora\nID=fedora\n").as_deref(),
            Some("fedora")
        );
        assert_eq!(distro_id_from("ID=\"Fedora\"\n").as_deref(), Some("fedora"));
        assert_eq!(distro_id_from("NAME=Ubuntu\nVERSION_ID=24.04\n"), None);
    }

    #[test]
    fn rpm_families_are_recognized() {
        for id in ["fedora", "rhel", "centos", "rocky", "almalinux", "oracle"] {
            assert!(is_rpm_family(id), "{id}");
        }
        for id in ["ubuntu", "debian", "arch", "opensuse-leap", ""] {
            assert!(!is_rpm_family(id), "{id}");
        }
    }

    #[test]
    fn missing_tools_follow_the_injected_path() {
        let root = temp_root("path");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let zstd = bin.join("zstd");
        std::fs::write(&zstd, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&zstd, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = std::env::join_paths([bin.as_os_str()]).unwrap();
        assert_eq!(
            missing_optional(Some(&path)),
            vec![("bubblewrap", "--share-file sandbox")]
        );
        assert_eq!(missing_optional(None).len(), 2);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn another_permission_class_cannot_hide_a_missing_tool() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let root = temp_root("effective-access");
        let zstd = root.join("zstd");
        std::fs::write(&zstd, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&zstd, std::fs::Permissions::from_mode(0o601)).unwrap();
        let path = std::env::join_paths([root.as_os_str()]).unwrap();
        assert_eq!(
            missing_optional(Some(&path)),
            vec![
                ("zstd", "rdsh sessions --tokens"),
                ("bubblewrap", "--share-file sandbox"),
            ]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
