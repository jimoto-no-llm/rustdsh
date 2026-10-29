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
use std::path::{Path, PathBuf};

/// Largest file `rdsh files get` will copy.
const MAX_COPY_BYTES: u64 = 512 * 1024 * 1024;

/// Largest transcript read when a session is zstd-compressed.
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
/// The transcript format belongs to dsh. This reader accepts the two shapes it
/// has used - a `presented` event holding a `files` array - and ignores
/// everything else instead of guessing at unrelated `path` fields.
fn declarations(value: &Value, out: &mut Vec<Deliverable>) {
    match value {
        Value::Object(map) => {
            let presented = map.get("type").and_then(Value::as_str) == Some("presented")
                || map.get("kind").and_then(Value::as_str) == Some("presented");
            if presented {
                if let Some(files) = map.get("files").and_then(Value::as_array) {
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

/// The transcript inside one session directory, if it holds one.
fn session_file_in(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .map(|name| {
                    let name = name.to_string_lossy();
                    name.ends_with(".jsonl") || name.ends_with(".jsonl.zstd")
                })
                .unwrap_or(false)
        })
}

/// The newest transcript one level below a per-cwd folder.
fn session_file_under(dir: &Path) -> Option<PathBuf> {
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for child in std::fs::read_dir(dir).ok()?.flatten() {
        let Some(inner) = session_file_in(&child.path()) else {
            continue;
        };
        let Ok(modified) = inner.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        let is_newer = newest
            .as_ref()
            .map(|(when, _)| modified > *when)
            .unwrap_or(true);
        if is_newer {
            newest = Some((modified, inner));
        }
    }
    newest.map(|(_, file)| file)
}

/// Resolve a session id to its transcript, newest first when `session` is None.
fn transcript_for(session: Option<&str>) -> Result<PathBuf> {
    let root = sessions_root();
    if let Some(id) = session {
        for candidate in [
            root.join(format!("{id}.json")),
            root.join(id).join("session.json"),
        ] {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        bail!("no session {id} under {}", root.display());
    }
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    let entries =
        std::fs::read_dir(&root).with_context(|| format!("cannot read {}", root.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        // dsh keeps one directory per session under a per-cwd folder:
        // sessions/<cwd>/<session-id>/session.v4.jsonl[.zstd].
        let file = if path.is_dir() {
            match session_file_in(&path).or_else(|| session_file_under(&path)) {
                Some(inner) => inner,
                None => continue,
            }
        } else if path.extension().is_some_and(|ext| ext == "json") {
            path
        } else {
            continue;
        };
        let Ok(modified) = file.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        let is_newer = newest
            .as_ref()
            .map(|(when, _)| modified > *when)
            .unwrap_or(true);
        if is_newer {
            newest = Some((modified, file));
        }
    }
    newest
        .map(|(_, file)| file)
        .ok_or_else(|| anyhow::anyhow!("no session transcripts under {}", root.display()))
}

/// The session id a transcript belongs to.
pub(crate) fn session_label(transcript: &Path) -> String {
    transcript
        .parent()
        .and_then(Path::file_name)
        .or_else(|| transcript.file_stem())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| transcript.display().to_string())
}

/// Read every deliverable a session declared; newest transcript by default.
pub(crate) fn deliverables(session: Option<&str>) -> Result<(String, Vec<Deliverable>)> {
    let transcript = transcript_for(session)?;
    let mut found = Vec::new();
    if transcript.extension().is_some_and(|ext| ext == "zstd") {
        // dsh writes the transcript as zstd-compressed JSONL; `rdsh tokens`
        // already decompresses it through the zstd binary.
        let (bytes, _) =
            crate::context::read_zstd_session(&transcript, MAX_TRANSCRIPT_BYTES, usize::MAX, None)
                .with_context(|| format!("cannot read {}", transcript.display()))?;
        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines() {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            declarations(&value, &mut found);
        }
    } else {
        let text = std::fs::read_to_string(&transcript)
            .with_context(|| format!("cannot read {}", transcript.display()))?;
        let value: Value = serde_json::from_str(&text)
            .with_context(|| format!("{} is not JSON", transcript.display()))?;
        declarations(&value, &mut found);
    }
    // Keep the last declaration of a path, like the Web UI does.
    let mut seen = std::collections::HashSet::new();
    found.reverse();
    found.retain(|item| seen.insert(item.path.clone()));
    found.reverse();
    for item in &mut found {
        item.bytes = std::fs::metadata(&item.path).ok().map(|meta| meta.len());
    }
    Ok((session_label(&transcript), found))
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
    let resolved = if force {
        std::fs::canonicalize(&source)
            .with_context(|| format!("cannot read {}", source.display()))?
    } else {
        let (_, declared) = deliverables(session)?;
        checked_source(&source, &declared)?
    };
    let destination = match out {
        Some(out) => PathBuf::from(out),
        None => std::env::current_dir()?.join(download_name(&resolved)),
    };
    if destination.exists() && destination != resolved {
        bail!(
            "{} already exists; pass --out with another name",
            destination.display()
        );
    }
    std::fs::copy(&resolved, &destination).with_context(|| {
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
    if !out.is_some() {
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
