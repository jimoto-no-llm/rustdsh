//! Cross-process locks for read-modify-write files.
//!
//! General settings use a stable sibling locked by the OS, which releases it
//! after a process exits. Credentials use a DSH-compatible PID marker so both
//! programs coordinate on the same file and can recover a proven-dead owner.
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const CREDENTIAL_LOCK_WAIT: Duration = Duration::from_secs(30);
const CREDENTIAL_LOCK_RETRY_INITIAL: Duration = Duration::from_millis(20);
const CREDENTIAL_LOCK_RETRY_MAX: Duration = Duration::from_millis(200);

/// The `.credentials.yaml.lock` protocol shared with DeepSeek Harness.
///
/// Unlike [`FileLock`], this lock is an exclusive-create PID marker which is
/// removed on release. DSH uses the same marker protocol, so both programs
/// serialize updates to the credentials document. A lock with a complete PID
/// record is reclaimed only after its holder is proven gone and contenders
/// coordinate through DSH's record-specific takeover file.
pub(crate) struct CredentialFileLock {
    lock_path: PathBuf,
}

impl CredentialFileLock {
    pub(crate) fn exclusive_for(
        target: &Path,
        locale: crate::locale::Locale,
    ) -> anyhow::Result<Self> {
        Self::exclusive_for_timeout(target, CREDENTIAL_LOCK_WAIT, locale)
    }

    fn exclusive_for_timeout(
        target: &Path,
        timeout: Duration,
        locale: crate::locale::Locale,
    ) -> anyhow::Result<Self> {
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    anyhow::anyhow!(
                        "{} {}: {error}",
                        lock_text(
                            locale,
                            "cannot create credential lock directory",
                            "无法创建凭据锁目录",
                            "認証情報ロックディレクトリを作成できません"
                        ),
                        parent.display()
                    )
                })?;
            }
        }

        let lock_path = append_path_suffix(target, ".lock");
        let started = Instant::now();
        let mut retry_delay = CREDENTIAL_LOCK_RETRY_INITIAL;
        loop {
            match create_exclusive_marker(&lock_path) {
                Ok(mut marker) => {
                    if let Err(error) = write_pid_record(&mut marker) {
                        drop(marker);
                        let _ = std::fs::remove_file(&lock_path);
                        return Err(anyhow::anyhow!(
                            "{} {}: {error}",
                            lock_text(
                                locale,
                                "cannot write credential lock file",
                                "无法写入凭据锁文件",
                                "認証情報ロックファイルを書き込めません"
                            ),
                            lock_path.display()
                        ));
                    }
                    drop(marker);
                    return Ok(Self { lock_path });
                }
                Err(error) if lock_contention(&error, &lock_path) => {
                    if take_over_exited_lock(&lock_path, locale)? {
                        continue;
                    }
                }
                Err(error) => {
                    return Err(anyhow::anyhow!(
                        "{} {}: {error}",
                        lock_text(
                            locale,
                            "cannot create credential lock file",
                            "无法创建凭据锁文件",
                            "認証情報ロックファイルを作成できません"
                        ),
                        lock_path.display()
                    ));
                }
            }

            let elapsed = started.elapsed();
            if elapsed >= timeout {
                if marker_has_no_valid_owner(&lock_path) {
                    anyhow::bail!(
                        "{} {} ({})",
                        lock_text(
                            locale,
                            "atomic-write: timed out waiting for the writer lock at",
                            "原子写入：等待写入器锁超时，位置",
                            "アトミック書き込み: 書き込みロックの待機がタイムアウトしました:"
                        ),
                        lock_path.display(),
                        lock_text(
                            locale,
                            "marker has no valid PID record and was left untouched",
                            "标记没有有效的 PID 记录，且未作修改",
                            "マーカーに有効な PID レコードがないため変更しませんでした"
                        )
                    );
                }
                anyhow::bail!(
                    "{} {}",
                    lock_text(
                        locale,
                        "atomic-write: timed out waiting for the writer lock at",
                        "原子写入：等待写入器锁超时，位置",
                        "アトミック書き込み: 書き込みロックの待機がタイムアウトしました:"
                    ),
                    lock_path.display()
                );
            }
            std::thread::sleep(retry_delay.min(timeout.saturating_sub(elapsed)));
            retry_delay = (retry_delay * 2).min(CREDENTIAL_LOCK_RETRY_MAX);
        }
    }
}

