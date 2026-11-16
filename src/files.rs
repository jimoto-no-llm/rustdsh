//! `rdsh files`: find and hand out the files a session produced.
//!
//! The harness (dsh) does not copy deliverables: `present` records the path of
//! an existing file, and the Web UI opens it in the default application on the
//! machine that owns it. A person reading the Web UI from another machine has
//! no way to fetch the file, and the save location is not shown anywhere. This
//! module answers both: it lists the files the Session declared, and hands one
//! of them out so a browser can save a copy.
//!
//! Every read is confined to files the Session itself declared; nothing else
//! under the workspace is reachable.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Largest file `rdsh files get` will copy.
const MAX_COPY_BYTES: u64 = 512 * 1024 * 1024;

/// Largest decoded transcript.
const MAX_TRANSCRIPT_BYTES: usize = 256 * 1024 * 1024;

/// One file a Session declared as a deliverable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Deliverable {
    pub path: PathBuf,
    pub description: Option<String>,
    /// Size in bytes, when the file could be read.
    pub bytes: Option<u64>,
}

/// Where the session transcripts live for this DSH home.
fn sessions_root() -> PathBuf {
    PathBuf::from(crate::inspect::dsh_home()).join("sessions")
}

/// Pull the `present` declarations out of one transcript value.
///
/// DSH stores `deliverables/presented` payloads in `data`.
/// The existing `presented` JSON forms remain supported.
fn declarations(value: &Value, out: &mut Vec<Deliverable>) {
    match value {
        Value::Object(map) => {
            let payload =
                if map.get("type").and_then(Value::as_str) == Some("deliverables/presented") {
                    map.get("data").and_then(Value::as_object)
                } else if map.get("type").and_then(Value::as_str) == Some("presented")
                    || map.get("kind").and_then(Value::as_str) == Some("presented")
                {
                    Some(map)
                } else {
                    None
                };
            if let Some(payload) = payload {
                if let Some(files) = payload.get("files").and_then(Value::as_array) {
                    for file in files {
                        let Some(path) = file.get("path").and_then(Value::as_str) else {
                            continue;
                        };
                        if path.trim().is_empty() {
                            continue;
                        }
                        out.push(Deliverable {
                            path: PathBuf::from(path),
                            description: file
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            bytes: None,
                        });
                    }
                }
                return;
            }
            if map
                .get("type")
                .or_else(|| map.get("kind"))
                .and_then(Value::as_str)
                .is_some_and(|kind| kind != "session")
            {
                return;
            }
            for child in map.values() {
                declarations(child, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                declarations(item, out);
            }
        }
        _ => {}
    }
}

fn newest_transcript(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths
        .into_iter()
        .filter_map(|path| {
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some((metadata.modified().ok()?, path))
        })
        .max()
        .map(|(_, path)| path)
}

fn session_file_in(dir: &Path) -> Option<PathBuf> {
    if !std::fs::symlink_metadata(dir).ok()?.is_dir() {
        return None;
    }
    newest_transcript(std::fs::read_dir(dir).ok()?.flatten().filter_map(|entry| {
        let name = entry.file_name();
        let name = name.to_str()?;
        (name == "session.json" || name.ends_with(".jsonl") || name.ends_with(".jsonl.zstd"))
            .then(|| entry.path())
    }))
}

fn session_directory_name(id: &str) -> String {
    // DSH's encodeSegment escapes UTF-16 units as ~XXXX.
    let mut encoded = String::new();
    for unit in id.encode_utf16() {
        if unit <= 127
            && ((unit as u8).is_ascii_alphanumeric() || b"._-".contains(&(unit as u8)))
            && id != "."
            && id != ".."
        {
            encoded.push(unit as u8 as char);
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "~{unit:04X}");
        }
    }
    encoded
}

/// Resolve a session id to its transcript, newest first when `session` is None.
fn transcript_for(root: &Path, session: Option<&str>) -> Result<PathBuf> {
    if session == Some("") {
        bail!("session id must not be empty");
    }
    let encoded = session.map(session_directory_name);
    let mut candidates = Vec::new();
    let entries =
        std::fs::read_dir(root).with_context(|| format!("cannot read {}", root.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            if session.is_none_or(|id| path.file_name().is_some_and(|name| name == id))
                || encoded
                    .as_deref()
                    .is_some_and(|id| path.file_name().is_some_and(|name| name == id))
            {
                candidates.extend(session_file_in(&path));
            }
            if let Some(id) = &encoded {
                candidates.extend(session_file_in(&path.join(id)));
            } else if let Ok(children) = std::fs::read_dir(&path) {
                candidates.extend(
                    children
                        .flatten()
                        .filter_map(|child| session_file_in(&child.path())),
                );
            }
        } else if path.extension().is_some_and(|ext| ext == "json")
            && session.is_none_or(|id| path.file_stem().is_some_and(|name| name == id))
        {
            candidates.push(path);
        }
    }
    newest_transcript(candidates).ok_or_else(|| match session {
        Some(id) => anyhow::anyhow!("no session {id} under {}", root.display()),
        None => anyhow::anyhow!("no session transcripts under {}", root.display()),
    })
}

