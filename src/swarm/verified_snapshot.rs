//! macOS cannot execute /dev/fd paths. Keep a private, digest-addressed copy
//! available for Gas City's later self-invocations as well as this CLI process.

use super::file_digest;
use anyhow::{bail, Context, Result};
use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{Seek, SeekFrom};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

#[cfg(not(target_os = "linux"))]
pub(super) fn prepare(source: &mut File, expected: &str) -> Result<(PathBuf, File)> {
    // The per-user temp root is sufficient for a local runtime cache. Do not
    // delete the cache on CLI exit: a detached Gas City controller may need it.
    let root = std::env::temp_dir().join(format!(
        "rdsh-gascity-{}-{}",
        unsafe { libc::geteuid() },
        expected.to_ascii_lowercase()
    ));
    prepare_in(source, expected, &root)
}

fn prepare_in(source: &mut File, expected: &str, root: &Path) -> Result<(PathBuf, File)> {
    match DirBuilder::new().mode(0o700).create(root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error).context("Gas City の検証済みコピー領域を作れません"),
    }
    let metadata = root.symlink_metadata()?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        bail!("Gas City のコピー領域は実行ユーザー所有の非公開ディレクトリが必要です");
    }
    let path = root.join("gc");
    let open = || {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
    };
    if let Ok(file) = open() {
        return checked(path, file, expected);
    }

    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|e| anyhow::anyhow!("cache nonce: {e}"))?;
    let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
    struct Staging(PathBuf);
    impl Drop for Staging {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let staging = Staging(root.join(nonce));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&staging.0)?;
    source.seek(SeekFrom::Start(0))?;
    std::io::copy(source, &mut output)?;
    output.set_permissions(std::fs::Permissions::from_mode(0o500))?;
    drop(output);
    let (_, verified) = checked(staging.0.clone(), File::open(&staging.0)?, expected)?;
    drop(verified);
    // Publish without replacing an existing snapshot, including concurrent calls.
    match std::fs::hard_link(&staging.0, &path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error).context("Gas City の検証済みコピーを公開できません"),
    }
    checked(path.clone(), open()?, expected)
}

fn checked(path: PathBuf, mut file: File, expected: &str) -> Result<(PathBuf, File)> {
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o277 != 0
        || metadata.mode() & 0o500 != 0o500
        || !file_digest(&mut file)?.eq_ignore_ascii_case(expected)
    {
        bail!("Gas City のコピーの所有者・権限・SHA-256 が一致しません");
    }
    file.seek(SeekFrom::Start(0))?;
    Ok((path, file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_survives_source_replacement_and_rejects_corruption() {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!("rdsh-snapshot-test-{:x?}", random));
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let fixture = Fixture(root);
        std::fs::create_dir(&fixture.0).unwrap();
        let source_path = fixture.0.join("source");
        std::fs::copy("/bin/sh", &source_path).unwrap();
        let mut source = File::open(&source_path).unwrap();
        let digest = file_digest(&mut source).unwrap();
        let cache = fixture.0.join("cache");
        let (snapshot, _) = prepare_in(&mut source, &digest, &cache).unwrap();
        std::fs::write(&source_path, b"replacement").unwrap();
        assert_eq!(
            std::process::Command::new(&snapshot)
                .args(["-c", "exit 73"])
                .status()
                .unwrap()
                .code(),
            Some(73)
        );
        assert_eq!(
            prepare_in(&mut source, &digest, &cache).unwrap().0,
            snapshot
        );
        std::fs::set_permissions(&snapshot, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&snapshot, b"corrupt cache").unwrap();
        std::fs::set_permissions(&snapshot, std::fs::Permissions::from_mode(0o500)).unwrap();
        assert!(prepare_in(&mut source, &digest, &cache).is_err());
        let invalid_cache = fixture.0.join("invalid-cache");
        assert!(prepare_in(&mut source, &digest, &invalid_cache).is_err());
        assert!(!invalid_cache.join("gc").exists());
        std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(prepare_in(&mut source, &digest, &cache).is_err());
    }
}