impl Drop for CredentialFileLock {
    fn drop(&mut self) {
        // The marker itself owns the lock. Removing it after the protected
        // operation lets either writer protocol acquire it on the next pass.
        let _ = std::fs::remove_file(&self.lock_path);
    }
}

struct TakeoverClaim {
    path: PathBuf,
}

impl Drop for TakeoverClaim {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn append_path_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn create_exclusive_marker(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    options.open(path)
}

fn write_pid_record(file: &mut File) -> std::io::Result<()> {
    writeln!(file, "{}", std::process::id())
}

fn lock_contention(error: &std::io::Error, path: &Path) -> bool {
    error.kind() == std::io::ErrorKind::AlreadyExists
        || (error.kind() == std::io::ErrorKind::PermissionDenied
            && std::fs::symlink_metadata(path).is_ok())
}

/// Read only regular marker files with a plausible PID-record size. On Unix,
/// O_NOFOLLOW closes the symlink race between the metadata check and the open.
fn read_lock_record(path: &Path) -> Option<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > 11 {
        return None;
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    let file = options.open(path).ok()?;
    let mut record = Vec::with_capacity(metadata.len() as usize);
    file.take(12).read_to_end(&mut record).ok()?;
    (record.len() <= 11).then_some(record)
}

fn parse_pid_record(record: &[u8]) -> Option<u32> {
    if record.len() < 2 || record.last() != Some(&b'\n') {
        return None;
    }
    let digits = &record[..record.len() - 1];
    if digits.is_empty() || digits.len() > 10 || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let pid = std::str::from_utf8(digits).ok()?.parse::<u32>().ok()?;
    (pid > 0 && pid <= i32::MAX as u32).then_some(pid)
}

fn marker_has_no_valid_owner(path: &Path) -> bool {
    let has_marker = std::fs::symlink_metadata(path).is_ok();
    has_marker
        && read_lock_record(path)
            .as_deref()
            .and_then(parse_pid_record)
            .is_none()
}

fn holder_exited(record: &[u8]) -> bool {
    let Some(pid) = parse_pid_record(record) else {
        // Partial writes, malformed markers, and out-of-range PIDs are not
        // evidence that the recorded owner exited.
        return false;
    };
    if pid == std::process::id() {
        return false;
    }
    !process_is_alive(pid)
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    // SAFETY: kill(pid, 0) only probes process existence and sends no signal.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 258;
    const ERROR_INVALID_PARAMETER: u32 = 87;

    // SAFETY: the returned process handle is closed below. Access is limited
    // to synchronization; a denied probe is treated as alive, like EPERM.
    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        // SAFETY: GetLastError has no preconditions.
        return unsafe { GetLastError() } != ERROR_INVALID_PARAMETER;
    }
    // SAFETY: handle is a valid process handle and zero is a nonblocking wait.
    let wait = unsafe { WaitForSingleObject(handle, 0) };
    // SAFETY: this function owns the process handle returned by OpenProcess.
    let _ = unsafe { CloseHandle(handle) };
    match wait {
        WAIT_OBJECT_0 => false,
        WAIT_TIMEOUT => true,
        _ => true,
    }
}

#[cfg(not(any(unix, windows)))]
fn process_is_alive(_pid: u32) -> bool {
    // Without a supported process probe, never guess that a holder is dead.
    true
}