/// The session id a transcript belongs to.
pub(crate) fn session_label(transcript: &Path) -> String {
    let name = if transcript.extension().is_some_and(|ext| ext == "json")
        && transcript
            .file_name()
            .is_some_and(|name| name != "session.json")
    {
        transcript.file_stem()
    } else {
        transcript.parent().and_then(Path::file_name)
    };
    name.or_else(|| transcript.file_stem())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| transcript.display().to_string())
}

fn read_transcript(root: &Path, transcript: &Path) -> Result<Vec<u8>> {
    let file = crate::file_security::open_beneath(root, transcript)
        .with_context(|| format!("cannot read {}", transcript.display()))?;
    if transcript.extension().is_some_and(|ext| ext == "zstd") {
        let (bytes, limited) = crate::context::read_zstd_session_from_file(
            transcript,
            file,
            MAX_TRANSCRIPT_BYTES + 1,
            usize::MAX,
            None,
        )
        .with_context(|| format!("cannot read {}", transcript.display()))?;
        if limited || bytes.len() > MAX_TRANSCRIPT_BYTES {
            bail!("{} exceeds the transcript byte limit", transcript.display());
        }
        Ok(bytes)
    } else {
        if file.metadata()?.len() > MAX_TRANSCRIPT_BYTES as u64 {
            bail!("{} exceeds the transcript byte limit", transcript.display());
        }
        let mut bytes = Vec::new();
        file.take(MAX_TRANSCRIPT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_TRANSCRIPT_BYTES {
            bail!("{} exceeds the transcript byte limit", transcript.display());
        }
        Ok(bytes)
    }
}

/// Read every deliverable a session declared; newest transcript by default.
pub(crate) fn deliverables(session: Option<&str>) -> Result<(String, Vec<Deliverable>)> {
    let root = sessions_root();
    let root =
        std::fs::canonicalize(&root).with_context(|| format!("cannot read {}", root.display()))?;
    let transcript = transcript_for(&root, session)?;
    let bytes = read_transcript(&root, &transcript)?;
    let text = std::str::from_utf8(&bytes)
        .with_context(|| format!("{} is not UTF-8", transcript.display()))?;
    let mut found = Vec::new();
    let mut header = Value::Null;
    if transcript.extension().is_some_and(|ext| ext != "json") {
        for (index, line) in text.split_inclusive('\n').enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let value = match serde_json::from_str::<Value>(line) {
                Ok(value) => value,
                Err(error) if error.is_eof() && !line.ends_with('\n') => break,
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("{}:{} is not JSON", transcript.display(), index + 1)
                    });
                }
            };
            let kind = value
                .get("type")
                .or_else(|| value.get("kind"))
                .and_then(Value::as_str);
            match kind {
                Some("session") if index == 0 => header = value,
                Some("deliverables/presented" | "presented") => declarations(&value, &mut found),
                _ => {}
            }
        }
    } else {
        let value: Value = serde_json::from_str(text)
            .with_context(|| format!("{} is not JSON", transcript.display()))?;
        header = value.get("header").cloned().unwrap_or(Value::Null);
        declarations(&value, &mut found);
    }
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .map(Path::new)
        .filter(|path| path.is_absolute());
    for item in &mut found {
        if item.path.is_relative() {
            item.path = cwd
                .context("relative deliverable has no absolute session working directory")?
                .join(&item.path);
        }
    }
    // Keep the last declaration of a path, like the Web UI does.
    let mut seen = std::collections::HashSet::new();
    found.reverse();
    found.retain(|item| seen.insert(item.path.clone()));
    found.reverse();
    for item in &mut found {
        item.bytes = std::fs::metadata(&item.path)
            .ok()
            .filter(|meta| meta.is_file())
            .map(|meta| meta.len());
    }
    let label = header
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| session_label(&transcript));
    Ok((label, found))
}

