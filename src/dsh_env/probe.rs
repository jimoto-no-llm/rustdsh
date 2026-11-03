//! Bounded transport for read-only CLI diagnostics.
use std::time::{Duration, Instant};

/// Run one read-only probe and return its stdout when it exits 0. A failed
/// spawn, a non-zero exit, a timeout and a stuck reader all collapse to None,
/// so callers never have to tell "missing" from "broken" apart.
#[cfg(unix)]
pub(crate) fn run_bounded_capture(
    mut command: std::process::Command,
    limit: u64,
    timeout: Duration,
) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::os::{fd::AsRawFd, unix::process::CommandExt};
    use std::process::Stdio;

    // Nonblocking reads avoid a detached reader that can outlive the probe.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command.process_group(0);
    let child = command.spawn().ok()?;
    struct Cleanup(std::process::Child);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            unsafe {
                libc::kill(-(self.0.id() as i32), libc::SIGKILL);
            }
            let _ = self.0.wait();
        }
    }
    let mut cleanup = Cleanup(child);
    let mut stdout = cleanup.0.stdout.take()?;
    let fd = stdout.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return None;
    }
    let deadline = Instant::now().checked_add(timeout)?;
    let mut output = Vec::new();
    let mut eof = false;
    let mut status = None;
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        let mut buffer = [0_u8; 4096];
        if !eof && output.len() < usize::try_from(limit).unwrap_or(usize::MAX) {
            let remaining = limit
                .saturating_sub(output.len() as u64)
                .min(buffer.len() as u64) as usize;
            match stdout.read(&mut buffer[..remaining]) {
                Ok(0) => eof = true,
                Ok(count) => {
                    output.extend_from_slice(&buffer[..count]);
                    continue;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return None,
            }
        }
        if status.is_none() {
            status = cleanup.0.try_wait().ok()?;
        }
        if let Some(status) = status {
            if !status.success() {
                return None;
            }
            if eof || output.len() as u64 >= limit {
                return Some(output);
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(not(unix))]
pub(crate) fn run_bounded_capture(
    mut command: std::process::Command,
    limit: u64,
    timeout: Duration,
) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::process::Stdio;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    // A descendant can inherit the pipe and keep it open; the deadline below
    // must not wait on this reader, so it is never joined.
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(limit).read_to_end(&mut bytes).map(|_| bytes);
        let _ = sender.send(result);
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()?
        .ok()
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn probe_output_and_deadline_are_bounded() {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "printf hello"]);
        assert_eq!(
            super::run_bounded_capture(command, 4096, std::time::Duration::from_secs(2)),
            Some(b"hello".to_vec())
        );
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let start = std::time::Instant::now();
        assert_eq!(
            super::run_bounded_capture(command, 4096, std::time::Duration::from_millis(50)),
            None
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn probe_kills_descendants_holding_stdout_after_leader_exit() {
        let root = std::env::temp_dir().join(format!(
            "rdsh-probe-{}-{}",
            std::process::id(),
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let pid_file = root.join("pid");
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "sleep 30 & echo $! > \"$1\"; exit 0", "probe"]);
        command.arg(&pid_file);
        assert_eq!(
            super::run_bounded_capture(command, 4096, std::time::Duration::from_millis(150)),
            None
        );
        let pid: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let status = std::fs::read_to_string(format!("/proc/{pid}/stat"));
            if status
                .as_ref()
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                || status.as_ref().is_ok_and(|s| {
                    s.rsplit_once(") ")
                        .is_some_and(|(_, rest)| rest.starts_with('Z'))
                })
            {
                break;
            }
            if std::time::Instant::now() >= deadline {
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
                panic!("probe left descendant running");
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