fn take_over_exited_lock(lock_path: &Path, locale: crate::locale::Locale) -> anyhow::Result<bool> {
    let Some(record) = read_lock_record(lock_path) else {
        return Ok(false);
    };
    if !holder_exited(&record) {
        return Ok(false);
    }

    let claim_path = takeover_claim_path(lock_path, &record);
    let mut claim = match create_exclusive_marker(&claim_path) {
        Ok(claim) => claim,
        Err(error) if lock_contention(&error, &claim_path) => return Ok(false),
        Err(error) => {
            return Err(anyhow::anyhow!(
                "{} {}: {error}",
                lock_text(
                    locale,
                    "cannot create credential lock takeover claim",
                    "无法创建凭据锁接管声明",
                    "認証情報ロック引き継ぎ要求を作成できません"
                ),
                claim_path.display()
            ));
        }
    };
    if let Err(error) = write_pid_record(&mut claim) {
        drop(claim);
        let _ = std::fs::remove_file(&claim_path);
        return Err(anyhow::anyhow!(
            "{} {}: {error}",
            lock_text(
                locale,
                "cannot write credential lock takeover claim",
                "无法写入凭据锁接管声明",
                "認証情報ロック引き継ぎ要求を書き込めません"
            ),
            claim_path.display()
        ));
    }
    drop(claim);

    let _claim = TakeoverClaim { path: claim_path };
    if read_lock_record(lock_path).as_deref() != Some(record.as_slice()) || !holder_exited(&record)
    {
        return Ok(false);
    }
    match std::fs::remove_file(lock_path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Ok(false),
    }
}

fn takeover_claim_path(lock_path: &Path, record: &[u8]) -> PathBuf {
    // sha2 0.11 returns a hybrid_array::Array without LowerHex; encode the
    // bytes the same way {:x} did (lowercase, 64 characters).
    let digest: String = Sha256::digest(record)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    append_path_suffix(lock_path, &format!(".takeover-{}", &digest[..16]))
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(
        dwDesiredAccess: u32,
        bInheritHandle: i32,
        dwProcessId: u32,
    ) -> *mut std::ffi::c_void;
    fn WaitForSingleObject(hHandle: *mut std::ffi::c_void, dwMilliseconds: u32) -> u32;
    fn CloseHandle(hObject: *mut std::ffi::c_void) -> i32;
    fn GetLastError() -> u32;
}

pub(crate) struct FileLock {
    file: File,
    #[cfg(windows)]
    overlapped: Box<Overlapped>,
}

impl FileLock {
    pub(crate) fn exclusive_for(
        target: &Path,
        locale: crate::locale::Locale,
    ) -> anyhow::Result<Self> {
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    anyhow::anyhow!(
                        "{} {}: {error}",
                        lock_text(
                            locale,
                            "cannot create lock directory",
                            "无法创建锁目录",
                            "ロックディレクトリを作成できません"
                        ),
                        parent.display()
                    )
                })?;
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
        let file = options.open(&lock_path).map_err(|e| {
            anyhow::anyhow!(
                "{} {}: {e}",
                lock_text(
                    locale,
                    "cannot open lock file",
                    "无法打开锁文件",
                    "ロックファイルを開けません"
                ),
                lock_path.display()
            )
        })?;

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
                        "{} {}: {error}",
                        lock_text(locale, "cannot lock", "无法锁定", "ロックできません"),
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
                    "{} {}: {}",
                    lock_text(locale, "cannot lock", "无法锁定", "ロックできません"),
                    lock_path.display(),
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Self { file, overlapped })
        }
    }
}

