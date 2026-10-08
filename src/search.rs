// Native recursive grep: skips hidden/vendor dirs, caps output.
// Two phases: sequential walk (fixed order) then parallel grep over files.
// Stdout matches a sequential scan: per-file hits merge in walk order.

pub fn cmd_search(pattern: &str, dir: &str, max: usize) -> anyhow::Result<()> {
    anyhow::ensure!(
        cfg!(unix),
        "RDSH_SECURITY: secure native search is unavailable on this platform"
    );
    let root = std::fs::canonicalize(dir)?;
    let files = collect_parallel(&root);
    let nfiles = files.len();
    let per_file: Vec<Vec<String>> = if nfiles >= 32 {
        grep_parallel(pattern, &files, &root)
    } else {
        files.iter().map(|p| grep_one(pattern, p, &root)).collect()
    };
    // One locked, buffered stdout for the whole dump (same bytes out).
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    let mut shown = 0usize;
    let mut outer_done = false;
    for (path, fh) in files.iter().zip(&per_file) {
        if outer_done {
            break;
        }
        let prefix = format!("{}:", path.display());
        let display_path = std::path::Path::new(dir).join(path.strip_prefix(&root)?);
        for line in fh {
            if shown >= max {
                outer_done = true;
                break;
            }
            if let Some(hit) = line.strip_prefix(&prefix) {
                let _ = writeln!(out, "{}:{hit}", display_path.display());
            }
            shown += 1;
        }
    }
    let _ = out.flush();
    eprintln!("[rdsh] {shown} hit(s) in {nfiles} file(s)");
    Ok(())
}
const SKIP: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "dist",
    "build",
    ".next",
];

fn collect_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.filter_map(Result::ok) {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        match entry_kind(&e, &p, &name) {
            EntryKind::Dir => collect_files(&p, out),
            EntryKind::File => out.push(p),
            EntryKind::Skip => {}
        }
    }
}

#[derive(PartialEq)]
enum EntryKind {
    Dir,
    File,
    Skip,
}

/// Classify without stat in the common case (dirent type is free).
/// Skip symlinks and unknown types to keep repository traversal local.
fn entry_kind(e: &std::fs::DirEntry, _p: &std::path::Path, name: &str) -> EntryKind {
    match e.file_type() {
        Ok(t) if t.is_dir() => {
            if SKIP.contains(&name) || name.starts_with('.') {
                EntryKind::Skip
            } else {
                EntryKind::Dir
            }
        }
        Ok(t) if t.is_file() => EntryKind::File,
        // Repository-controlled links must not disclose files outside the search root
        // or recurse through cycles. Unknown types also fail closed.
        _ => EntryKind::Skip,
    }
}

/// Walk subdirectories in parallel while preserving exact sequential order:
/// root entries keep their listing order and each subtree is joined in place.
/// Falls back to the plain sequential walk for narrow trees.
fn collect_parallel(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let entries: Vec<std::fs::DirEntry> = match std::fs::read_dir(dir) {
        Ok(e) => e.filter_map(Result::ok).collect(),
        Err(_) => return vec![],
    };
    let mut subdirs = vec![];
    for e in &entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if entry_kind(e, &e.path(), &name) == EntryKind::Dir {
            subdirs.push(e.path());
        }
    }
    if subdirs.len() < 2 {
        let mut out = vec![];
        collect_files(dir, &mut out);
        return out;
    }
    enum Seg {
        Files(Vec<std::path::PathBuf>),
        Sub(std::path::PathBuf),
    }
    let mut segs: Vec<Seg> = vec![];
    let mut pending: Vec<std::path::PathBuf> = vec![];
    for e in &entries {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        match entry_kind(e, &p, &name) {
            EntryKind::Dir => {
                if !pending.is_empty() {
                    segs.push(Seg::Files(std::mem::take(&mut pending)));
                }
                segs.push(Seg::Sub(p));
            }
            EntryKind::File => pending.push(p),
            EntryKind::Skip => {}
        }
    }
    if !pending.is_empty() {
        segs.push(Seg::Files(pending));
    }
    let sub_idx: Vec<usize> = segs
        .iter()
        .enumerate()
        .filter(|(_, s)| matches!(s, Seg::Sub(_)))
        .map(|(i, _)| i)
        .collect();
    let mut resolved: Vec<Vec<std::path::PathBuf>> = vec![];
    resolved.resize_with(sub_idx.len(), Vec::new);
    let width = crate::inspect::parallelism().max(1);
    for (batch_no, batch) in sub_idx.chunks(width).enumerate() {
        std::thread::scope(|s| {
            let mut handles = vec![];
            for (k, seg_i) in batch.iter().enumerate() {
                if let Seg::Sub(p) = &segs[*seg_i] {
                    // slot in `resolved` = global index into sub_idx.
                    let pos = batch_no * width + k;
                    handles.push((
                        pos,
                        s.spawn(move || {
                            let mut v = vec![];
                            collect_files(p, &mut v);
                            v
                        }),
                    ));
                }
            }
            for (pos, h) in handles {
                resolved[pos] = h.join().unwrap_or_default();
            }
        });
    }
    let mut files = vec![];
    let mut ri = 0;
    for seg in segs {
        match seg {
            Seg::Files(v) => files.extend(v),
            Seg::Sub(_) => {
                files.extend(std::mem::take(&mut resolved[ri]));
                ri += 1;
            }
        }
    }
    files
}

