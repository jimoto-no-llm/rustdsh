//! Read repository files through no-follow, directory-relative handles.
//! Callers pass an absolute, canonical root and target; unavailable hosts fail closed.
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

/// A command-scoped capability for the directory selected by the caller.
/// Keep its identity stable instead of reopening every ancestor for every file.
pub(crate) struct Root {
    #[cfg(unix)]
    path: PathBuf,
    #[cfg(unix)]
    directory: std::fs::File,
}

impl Root {
    #[cfg(unix)]
    pub(crate) fn new(root: &Path) -> Option<Self> {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;

        if !root.is_absolute() {
            return None;
        }
        let name = CString::new(b"/".as_slice()).ok()?;
        let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW;
        let fd = unsafe { libc::open(name.as_ptr(), flags) };
        if fd < 0 {
            return None;
        }
        let mut directory = unsafe { std::fs::File::from_raw_fd(fd) };
        for component in root.components() {
            let name = match component {
                std::path::Component::RootDir | std::path::Component::CurDir => continue,
                std::path::Component::Normal(name) => CString::new(name.as_bytes()).ok()?,
                _ => return None,
            };
            let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                return None;
            }
            directory = unsafe { std::fs::File::from_raw_fd(fd) };
        }
        Some(Self {
            path: root.to_path_buf(),
            directory,
        })
    }

    #[cfg(not(unix))]
    pub(crate) fn new(_root: &Path) -> Option<Self> {
        None
    }

    #[cfg(unix)]
    pub(crate) fn open(&self, target: &Path) -> Option<std::fs::File> {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::MetadataExt;

        let relative = target.strip_prefix(&self.path).ok()?;
        if relative.as_os_str().is_empty() {
            return None;
        }
        let components: Vec<_> = relative.components().collect();
        let mut current: Option<std::fs::File> = None;
        for (index, component) in components.iter().copied().enumerate() {
            let name = match component {
                std::path::Component::Normal(name) => CString::new(name.as_bytes()).ok()?,
                _ => return None,
            };
            let flags = libc::O_RDONLY
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | if index + 1 == components.len() {
                    libc::O_NONBLOCK
                } else {
                    libc::O_DIRECTORY
                };
            let parent = current.as_ref().unwrap_or(&self.directory);
            let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                return None;
            }
            current = Some(unsafe { std::fs::File::from_raw_fd(fd) });
        }
        let file = current?;
        let metadata = file.metadata().ok()?;
        (metadata.is_file() && metadata.nlink() == 1).then_some(file)
    }

    #[cfg(not(unix))]
    pub(crate) fn open(&self, _target: &Path) -> Option<std::fs::File> {
        None
    }
}

pub(crate) fn open_beneath(root: &Path, target: &Path) -> Option<std::fs::File> {
    Root::new(root)?.open(target)
}

#[cfg(all(test, unix))]
mod secure_open_tests {
    use super::{open_beneath, Root};
    use std::path::Path;

