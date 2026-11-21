//! Bounded workspace writes with create-new semantics and checked replacement.
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

const FILE_LIMIT: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteArgs {
    path: String,
    content: String,
    expected_content: Option<String>,
}

fn arguments(value: &Value) -> Result<WriteArgs> {
    let args: WriteArgs = serde_json::from_value(value.clone())
        .map_err(|_| anyhow::anyhow!("writeの引数が不正です"))?;
    super::tools::safe_path(&args.path)?;
    if value
        .get("expected_content")
        .is_some_and(|v| !v.is_string())
        || args.path.contains('\0')
        || args.content.len() > FILE_LIMIT
        || args
            .expected_content
            .as_ref()
            .is_some_and(|v| v.len() > FILE_LIMIT)
    {
        bail!("writeの内容はUTF-8で64KiB以下、expected_contentは省略または文字列にしてください");
    }
    Ok(args)
}

pub(super) fn validate_write(value: &Value) -> Result<()> {
    arguments(value).map(|_| ())
}

pub(super) fn write_file(workspace: &Path, value: &Value) -> Result<Value> {
    let args = arguments(value)?;
    write(workspace, &args)?;
    Ok(json!({"path":args.path,"bytesWritten":args.content.len(),"executed":true}))
}

#[cfg(not(unix))]
fn write(_workspace: &Path, _args: &WriteArgs) -> Result<()> {
    bail!("このプラットフォームでは安全なnative writeは未対応です")
}

