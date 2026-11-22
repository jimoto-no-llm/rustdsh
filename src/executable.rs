//! Read-only executable checks and PATH walking shared by discovery, Desktop,
//! passthrough and host diagnostics.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Directory scans are bounded so a diagnostic never stalls on a huge PATH.
pub(crate) const PATH_SCAN_MAX_DIRS: usize = 64;

/// Require a regular file that the effective user can execute. On Unix, a mode
/// bit belonging to another permission class does not make the file runnable.
pub(crate) fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: c_path is NUL-terminated; AT_FDCWD makes this a read-only query.
        unsafe {
            libc::faccessat(
                libc::AT_FDCWD,
                c_path.as_ptr(),
                libc::X_OK,
                libc::AT_EACCESS,
            ) == 0
        }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// A delegated entrypoint is either a Node script (only has to exist, Node
/// reads it) or a file the effective user can execute.
pub(crate) fn is_runnable_entry(path: &Path) -> bool {
    if path.extension().is_some_and(|extension| extension == "js") {
        return path.is_file();
    }
    is_executable(path)
}

/// The Windows `.exe` convention followed by the bare name.
#[cfg(windows)]
pub(crate) const EXE_THEN_BARE: &[&str] = &[".exe", ""];
#[cfg(not(windows))]
pub(crate) const EXE_THEN_BARE: &[&str] = &[""];

/// Only the platform's native executable suffix: a binary is `name.exe` on
/// Windows and has no suffix anywhere else. Script shims are not considered.
#[cfg(windows)]
pub(crate) const NATIVE_ONLY: &[&str] = &[".exe"];
#[cfg(not(windows))]
pub(crate) const NATIVE_ONLY: &[&str] = &[""];

/// PATH components in resolution order. `limit` caps the walk (diagnostics
/// pass `PATH_SCAN_MAX_DIRS`); `skip_empty` drops empty components, which Unix
/// reads as the working directory and a probe should not adopt by accident.
pub(crate) fn path_directories(
    path_var: &OsStr,
    limit: Option<usize>,
    skip_empty: bool,
) -> impl Iterator<Item = PathBuf> + '_ {
    std::env::split_paths(path_var)
        .take(limit.unwrap_or(usize::MAX))
        .filter(move |directory| !skip_empty || !directory.as_os_str().is_empty())
}

/// File names probed for `name`, in order: one per extension, where the empty
/// extension is the bare name. Duplicates collapse so a caller can list the
/// platform default without thinking about overlaps.
pub(crate) fn candidate_names(name: &str, extensions: &[&str]) -> Vec<String> {
    let mut names: Vec<String> = Vec::with_capacity(extensions.len());
    for extension in extensions {
        let candidate = format!("{name}{extension}");
        if !names.contains(&candidate) {
            names.push(candidate);
        }
    }
    names
}

/// First candidate name a directory list hosts, ordered by directory and then
/// by the caller's name list. `accept` owns the per-site policy (effective
/// access, trust rules, extension restrictions) so only the walk is shared.
pub(crate) fn find_in_dirs(
    dirs: impl IntoIterator<Item = PathBuf>,
    names: &[String],
    accept: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    for directory in dirs {
        for name in names {
            let candidate = directory.join(name);
            if accept(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// `find_in_dirs` over a bounded PATH with empty components skipped: the shape
/// a lookup that takes a name plus a suffix list wants.
pub(crate) fn find_on_path(
    path_var: &OsStr,
    name: &str,
    extensions: &[&str],
    accept: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    find_in_dirs(
        path_directories(path_var, Some(PATH_SCAN_MAX_DIRS), true),
        &candidate_names(name, extensions),
        accept,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "rdsh-executable-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[cfg(unix)]
    fn write_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn candidate_names_follow_extension_order_and_collapse_duplicates() {
        assert_eq!(candidate_names("dsh", &[".exe", ""]), ["dsh.exe", "dsh"]);
        assert_eq!(candidate_names("dsh", &[""]), ["dsh"]);
        assert_eq!(
            candidate_names("dsh", &[".exe", ".exe", ""]),
            ["dsh.exe", "dsh"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn empty_path_components_are_kept_or_skipped_on_request() {
        let path = std::env::join_paths(["", "/usr/bin", "", "/bin"]).unwrap();
        let kept: Vec<PathBuf> = path_directories(&path, None, false).collect();
        assert_eq!(
            kept,
            vec![
                PathBuf::new(),
                PathBuf::from("/usr/bin"),
                PathBuf::new(),
                PathBuf::from("/bin"),
            ]
        );
        // The bound applies to PATH entries as listed, empty ones included,
        // and only then are the empties dropped.
        let skipped: Vec<PathBuf> = path_directories(&path, None, true).collect();
        assert_eq!(
            vec![PathBuf::from("/usr/bin"), PathBuf::from("/bin")],
            skipped
        );
        // An empty component must not swallow the whole budget for a checker.
        let bounded: Vec<PathBuf> = path_directories(&path, Some(2), true).collect();
        assert_eq!(bounded, vec![PathBuf::from("/usr/bin")]);
    }

    #[cfg(unix)]
    #[test]
    fn find_in_dirs_prefers_directory_order_over_extension_order() {
        let root = scratch("order");
        let first = root.join("first");
        let second = root.join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        write_executable(&first.join("tool.exe"));
        write_executable(&second.join("tool"));
        let names = candidate_names("tool", &[".exe", ""]);
        assert_eq!(
            find_in_dirs([first.clone(), second], &names, is_executable),
            Some(first.join("tool.exe"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn is_runnable_entry_accepts_a_plain_javascript_file() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("entry");
        let script = root.join("bin.js");
        fs::write(&script, b"console.log(1)\n").unwrap();
        assert!(is_runnable_entry(&script));
        let other = root.join("dsh-orig");
        fs::write(&other, b"#!/bin/sh\n").unwrap();
        assert!(!is_runnable_entry(&other));
        fs::set_permissions(&other, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_runnable_entry(&other));
        fs::remove_dir_all(root).unwrap();
    }
}