/// Read at most 2MB+1 bytes as UTF-8. Returns None for missing files,
/// files over 2MB, and non-UTF-8 content — the same skip set as the old
/// metadata-check plus read_to_string combination (verified by diff).
fn read_capped(path: &std::path::Path, root: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let f = crate::file_security::open_beneath(root, path)?;
    // One fstat on the open fd (no path lookup): skip oversized files
    // without reading, and pre-size the buffer to avoid regrowth.
    // Same skip set as the old metadata-check combination (verified by diff).
    let len = f.metadata().ok()?.len();
    if len > 2_000_000 {
        return None;
    }
    let mut buf = Vec::with_capacity(len as usize);
    f.take(2_000_001).read_to_end(&mut buf).ok()?;
    if buf.len() > 2_000_000 {
        return None;
    }
    String::from_utf8(buf).ok()
}

fn grep_one(pattern: &str, path: &std::path::Path, root: &std::path::Path) -> Vec<String> {
    let mut hits = vec![];
    if let Some(text) = read_capped(path, root) {
        for (i, line) in text.lines().enumerate() {
            if line.contains(pattern) {
                hits.push(format!(
                    "{}:{}: {}",
                    path.display(),
                    i + 1,
                    truncate(line, 240)
                ));
            }
        }
    }
    hits
}

fn grep_parallel(
    pattern: &str,
    files: &[std::path::PathBuf],
    root: &std::path::Path,
) -> Vec<Vec<String>> {
    let threads = crate::inspect::parallelism();
    if threads <= 1 {
        return files.iter().map(|p| grep_one(pattern, p, root)).collect();
    }
    let chunk = files.len().div_ceil(threads);
    let mut out: Vec<Vec<Vec<String>>> = vec![];
    std::thread::scope(|s| {
        let mut handles = vec![];
        for c in files.chunks(chunk) {
            handles.push(s.spawn(move || {
                c.iter()
                    .map(|p| grep_one(pattern, p, root))
                    .collect::<Vec<_>>()
            }));
        }
        for h in handles {
            out.push(h.join().unwrap_or_default());
        }
    });
    out.into_iter().flatten().collect()
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    let mut t: String = s.chars().take(n).collect();
    t.push('>');
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_cap() {
        // Issue #85-4: walker/grep threads follow cores, clamped 1..=8.
        assert!((1..=8).contains(&crate::inspect::parallelism()));
    }

    #[cfg(unix)]
    #[test]
    fn recursive_search_does_not_follow_repository_symlinks() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "rdsh-search-{}",
            crate::local_http::random_token().unwrap()
        ));
        let repo = root.join("repo");
        let outside = root.join("outside");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("credentials.json"), "DUMMY_SECRET").unwrap();
        std::fs::write(repo.join("README.md"), "safe").unwrap();
        symlink(&outside, repo.join("linked-dir")).unwrap();
        symlink(outside.join("credentials.json"), repo.join("linked.json")).unwrap();
        let files = collect_parallel(&repo);
        assert_eq!(files, vec![repo.join("README.md")]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn search_rejects_files_replaced_after_collection() {
        let temporary = std::env::temp_dir().join(format!(
            "rdsh-search-swap-{}",
            crate::local_http::random_token().unwrap()
        ));
        let project = temporary.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let root = std::fs::canonicalize(&project).unwrap();
        let slot = root.join("slot.txt");
        let outside = temporary.join("secret.txt");
        std::fs::write(&slot, "safe").unwrap();
        std::fs::write(&outside, "DUMMY_SEARCH_SECRET").unwrap();
        let collected = collect_parallel(&root);
        assert_eq!(collected, vec![slot.clone()]);
        std::fs::remove_file(&slot).unwrap();
        std::os::unix::fs::symlink(&outside, &slot).unwrap();
        assert!(grep_one("DUMMY_SEARCH_SECRET", &collected[0], &root).is_empty());
        std::fs::remove_file(&slot).unwrap();
        std::fs::hard_link(&outside, &slot).unwrap();
        assert!(grep_parallel("DUMMY_SEARCH_SECRET", &collected, &root)
            .into_iter()
            .flatten()
            .next()
            .is_none());
        std::fs::remove_dir_all(temporary).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn capped_boundary() {
        let dir = std::env::temp_dir().join(format!(
            "rdsh-search-cap-{}",
            crate::local_http::random_token().unwrap()
        ));
        std::fs::create_dir(&dir).unwrap();
        let dir = std::fs::canonicalize(dir).unwrap();
        let exact = dir.join("rdsh-cap-exact.txt");
        let over = dir.join("rdsh-cap-over.txt");
        let bin = dir.join("rdsh-cap-bin.bin");
        std::fs::write(&exact, vec![120u8; 2_000_000]).unwrap();
        let mut big = vec![120u8; 2_000_001];
        big.push(121);
        std::fs::write(&over, big).unwrap();
        std::fs::write(&bin, [0u8, 159, 146, 150]).unwrap();
        assert!(read_capped(&exact, &dir).is_some());
        assert!(read_capped(&over, &dir).is_none());
        assert!(read_capped(&bin, &dir).is_none());
        assert!(read_capped(&dir.join("rdsh-cap-missing.txt"), &dir).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