#[cfg(unix)]
fn write(workspace: &Path, args: &WriteArgs) -> Result<()> {
    unix::write(workspace, args)
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::ffi::CString;
    use std::fs::{File, Metadata, Permissions};
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::Component;

    fn error(path: &str) -> anyhow::Error {
        let error = std::io::Error::last_os_error();
        let reason = match error.raw_os_error() {
            Some(libc::ELOOP) => "symlinkは許可されません",
            Some(libc::ENOTDIR) => "親がディレクトリではない、またはsymlinkです",
            Some(libc::EEXIST) => "既存ファイルにはexpected_contentが必要です",
            _ => match error.kind() {
                std::io::ErrorKind::NotFound => "ファイルまたは親ディレクトリが見つかりません",
                std::io::ErrorKind::PermissionDenied => "書込み権限がありません",
                _ => "安全に書き込めません",
            },
        };
        anyhow::anyhow!("ファイル {} を書き込めません（{reason}）", json!(path))
    }

    fn parent(workspace: &Path, path: &str) -> Result<(OwnedFd, CString)> {
        let root = CString::new(workspace.as_os_str().as_bytes())?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
        let fd = unsafe { libc::open(root.as_ptr(), flags) };
        if fd < 0 {
            return Err(error(path));
        }
        let mut parent = unsafe { OwnedFd::from_raw_fd(fd) };
        let parts: Vec<_> = Path::new(path).components().collect();
        for part in &parts[..parts.len() - 1] {
            let Component::Normal(name) = part else {
                bail!("不正なパスです")
            };
            let name = CString::new(name.as_bytes())?;
            let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                return Err(error(path));
            }
            parent = unsafe { OwnedFd::from_raw_fd(fd) };
        }
        let Component::Normal(name) = parts.last().unwrap() else {
            bail!("不正なパスです")
        };
        Ok((parent, CString::new(name.as_bytes())?))
    }

    fn current(parent: &OwnedFd, name: &CString, args: &WriteArgs) -> Result<Metadata> {
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(error(&args.path));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let meta = file.metadata()?;
        if !meta.is_file() || meta.len() > FILE_LIMIT as u64 {
            bail!("writeの更新対象はUTF-8の通常ファイル（64KiB以下）にしてください");
        }
        let mut bytes = Vec::new();
        (&file)
            .take(FILE_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > FILE_LIMIT
            || args.expected_content.as_deref().map(str::as_bytes) != Some(bytes.as_slice())
        {
            bail!("WRITE_CONFLICT: 現在の内容がexpected_contentと一致しません。読み直してください");
        }
        if !same_version(&meta, &file.metadata()?) {
            bail!("WRITE_CONFLICT: 読取り中にファイルが変更されました");
        }
        Ok(meta)
    }

    fn same_version(a: &Metadata, b: &Metadata) -> bool {
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.len() == b.len()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
            && a.mode() == b.mode()
    }

    struct TemporaryFile<'a> {
        parent: &'a OwnedFd,
        name: CString,
    }
    impl Drop for TemporaryFile<'_> {
        fn drop(&mut self) {
            unsafe {
                libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), 0);
            }
        }
    }

    pub(super) fn write(workspace: &Path, args: &WriteArgs) -> Result<()> {
        let (parent, name) = parent(workspace, &args.path)?;
        let existing = if args.expected_content.is_some() {
            Some(current(&parent, &name, args)?)
        } else {
            None
        };
        let temporary_name = CString::new(format!(
            ".rdsh-write-{}",
            crate::local_http::random_token()?
        ))?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                temporary_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(error(&args.path));
        }
        // Only remove the temporary entry after this process created it.
        let temporary = TemporaryFile {
            parent: &parent,
            name: temporary_name,
        };
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(args.content.as_bytes())?;
        if let Some(meta) = &existing {
            // Preserve normal access/executable bits, never create a set-ID file.
            file.set_permissions(Permissions::from_mode(meta.mode() & 0o777))?;
        }
        file.sync_all()?;
        let result = if let Some(meta) = existing {
            // Recheck after preparing the replacement. This is optimistic conflict
            // detection, not a filesystem compare-and-swap against other writers.
            if !same_version(&meta, &current(&parent, &name, args)?) {
                bail!("WRITE_CONFLICT: 準備中にファイルが変更されました");
            }
            // rename replaces the directory entry, never a symlink/hardlink target.
            unsafe {
                libc::renameat(
                    parent.as_raw_fd(),
                    temporary.name.as_ptr(),
                    parent.as_raw_fd(),
                    name.as_ptr(),
                )
            }
        } else {
            // linkat without AT_SYMLINK_FOLLOW is atomic create-new on all Unix
            // targets. Existing entries (including dangling links) are untouched.
            unsafe {
                libc::linkat(
                    parent.as_raw_fd(),
                    temporary.name.as_ptr(),
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    0,
                )
            }
        };
        if result != 0 {
            return Err(error(&args.path));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_strict_arguments_paths_and_byte_limits() {
        for args in [
            json!({"path":"a.txt","content":"a","extra":true}),
            json!({"path":"a.txt","content":"a","expected_content":null}),
            json!({"path":"../a.txt","content":"a"}),
            json!({"path":"/tmp/a.txt","content":"a"}),
            json!({"path":".env","content":"a"}),
            json!({"path":"credentials.json","content":"a"}),
            json!({"path":"a.txt","content":"é".repeat(FILE_LIMIT / 2 + 1)}),
            json!({"path":"a.txt","content":"a","expected_content":"a".repeat(FILE_LIMIT + 1)}),
        ] {
            assert!(validate_write(&args).is_err(), "{args:?}");
        }
        assert!(validate_write(&json!({"path":"dir/a.txt","content":""})).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn creates_new_and_checks_existing_content_before_atomic_replacement() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = super::super::sdk::TemporaryRoot::create().unwrap();
        let path = root.0.join("file.txt");
        assert_eq!(
            write_file(&root.0, &json!({"path":"file.txt","content":"old 日本語"})).unwrap()
                ["executed"],
            true
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old 日本語");
        assert!(write_file(&root.0, &json!({"path":"file.txt","content":"clobber"})).is_err());
        assert!(write_file(
            &root.0,
            &json!({"path":"file.txt","content":"clobber","expected_content":"stale"})
        )
        .unwrap_err()
        .to_string()
        .contains("WRITE_CONFLICT"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old 日本語");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o751)).unwrap();
        let old_ino = std::fs::metadata(&path).unwrap().ino();
        let result = write_file(
            &root.0,
            &json!({"path":"file.txt","content":"new","expected_content":"old 日本語"}),
        )
        .unwrap();
        assert_eq!(result["bytesWritten"], 3);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o751);
        assert_ne!(std::fs::metadata(&path).unwrap().ino(), old_ino);
        assert_eq!(
            std::fs::read_dir(&root.0).unwrap().count(),
            1,
            "temporary files must be removed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_links_missing_parents_and_non_regular_or_oversized_targets() {
        use std::os::unix::fs::symlink;
        let root = super::super::sdk::TemporaryRoot::create().unwrap();
        let outside = super::super::sdk::TemporaryRoot::create().unwrap();
        std::fs::write(outside.0.join("victim"), "outside").unwrap();
        symlink(&outside.0, root.0.join("linked-dir")).unwrap();
        symlink(outside.0.join("victim"), root.0.join("linked-file")).unwrap();
        symlink(outside.0.join("missing"), root.0.join("dangling")).unwrap();
        std::fs::create_dir(root.0.join("directory")).unwrap();
        std::fs::write(root.0.join("large"), vec![b'x'; FILE_LIMIT + 1]).unwrap();
        std::fs::write(root.0.join("invalid"), [0xff]).unwrap();
        for path in [
            "linked-dir/victim",
            "linked-file",
            "dangling",
            "directory",
            "missing/child",
            "large",
            "invalid",
        ] {
            assert!(
                write_file(&root.0, &json!({"path":path,"content":"bad"})).is_err(),
                "{path}"
            );
            assert!(
                write_file(
                    &root.0,
                    &json!({"path":path,"content":"bad","expected_content":"outside"})
                )
                .is_err(),
                "{path}"
            );
        }
        assert_eq!(
            std::fs::read_to_string(outside.0.join("victim")).unwrap(),
            "outside"
        );
        assert!(!outside.0.join("missing").exists());
        assert!(!root.0.join("missing").exists());
    }

    #[cfg(unix)]
    #[test]
    fn replaces_only_workspace_entry_of_a_hardlinked_file() {
        let root = super::super::sdk::TemporaryRoot::create().unwrap();
        let outside = super::super::sdk::TemporaryRoot::create().unwrap();
        let original = outside.0.join("original");
        std::fs::write(&original, "before").unwrap();
        std::fs::hard_link(&original, root.0.join("linked")).unwrap();
        write_file(
            &root.0,
            &json!({"path":"linked","content":"after","expected_content":"before"}),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&original).unwrap(), "before");
        assert_eq!(
            std::fs::read_to_string(root.0.join("linked")).unwrap(),
            "after"
        );
    }
}
