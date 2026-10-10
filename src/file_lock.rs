//! Small cross-process exclusive locks for read-modify-write files.
//!
//! The lock file is a stable sibling of the target. The OS releases the lock
//! when the process exits, so a crash cannot leave a stale lock marker behind.
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

pub(crate) struct FileLock {
    file: File,
    #[cfg(windows)]
    overlapped: Box<Overlapped>,
}

impl FileLock {
    pub(crate) fn exclusive_for(target: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let mut lock_name = target.as_os_str().to_os_string();
        lock_name.push(".lock");
        let lock_path = PathBuf::from(lock_name);
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        }
        let file = options
            .open(&lock_path)
            .map_err(|e| anyhow::anyhow!("cannot open lock file {}: {e}", lock_path.display()))?;

        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            loop {
                // SAFETY: flock only observes the live descriptor owned by `file`.
                let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
                if result == 0 {
                    break;
                }
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::Interrupted {
                    return Err(anyhow::anyhow!(
                        "cannot lock {}: {error}",
                        lock_path.display()
                    ));
                }
            }
            Ok(Self { file })
        }

        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let mut overlapped = Box::new(Overlapped::default());
            // SAFETY: the handle belongs to `file`; `overlapped` remains alive
            // for the duration of the lock and is released in Drop.
            let ok = unsafe {
                LockFileEx(
                    file.as_raw_handle(),
                    LOCKFILE_EXCLUSIVE_LOCK,
                    0,
                    1,
                    0,
                    &mut *overlapped,
                )
            };
            if ok == 0 {
                return Err(anyhow::anyhow!(
                    "cannot lock {}: {}",
                    lock_path.display(),
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Self { file, overlapped })
        }
    }
}

#[cfg(windows)]
const LOCKFILE_EXCLUSIVE_LOCK: u32 = 0x0000_0002;

#[cfg(windows)]
#[allow(non_snake_case)]
#[repr(C)]
struct Overlapped {
    Internal: usize,
    InternalHigh: usize,
    Offset: u32,
    OffsetHigh: u32,
    hEvent: *mut std::ffi::c_void,
}

#[cfg(windows)]
impl Default for Overlapped {
    fn default() -> Self {
        Self {
            Internal: 0,
            InternalHigh: 0,
            Offset: 0,
            OffsetHigh: 0,
            hEvent: std::ptr::null_mut(),
        }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LockFileEx(
        hFile: *mut std::ffi::c_void,
        dwFlags: u32,
        dwReserved: u32,
        nNumberOfBytesToLockLow: u32,
        nNumberOfBytesToLockHigh: u32,
        lpOverlapped: *mut Overlapped,
    ) -> i32;
    fn UnlockFileEx(
        hFile: *mut std::ffi::c_void,
        dwReserved: u32,
        nNumberOfBytesToUnlockLow: u32,
        nNumberOfBytesToUnlockHigh: u32,
        lpOverlapped: *mut Overlapped,
    ) -> i32;
}

impl Drop for FileLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: this descriptor still owns the flock held by this guard.
            let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            // SAFETY: both the file handle and OVERLAPPED are alive until here.
            let _ =
                unsafe { UnlockFileEx(self.file.as_raw_handle(), 0, 1, 0, &mut *self.overlapped) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::FileLock;
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    #[test]
    fn exclusive_lock_serializes_threads_and_releases_on_drop() {
        let dir = std::env::temp_dir().join(format!(
            "rdsh-file-lock-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.json");
        let barrier = Arc::new(Barrier::new(3));
        let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let maximum = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut joins = Vec::new();
        for _ in 0..2 {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            let active = Arc::clone(&active);
            let maximum = Arc::clone(&maximum);
            joins.push(std::thread::spawn(move || {
                barrier.wait();
                let _lock = FileLock::exclusive_for(&path).unwrap();
                let current = active.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                maximum.fetch_max(current, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(40));
                active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            }));
        }
        barrier.wait();
        for join in joins {
            join.join().unwrap();
        }
        assert_eq!(maximum.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(FileLock::exclusive_for(&path).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