/// A byte count people can read.
pub(crate) fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// `rdsh files list [--session <id>] [--json]`
pub(crate) fn cmd_list(
    session: Option<&str>,
    json_out: bool,
    locale: crate::locale::Locale,
) -> Result<()> {
    let (label, files) = deliverables(session)?;
    if json_out {
        let body = json!({
            "session": label,
            "files": files.iter().map(|item| json!({
                "path": item.path,
                "description": item.description,
                "bytes": item.bytes,
                "exists": item.bytes.is_some(),
            })).collect::<Vec<_>>(),
        });
        println!("{}", serde_json::to_string_pretty(&body)?);
        return Ok(());
    }
    use std::io::Write as _;
    let mut out = std::io::stdout().lock();
    if files.is_empty() {
        let _ = writeln!(
            out,
            "[rdsh] {}",
            match locale {
                crate::locale::Locale::English => format!("session {label} declared no files"),
                crate::locale::Locale::Chinese => format!("会话 {label} 没有声明文件"),
                crate::locale::Locale::Japanese => {
                    format!("セッション {label} はファイルを宣言していません")
                }
            }
        );
        return Ok(());
    }
    let _ = writeln!(
        out,
        "[rdsh] {}: {label}",
        match locale {
            crate::locale::Locale::English => "files declared by session",
            crate::locale::Locale::Chinese => "会话声明的文件",
            crate::locale::Locale::Japanese => "セッションが宣言したファイル",
        }
    );
    for item in &files {
        let size = match item.bytes {
            Some(bytes) => human_size(bytes),
            None => match locale {
                crate::locale::Locale::English => "missing".to_string(),
                crate::locale::Locale::Chinese => "缺失".to_string(),
                crate::locale::Locale::Japanese => "見つかりません".to_string(),
            },
        };
        let _ = writeln!(out, "  {}  ({size})", item.path.display());
        if let Some(description) = &item.description {
            let _ = writeln!(out, "    {description}");
        }
        let _ = writeln!(
            out,
            "    {}: rdsh files get \"{}\"",
            match locale {
                crate::locale::Locale::English => "save a copy",
                crate::locale::Locale::Chinese => "保存副本",
                crate::locale::Locale::Japanese => "コピーを保存",
            },
            item.path.display()
        );
    }
    Ok(())
}

/// Refuse a read of a file this session never declared.
pub(crate) fn checked_source(path: &Path, declared: &[Deliverable]) -> Result<PathBuf> {
    let canonical =
        std::fs::canonicalize(path).with_context(|| format!("cannot read {}", path.display()))?;
    let allowed = declared
        .iter()
        .any(|item| std::fs::canonicalize(&item.path).is_ok_and(|known| known == canonical));
    if !allowed {
        bail!(
            "{} is not a file this session declared (rdsh files list shows them)",
            path.display()
        );
    }
    let metadata = std::fs::metadata(&canonical)?;
    if !metadata.is_file() {
        bail!("{} is not a regular file", canonical.display());
    }
    if metadata.len() > MAX_COPY_BYTES {
        bail!(
            "{} is {} bytes, larger than the {} byte limit",
            canonical.display(),
            metadata.len(),
            MAX_COPY_BYTES
        );
    }
    Ok(canonical)
}

pub(crate) fn open_source(
    path: &Path,
    declared: &[Deliverable],
) -> Result<(PathBuf, std::fs::File, u64)> {
    let canonical = checked_source(path, declared)?;
    let parent = canonical
        .parent()
        .context("deliverable has no parent directory")?;
    let file = crate::file_security::open_declared_file(parent, &canonical)
        .with_context(|| format!("cannot read {}", canonical.display()))?;
    let length = file.metadata()?.len();
    if length > MAX_COPY_BYTES {
        bail!("{} exceeds the copy byte limit", canonical.display());
    }
    Ok((canonical, file, length))
}