fn lock_text(
    locale: crate::locale::Locale,
    english: &'static str,
    chinese: &'static str,
    japanese: &'static str,
) -> &'static str {
    match locale {
        crate::locale::Locale::English => english,
        crate::locale::Locale::Chinese => chinese,
        crate::locale::Locale::Japanese => japanese,
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
    use super::{process_is_alive, takeover_claim_path, CredentialFileLock, FileLock};
    use std::path::{Path, PathBuf};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Barrier,
    };
    use std::time::Duration;

    fn temp_target(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "rdsh-credential-lock-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.join(name), dir)
    }

    fn lock_path(target: &Path) -> PathBuf {
        let mut name = target.as_os_str().to_os_string();
        name.push(".lock");
        PathBuf::from(name)
    }

    fn unused_pid() -> u32 {
        (i32::MAX as u32 - 1_000..i32::MAX as u32)
            .rev()
            .find(|pid| !process_is_alive(*pid))
            .expect("the high PID range should contain an unused process id")
    }

    #[test]
    fn takeover_claim_name_matches_dsh_record_digest() {
        let claim = takeover_claim_path(Path::new("credentials.yaml.lock"), b"123\n");
        assert_eq!(
            claim.file_name().unwrap(),
            "credentials.yaml.lock.takeover-181210f8f9c779c2"
        );
    }

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
                let _lock = FileLock::exclusive_for(&path, crate::locale::Locale::English).unwrap();
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
        assert!(FileLock::exclusive_for(&path, crate::locale::Locale::English).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn credential_lock_writes_dsh_pid_marker_and_removes_it_on_drop() {
        let (target, dir) = temp_target(".credentials.yaml");
        let marker = lock_path(&target);

        let lock = CredentialFileLock::exclusive_for_timeout(
            &target,
            Duration::from_secs(1),
            crate::locale::Locale::English,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(&marker).unwrap(),
            format!("{}\n", std::process::id()).as_bytes()
        );
        drop(lock);

        assert!(!marker.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn credential_lock_waits_for_live_dsh_marker_to_be_removed() {
        let (target, dir) = temp_target(".credentials.yaml");
        let marker = lock_path(&target);
        std::fs::write(&marker, format!("{}\n", std::process::id())).unwrap();

        let (started_tx, started_rx) = mpsc::channel();
        let (acquired_tx, acquired_rx) = mpsc::channel();
        let worker_target = target.clone();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let lock = CredentialFileLock::exclusive_for_timeout(
                &worker_target,
                Duration::from_secs(2),
                crate::locale::Locale::English,
            )
            .unwrap();
            acquired_tx.send(()).unwrap();
            drop(lock);
        });

        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        std::thread::sleep(Duration::from_millis(80));
        assert!(acquired_rx.try_recv().is_err());
        assert_eq!(
            std::fs::read(&marker).unwrap(),
            format!("{}\n", std::process::id()).as_bytes()
        );

        std::fs::remove_file(&marker).unwrap();
        acquired_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the waiting writer should acquire after DSH releases the marker");
        worker.join().unwrap();
        assert!(!marker.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn credential_lock_takes_over_dead_dsh_marker_using_shared_claim_name() {
        let (target, dir) = temp_target(".credentials.yaml");
        let marker = lock_path(&target);
        std::fs::write(&marker, format!("{}\n", unused_pid())).unwrap();

        let lock = CredentialFileLock::exclusive_for_timeout(
            &target,
            Duration::from_secs(1),
            crate::locale::Locale::English,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(&marker).unwrap(),
            format!("{}\n", std::process::id()).as_bytes()
        );
        assert!(!std::fs::read_dir(&dir).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".takeover-")
        }));
        drop(lock);
        assert!(!marker.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn credential_lock_does_not_reclaim_an_incomplete_pid_record() {
        for (locale, timeout, invalid_marker) in [
            (
                crate::locale::Locale::English,
                "timed out waiting for the writer lock",
                "no valid PID record",
            ),
            (
                crate::locale::Locale::Chinese,
                "等待写入器锁超时",
                "没有有效的 PID 记录",
            ),
            (
                crate::locale::Locale::Japanese,
                "書き込みロックの待機がタイムアウト",
                "有効な PID レコードがない",
            ),
        ] {
            let (target, dir) = temp_target(".credentials.yaml");
            let marker = lock_path(&target);
            std::fs::write(&marker, b"").unwrap();
            let error = match CredentialFileLock::exclusive_for_timeout(
                &target,
                Duration::from_millis(60),
                locale,
            ) {
                Ok(lock) => {
                    drop(lock);
                    panic!("an incomplete marker must not be reclaimed");
                }
                Err(error) => error,
            };
            assert!(error.to_string().contains(timeout), "{error:#}");
            assert!(error.to_string().contains(invalid_marker), "{error:#}");
            assert_eq!(std::fs::read(&marker).unwrap(), b"");
            assert!(!std::fs::read_dir(&dir).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".takeover-")
            }));
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn credential_lock_serializes_threads_using_one_marker() {
        let (target, dir) = temp_target(".credentials.yaml");
        let barrier = Arc::new(Barrier::new(3));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let mut joins = Vec::new();
        for _ in 0..2 {
            let target = target.clone();
            let barrier = Arc::clone(&barrier);
            let active = Arc::clone(&active);
            let maximum = Arc::clone(&maximum);
            joins.push(std::thread::spawn(move || {
                barrier.wait();
                let _lock = CredentialFileLock::exclusive_for_timeout(
                    &target,
                    Duration::from_secs(2),
                    crate::locale::Locale::English,
                )
                .unwrap();
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(current, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(40));
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        barrier.wait();
        for join in joins {
            join.join().unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