    #[test]
    fn cached_root_keeps_approved_identity_when_path_is_replaced() {
        use std::io::Read;
        let temporary = std::env::temp_dir().join(format!(
            "rdsh-root-open-{}",
            crate::local_http::random_token().unwrap()
        ));
        let project = temporary.join("project");
        let outside = temporary.join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(project.join("file.txt"), "approved").unwrap();
        std::fs::write(outside.join("file.txt"), "DUMMY_OUTSIDE_FILE").unwrap();
        let path = std::fs::canonicalize(&project).unwrap();
        let root = Root::new(&path).unwrap();
        std::fs::rename(&project, temporary.join("approved-root")).unwrap();
        std::os::unix::fs::symlink(&outside, &project).unwrap();
        let mut text = String::new();
        root.open(&path.join("file.txt"))
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "approved");
        assert!(Root::new(&path).is_none());
        assert!(root.open(&outside.join("file.txt")).is_none());
        assert!(root.open(&path.join("../outside/file.txt")).is_none());
        std::fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn rejects_parent_symlink_swaps_and_fifo_without_waiting() {
        use std::os::unix::ffi::OsStrExt;
        let temporary = std::env::temp_dir().join(format!(
            "rdsh-parent-open-{}",
            crate::local_http::random_token().unwrap()
        ));
        let project = temporary.join("project");
        let parent = project.join("parent");
        let outside = temporary.join("outside");
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(parent.join("file.txt"), "safe").unwrap();
        std::fs::write(outside.join("file.txt"), "DUMMY_OUTSIDE_FILE").unwrap();
        let root = std::fs::canonicalize(&project).unwrap();
        let reader = Root::new(&root).unwrap();
        let validated = std::fs::canonicalize(parent.join("file.txt")).unwrap();
        std::fs::rename(&parent, project.join("original-parent")).unwrap();
        std::os::unix::fs::symlink(&outside, &parent).unwrap();
        assert!(open_beneath(&root, &validated).is_none());
        assert!(reader.open(&validated).is_none());

        let fifo = root.join("pipe");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(open_beneath(&root, &fifo).is_none());
        assert!(reader.open(&fifo).is_none());
        assert!(open_beneath(&root, &root).is_none());
        std::fs::remove_dir_all(temporary).unwrap();
    }

    #[test]
    fn rejects_symlink_swap_after_validation_and_hardlinked_outside_file() {
        let root = std::env::temp_dir().join(format!(
            "rdsh-file-open-{}",
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let outside = root.join("outside-secret");
        std::fs::write(&outside, "DUMMY_CONTEXT_SECRET").unwrap();

        let slot = project.join("working.txt");
        std::fs::write(&slot, "safe initial file").unwrap();
        let root = std::fs::canonicalize(&project).unwrap();
        let reader = Root::new(&root).unwrap();
        let validated = std::fs::canonicalize(&slot).unwrap();
        std::fs::remove_file(&slot).unwrap();
        std::os::unix::fs::symlink(&outside, &slot).unwrap();
        assert!(open_beneath(&root, &validated).is_none());
        assert!(reader.open(&validated).is_none());

        std::fs::remove_file(&slot).unwrap();
        std::fs::hard_link(&outside, &slot).unwrap();
        let linked = std::fs::canonicalize(&slot).unwrap();
        assert!(open_beneath(Path::new(&root), &linked).is_none());
        assert!(reader.open(&linked).is_none());
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }
}

/// Lenient pre-check for `--share-file` entries before they reach the tool
/// boundary: the JS snapshot remains the enforcer (dotfiles, key names,
/// sizes), so Rust only rejects what is definitely unusable — empty,
/// absolute, parent-escaping, or over-count selections — with a clear error
/// instead of a late sandbox failure.
pub(crate) fn validate_share_files(files: &[String]) -> Result<(), String> {
    if files.len() > 256 {
        return Err(format!("too many --share-file entries ({})", files.len()));
    }
    for f in files {
        if f.is_empty() || f.len() > 1024 {
            return Err(format!("invalid --share-file entry {f:?}"));
        }
        if f.starts_with('/') || f.starts_with('\\') {
            return Err(format!("--share-file must be workspace-relative: {f:?}"));
        }
        if f.split(['/', '\\']).any(|part| part == "..") {
            return Err(format!("--share-file must not escape: {f:?}"));
        }
        if f.bytes().any(|b| b == 0) {
            return Err(format!("invalid --share-file entry {f:?}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod share_validation_tests {
    use super::validate_share_files;

    #[test]
    fn accepts_plain_relative_paths() {
        assert!(validate_share_files(&["AGENTS.md".into(), "docs/a b.txt".into()]).is_ok());
        assert!(validate_share_files(&[]).is_ok());
    }

    #[test]
    fn rejects_absolute_parent_and_overflow() {
        for bad in ["", "/etc/passwd", "a/../../b", "..\\x", "a\0b"] {
            assert!(validate_share_files(&[bad.into()]).is_err(), "{bad:?}");
        }
        let many = vec!["a".to_string(); 257];
        assert!(validate_share_files(&many).is_err());
    }
}
