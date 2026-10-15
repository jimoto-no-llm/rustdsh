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
    #[cfg(target_os = "macos")]
    nofollow_any: bool,
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
            #[cfg(target_os = "macos")]
            nofollow_any: macos_nofollow_any_supported(),
        })
    }

    #[cfg(not(unix))]
    pub(crate) fn new(_root: &Path) -> Option<Self> {
        None
    }

    #[cfg(unix)]
    pub(crate) fn open(&self, target: &Path) -> Option<std::fs::File> {
        let relative = target.strip_prefix(&self.path).ok()?;
        if relative.as_os_str().is_empty() {
            return None;
        }
        #[cfg(target_os = "macos")]
        if self.nofollow_any {
            match self.open_macos_nofollow_any(relative) {
                Ok(file) => return file,
                Err(error)
                    if error
                        .raw_os_error()
                        .is_some_and(macos_nofollow_any_falls_back) => {}
                Err(_) => return None,
            }
        }
        self.open_component_walk(relative)
    }

    #[cfg(unix)]
    fn open_component_walk(&self, relative: &Path) -> Option<std::fs::File> {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::MetadataExt;

        let mut components = relative.components().peekable();
        let mut current: Option<std::fs::File> = None;
        while let Some(component) = components.next() {
            let name = match component {
                std::path::Component::Normal(name) => CString::new(name.as_bytes()).ok()?,
                _ => return None,
            };
            let flags = libc::O_RDONLY
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | if components.peek().is_none() {
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

    #[cfg(target_os = "macos")]
    fn open_macos_nofollow_any(
        &self,
        relative: &Path,
    ) -> Result<Option<std::fs::File>, std::io::Error> {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::MetadataExt;

        if macos_nofollow_any_must_walk(relative) {
            return Err(std::io::Error::from_raw_os_error(libc::EINVAL));
        }
        if !relative
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
        {
            return Ok(None);
        }
        let name = match CString::new(relative.as_os_str().as_bytes()) {
            Ok(name) => name,
            Err(_) => return Ok(None),
        };
        // O_NOFOLLOW_ANY must not be combined with O_NOFOLLOW (EINVAL in XNU).
        let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW_ANY | libc::O_NONBLOCK;
        let fd = unsafe { libc::openat(self.directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let metadata = match file.metadata() {
            Ok(metadata) => metadata,
            Err(_) => return Ok(None),
        };
        Ok((metadata.is_file() && metadata.nlink() == 1).then_some(file))
    }

    #[cfg(not(unix))]
    pub(crate) fn open(&self, _target: &Path) -> Option<std::fs::File> {
        None
    }
}

#[cfg(target_os = "macos")]
fn macos_nofollow_any_supported() -> bool {
    use std::ffi::CStr;
    use std::mem::MaybeUninit;

    let mut uts = MaybeUninit::<libc::utsname>::zeroed();
    if unsafe { libc::uname(uts.as_mut_ptr()) } != 0 {
        return false;
    }
    let uts = unsafe { uts.assume_init() };
    let release = unsafe { CStr::from_ptr(uts.release.as_ptr()) }.to_bytes();
    macos_nofollow_any_supported_release(release)
}

#[cfg(target_os = "macos")]
fn macos_nofollow_any_supported_release(release: &[u8]) -> bool {
    release
        .split(|byte| *byte == b'.')
        .next()
        .and_then(|major| std::str::from_utf8(major).ok())
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 20)
}

#[cfg(target_os = "macos")]
fn macos_nofollow_any_falls_back(error: i32) -> bool {
    matches!(error, libc::ENAMETOOLONG | libc::EINVAL | libc::ENOTSUP)
}

#[cfg(target_os = "macos")]
fn macos_nofollow_any_must_walk(relative: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;

    relative.components().any(|component| {
        matches!(component, std::path::Component::Normal(name)
            if name.as_bytes().eq_ignore_ascii_case(b"..namedfork"))
    })
}

pub(crate) fn open_beneath(root: &Path, target: &Path) -> Option<std::fs::File> {
    Root::new(root)?.open(target)
}

#[cfg(all(test, unix))]
mod secure_open_tests {
    use super::{open_beneath, Root};
    use std::path::Path;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_nofollow_any_kernel_guard_rejects_every_symlink_component() {
        use std::os::fd::AsRawFd;

        assert!(super::macos_nofollow_any_supported_release(b"20.0.0"));
        assert!(!super::macos_nofollow_any_supported_release(b"19.6.0"));
        assert!(!super::macos_nofollow_any_supported_release(b"invalid"));

        let temporary = std::env::temp_dir().join(format!(
            "rdsh-nofollow-any-{}",
            crate::local_http::random_token().unwrap()
        ));
        let project = temporary.join("project");
        let outside = temporary.join("outside.txt");
        std::fs::create_dir(&temporary).unwrap();
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("file.txt"), "approved").unwrap();
        std::fs::write(&outside, "DUMMY_OUTSIDE_FILE").unwrap();
        std::os::unix::fs::symlink(&outside, project.join("link.txt")).unwrap();

        let root = std::fs::canonicalize(&project).unwrap();
        let reader = Root::new(&root).unwrap();
        assert!(reader.open(&root.join("file.txt")).is_some());
        assert!(reader.open(&root.join("link.txt")).is_none());
        assert!(reader.open(&root.join("../outside.txt")).is_none());

        if reader.nofollow_any {
            let name = std::ffi::CString::new("file.txt").unwrap();
            let flags = libc::O_RDONLY
                | libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | libc::O_NOFOLLOW_ANY
                | libc::O_NONBLOCK;
            let fd = unsafe { libc::openat(reader.directory.as_raw_fd(), name.as_ptr(), flags) };
            assert_eq!(fd, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EINVAL)
            );
        }
        std::fs::remove_dir_all(temporary).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_nofollow_any_falls_back_only_for_supported_open_errors() {
        assert!(super::macos_nofollow_any_falls_back(libc::ENAMETOOLONG));
        assert!(super::macos_nofollow_any_falls_back(libc::EINVAL));
        assert!(super::macos_nofollow_any_falls_back(libc::ENOTSUP));
        assert!(!super::macos_nofollow_any_falls_back(libc::ELOOP));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_nofollow_any_falls_back_for_a_path_longer_than_path_max() {
        use std::io::{Read, Write};
        use std::os::fd::{AsRawFd, FromRawFd};

        let temporary = std::env::temp_dir().join(format!(
            "rdsh-nofollow-any-long-{}",
            crate::local_http::random_token().unwrap()
        ));
        let project = temporary.join("project");
        std::fs::create_dir(&temporary).unwrap();
        std::fs::create_dir(&project).unwrap();
        let root = std::fs::canonicalize(&project).unwrap();
        let reader = Root::new(&root).unwrap();

        let component = "a".repeat(200);
        let mut parent = std::fs::File::open(&root).unwrap();
        let mut target = root.clone();
        for _ in 0..6 {
            let name = std::ffi::CString::new(component.as_bytes()).unwrap();
            assert_eq!(
                unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) },
                0
            );
            let fd = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
                )
            };
            assert!(fd >= 0);
            parent = unsafe { std::fs::File::from_raw_fd(fd) };
            target.push(&component);
        }
        let name = std::ffi::CString::new("file.txt").unwrap();
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CLOEXEC | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
        };
        assert!(fd >= 0);
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        file.write_all(b"approved").unwrap();
        drop(file);
        target.push("file.txt");

        if reader.nofollow_any {
            let relative = target.strip_prefix(&root).unwrap();
            let error = reader.open_macos_nofollow_any(relative).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(libc::ENAMETOOLONG));
        }
        let mut text = String::new();
        reader
            .open(&target)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "approved");
        std::fs::remove_dir_all(temporary).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_nofollow_any_preserves_non_directory_namedfork_rejection() {
        use std::io::{Read, Write};
        use std::os::fd::AsRawFd;

        let temporary = std::env::temp_dir().join(format!(
            "rdsh-nofollow-any-namedfork-{}",
            crate::local_http::random_token().unwrap()
        ));
        let project = temporary.join("project");
        std::fs::create_dir(&temporary).unwrap();
        std::fs::create_dir(&project).unwrap();
        let root = std::fs::canonicalize(&project).unwrap();
        let plain = root.join("plain");
        let mut plain_file = std::fs::File::create(&plain).unwrap();
        plain_file.write_all(b"data").unwrap();
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    plain_file.as_raw_fd(),
                    c"com.apple.ResourceFork".as_ptr(),
                    c"R".as_ptr().cast(),
                    1,
                    0,
                    0,
                )
            },
            0
        );
        drop(plain_file);

        let reader = Root::new(&root).unwrap();
        let resource_fork = root.join("plain/..namedfork/rsrc");
        assert!(reader.open(&resource_fork).is_none());
        assert_eq!(
            reader
                .open_macos_nofollow_any(resource_fork.strip_prefix(&root).unwrap())
                .unwrap_err()
                .raw_os_error(),
            Some(libc::EINVAL)
        );
        assert!(reader.open(&root.join("plain/..NAMEDFORK/rsrc")).is_none());

        let real_fork_directory = root.join("real/..namedfork");
        std::fs::create_dir_all(&real_fork_directory).unwrap();
        let ordinary = real_fork_directory.join("file.txt");
        std::fs::write(&ordinary, "approved").unwrap();
        let mut text = String::new();
        reader
            .open(&ordinary)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "approved");
        std::fs::remove_dir_all(temporary).unwrap();
    }

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
    fn rejects_nested_parent_symlink_swap_after_a_successful_open() {
        use std::io::Read;

        let temporary = std::env::temp_dir().join(format!(
            "rdsh-nested-parent-open-{}",
            crate::local_http::random_token().unwrap()
        ));
        let project = temporary.join("project");
        let nested_parent = project.join("one/two");
        let nested_file = nested_parent.join("three/four/file.txt");
        let outside = temporary.join("outside");
        std::fs::create_dir_all(nested_file.parent().unwrap()).unwrap();
        std::fs::create_dir_all(outside.join("three/four")).unwrap();
        std::fs::write(&nested_file, "approved").unwrap();
        std::fs::write(outside.join("three/four/file.txt"), "DUMMY_OUTSIDE_FILE").unwrap();

        let root = std::fs::canonicalize(&project).unwrap();
        let reader = Root::new(&root).unwrap();
        let validated = std::fs::canonicalize(&nested_file).unwrap();
        let mut text = String::new();
        reader
            .open(&validated)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "approved");

        std::fs::rename(&nested_parent, project.join("one/original-two")).unwrap();
        std::os::unix::fs::symlink(&outside, &nested_parent).unwrap();

        assert!(reader.open(&validated).is_none());
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
