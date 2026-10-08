//! Read repository files through no-follow, directory-relative handles.
//! Callers pass an absolute, canonical root and target; unavailable hosts fail closed.
use std::path::Path;

#[cfg(unix)]
pub(crate) fn open_beneath(root: &Path, target: &Path) -> Option<std::fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    if !root.is_absolute() {
        return None;
    }
    let relative = target.strip_prefix(root).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    let root_name = CString::new(b"/".as_slice()).ok()?;
    let root_fd = unsafe {
        libc::open(
            root_name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY,
        )
    };
    if root_fd < 0 {
        return None;
    }
    let mut current = unsafe { std::fs::File::from_raw_fd(root_fd) };
    let components: Vec<_> = root.components().chain(relative.components()).collect();
    for (index, component) in components.iter().copied().enumerate() {
        let name = match component {
            std::path::Component::RootDir | std::path::Component::CurDir => continue,
            std::path::Component::Normal(name) => CString::new(name.as_bytes()).ok()?,
            std::path::Component::ParentDir | std::path::Component::Prefix(_) => return None,
        };
        let last = index + 1 == components.len();
        let flags = if last {
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK
        } else {
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW
        };
        let fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return None;
        }
        current = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    let metadata = current.metadata().ok()?;
    (metadata.is_file() && metadata.nlink() == 1).then_some(current)
}

#[cfg(not(unix))]
pub(crate) fn open_beneath(_root: &Path, _target: &Path) -> Option<std::fs::File> {
    // This path is not yet implemented with handle-relative no-follow opens.
    None
}

#[cfg(all(test, unix))]
mod secure_open_tests {
    use super::open_beneath;
    use std::path::Path;

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
        let validated = std::fs::canonicalize(parent.join("file.txt")).unwrap();
        std::fs::rename(&parent, project.join("original-parent")).unwrap();
        std::os::unix::fs::symlink(&outside, &parent).unwrap();
        assert!(open_beneath(&root, &validated).is_none());

        let fifo = root.join("pipe");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(open_beneath(&root, &fifo).is_none());
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
        let validated = std::fs::canonicalize(&slot).unwrap();
        std::fs::remove_file(&slot).unwrap();
        std::os::unix::fs::symlink(&outside, &slot).unwrap();
        assert!(open_beneath(&root, &validated).is_none());

        std::fs::remove_file(&slot).unwrap();
        std::fs::hard_link(&outside, &slot).unwrap();
        let linked = std::fs::canonicalize(&slot).unwrap();
        assert!(open_beneath(Path::new(&root), &linked).is_none());
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }
}
