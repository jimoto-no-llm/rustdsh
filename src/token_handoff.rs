//! Per-process bearer-token handoff without putting the credential in logs or argv.

use anyhow::{bail, Context, Result};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct TokenHandoff {
    path: PathBuf,
}

impl TokenHandoff {
    pub fn create(token: &str) -> Result<Self> {
        let dir = std::env::temp_dir();
        for _ in 0..8 {
            // The name is independently random; the bearer credential is only file content.
            let name = format!("rdsh-token-{}.txt", crate::local_http::random_token()?);
            let path = dir.join(name);
            let mut file = match open_restricted(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!(
                            "cannot create protected token handoff file {}",
                            path.display()
                        )
                    });
                }
            };
            if let Err(error) = write_handoff(&mut file, &path, token) {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(error);
            }
            return Ok(Self { path });
        }
        bail!(
            "could not create a unique token handoff file in {}",
            dir.display()
        )
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TokenHandoff {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn open_restricted(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(windows)]
    if let Err(error) = restrict_windows_acl(path) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(std::io::Error::other(error.to_string()));
    }
    #[cfg(not(any(unix, windows)))]
    {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "secure token handoff is not supported on this platform",
        ));
    }
    Ok(file)
}

fn write_handoff(file: &mut File, path: &Path, token: &str) -> Result<()> {
    file.write_all(token.as_bytes())
        .with_context(|| format!("cannot write token handoff file {}", path.display()))?;
    file.sync_all()
        .with_context(|| format!("cannot flush token handoff file {}", path.display()))
}

#[cfg(windows)]
fn restrict_windows_acl(path: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let system_root = std::env::var_os("SystemRoot")
        .context("SystemRoot is unavailable; cannot protect the token handoff file")?;
    let system32 = PathBuf::from(system_root).join("System32");
    let whoami = std::process::Command::new(system32.join("whoami.exe"))
        .args(["/user", "/fo", "csv", "/nh"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .context("cannot determine the current Windows account SID")?;
    if !whoami.status.success() {
        bail!("cannot determine the current Windows account SID");
    }
    let output = String::from_utf8_lossy(&whoami.stdout);
    let sid = output
        .lines()
        .find_map(parse_whoami_sid)
        .context("whoami did not return a valid current-account SID")?;

    // Create the file empty, then remove inherited access before writing any secret bytes.
    // Keep SYSTEM access for normal Windows servicing; the current account gets full control.
    let acl = std::process::Command::new(system32.join("icacls.exe"))
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(format!("*{sid}:(F)"))
        .arg("*S-1-5-18:(F)")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .with_context(|| {
            format!(
                "cannot set permissions on token handoff file {}",
                path.display()
            )
        })?;
    if !acl.status.success() {
        bail!(
            "cannot set permissions on token handoff file {}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(windows)]
fn parse_whoami_sid(line: &str) -> Option<String> {
    let (_, sid) = line.rsplit_once("\",\"")?;
    let sid = sid.trim().trim_matches('"').trim_start_matches('\u{feff}');
    let mut parts = sid.split('-');
    if parts.next()? != "S" || parts.next()? != "1" {
        return None;
    }
    let rest: Vec<_> = parts.collect();
    if rest.len() < 2
        || rest
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some(sid.to_owned())
}

#[cfg(test)]
mod tests {
    use super::TokenHandoff;

    #[test]
    fn handoff_contains_token_and_is_removed_on_drop() {
        let token = "credential-that-must-not-be-in-the-path";
        let handoff = TokenHandoff::create(token).unwrap();
        assert_ne!(handoff.path().file_name().unwrap().to_string_lossy(), token);
        assert_eq!(std::fs::read_to_string(handoff.path()).unwrap(), token);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(handoff.path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let path = handoff.path().to_owned();
        drop(handoff);
        assert!(!path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn parses_current_user_sid_from_whoami_csv() {
        assert_eq!(
            super::parse_whoami_sid("\"DOMAIN\\\\user\",\"S-1-5-21-1-2-3-1000\""),
            Some("S-1-5-21-1-2-3-1000".to_owned())
        );
        assert_eq!(super::parse_whoami_sid("invalid"), None);
    }
}