/// `rdsh files get <path> [--out <file>] [--session <id>]`
///
/// Copies one declared deliverable to `--out` (stdout by default is not used
/// for binary files, so the working directory is the safe default).
pub(crate) fn cmd_get(
    path: &str,
    out: Option<&str>,
    session: Option<&str>,
    force: bool,
    locale: crate::locale::Locale,
) -> Result<()> {
    let source = PathBuf::from(path);
    let (resolved, source) = if force {
        let canonical = std::fs::canonicalize(&source)
            .with_context(|| format!("cannot read {}", source.display()))?;
        let mut options = std::fs::File::options();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
        }
        let file = options.open(&canonical)?;
        (canonical, file)
    } else {
        let (_, declared) = deliverables(session)?;
        let (canonical, file, _) = open_source(&source, &declared)?;
        (canonical, file)
    };
    let destination = match out {
        Some(out) => PathBuf::from(out),
        None => std::env::current_dir()?.join(download_name(&resolved)),
    };
    let metadata = source.metadata()?;
    if !metadata.is_file() {
        bail!("{} is not a regular file", resolved.display());
    }
    let mut options = std::fs::File::options();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut target = options.open(&destination).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            anyhow::anyhow!(
                "{} already exists; pass --out with another name",
                destination.display()
            )
        } else {
            anyhow::Error::new(error).context(format!("cannot create {}", destination.display()))
        }
    })?;
    let result = (|| -> Result<()> {
        let limit = if force { u64::MAX } else { MAX_COPY_BYTES + 1 };
        let copied = std::io::copy(&mut source.take(limit), &mut target)?;
        if !force && copied > MAX_COPY_BYTES {
            bail!("{} exceeds the copy byte limit", resolved.display());
        }
        target.set_permissions(metadata.permissions())?;
        Ok(())
    })();
    drop(target);
    if result.is_err() {
        let _ = std::fs::remove_file(&destination);
    }
    result.with_context(|| {
        format!(
            "cannot copy {} to {}",
            resolved.display(),
            destination.display()
        )
    })?;
    use std::io::Write as _;
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(
        stdout,
        "[rdsh] {}: {}",
        match locale {
            crate::locale::Locale::English => "saved",
            crate::locale::Locale::Chinese => "已保存",
            crate::locale::Locale::Japanese => "保存しました",
        },
        destination.display()
    );
    if out.is_none() {
        let _ = writeln!(
            stdout,
            "[rdsh] {}",
            match locale {
                crate::locale::Locale::English => {
                    "the file is in the current directory; open it with your file manager"
                }
                crate::locale::Locale::Chinese => "文件已在当前目录；请用文件管理器打开",
                crate::locale::Locale::Japanese => {
                    "ファイルは現在のディレクトリにあります。ファイラーで開いてください"
                }
            }
        );
    }
    Ok(())
}

/// The name a browser should save the file as.
pub(crate) fn download_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string())
}

/// A content type good enough for a browser to open the saved copy.
#[allow(dead_code)] // the Web route uses it once the form is wired
pub(crate) fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("csv") => "text/csv; charset=utf-8",
        Some("md" | "txt" | "log" | "rust" | "toml" | "yml" | "yaml") => {
            "text/plain; charset=utf-8"
        }
        Some("html" | "htm") => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rdsh-files-test-{}",
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn declarations_finds_presented_events_and_nothing_else() {
        let event = json!({
            "type": "presented",
            "files": [{"path": "/tmp/a.png", "description": "chart"}],
        });
        let mut found = Vec::new();
        declarations(&event, &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, PathBuf::from("/tmp/a.png"));
        assert_eq!(found[0].description.as_deref(), Some("chart"));

        let nested = json!({
            "messages": [{"content": [{"kind": "presented", "files": [{"path": "/tmp/b.csv"}]}]}],
        });
        let mut found = Vec::new();
        declarations(&nested, &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, PathBuf::from("/tmp/b.csv"));
    }

    #[test]
    fn declarations_ignores_unrelated_path_arrays() {
        let changes = json!({"changes": [{"path": "src/main.rs"}, {"path": "README.md"}]});
        let mut found = Vec::new();
        declarations(&changes, &mut found);
        assert!(found.is_empty());

        let result = json!({
            "type": "tool/result",
            "data": {"type": "presented", "files": [{"path": "/tmp/secret"}]},
        });
        declarations(&result, &mut found);
        assert!(found.is_empty());
    }

    #[test]
    fn checked_source_refuses_files_the_session_did_not_declare() {
        let dir = temp_dir();
        let declared = dir.join("out.txt");
        let other = dir.join("secret.txt");
        std::fs::write(&declared, b"ok").unwrap();
        std::fs::write(&other, b"no").unwrap();
        let list = vec![Deliverable {
            path: declared.clone(),
            description: None,
            bytes: None,
        }];
        assert!(checked_source(&declared, &list).is_ok());
        let error = checked_source(&other, &list).unwrap_err();
        assert!(error
            .to_string()
            .contains("not a file this session declared"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn content_type_and_name_follow_the_extension() {
        assert_eq!(content_type(Path::new("/tmp/a.png")), "image/png");
        assert_eq!(
            content_type(Path::new("/tmp/a.CSV")),
            "text/csv; charset=utf-8"
        );
        assert_eq!(
            content_type(Path::new("/tmp/a.bin")),
            "application/octet-stream"
        );
        assert_eq!(download_name(Path::new("/tmp/report.pdf")), "report.pdf");
        assert_eq!(human_size(900), "900 B");
        assert_eq!(human_size(2048), "2.0 KB");
    }
}
