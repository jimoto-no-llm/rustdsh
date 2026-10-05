// Native recursive grep: std-only, skips hidden/vendor dirs, caps output.
// Two phases: sequential walk (fixed order) then parallel grep over files.
// Stdout matches a sequential scan: per-file hits merge in walk order.

pub fn cmd_search(pattern: &str, dir: &str, max: usize) -> anyhow::Result<()> {
    let files = collect_parallel(std::path::Path::new(dir));
    let nfiles = files.len();
    let per_file: Vec<Vec<String>> = if nfiles >= 32 {
        grep_parallel(pattern, &files)
    } else {
        files.iter().map(|p| grep_one(pattern, p)).collect()
    };
    // One locked, buffered stdout for the whole dump (same bytes out).
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    let mut shown = 0usize;
    let mut outer_done = false;
    for fh in &per_file {
        if outer_done {
            break;
        }
        for line in fh {
            if shown >= max {
                outer_done = true;
                break;
            }
            let _ = writeln!(out, "{line}");
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
    for e in entries.filter_map(|e| e.ok()) {
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
/// Symlinks and unknown types fall back to stat, matching the old
/// follow-links behavior exactly.
fn entry_kind(e: &std::fs::DirEntry, p: &std::path::Path, name: &str) -> EntryKind {
    match e.file_type() {
        Ok(t) if t.is_dir() => {
            if SKIP.contains(&name) || name.starts_with(".") {
                EntryKind::Skip
            } else {
                EntryKind::Dir
            }
        }
        Ok(t) if t.is_file() => EntryKind::File,
        _ => {
            if p.is_dir() {
                if SKIP.contains(&name) || name.starts_with(".") {
                    EntryKind::Skip
                } else {
                    EntryKind::Dir
                }
            } else if p.is_file() {
                EntryKind::File
            } else {
                EntryKind::Skip
            }
        }
    }
}

/// Walk subdirectories in parallel while preserving exact sequential order:
/// root entries keep their listing order and each subtree is joined in place.
/// Falls back to the plain sequential walk for narrow trees.
fn collect_parallel(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let entries: Vec<std::fs::DirEntry> = match std::fs::read_dir(dir) {
        Ok(e) => e.filter_map(|e| e.ok()).collect(),
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
fn read_capped(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let f = std::fs::File::open(path).ok()?;
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

fn grep_one(pattern: &str, path: &std::path::Path) -> Vec<String> {
    let mut hits = vec![];
    if let Some(text) = read_capped(path) {
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

fn grep_parallel(pattern: &str, files: &[std::path::PathBuf]) -> Vec<Vec<String>> {
    let threads = crate::inspect::parallelism();
    if threads <= 1 {
        return files.iter().map(|p| grep_one(pattern, p)).collect();
    }
    let chunk = files.len().div_ceil(threads);
    let mut out: Vec<Vec<Vec<String>>> = vec![];
    std::thread::scope(|s| {
        let mut handles = vec![];
        for c in files.chunks(chunk) {
            handles
                .push(s.spawn(move || c.iter().map(|p| grep_one(pattern, p)).collect::<Vec<_>>()));
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
    t.push(gt_sign());
    t
}

fn gt_sign() -> char {
    62 as char
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_cap() {
        // Issue #85-4: walker/grep threads follow cores, clamped 1..=8.
        assert!((1..=8).contains(&crate::inspect::parallelism()));
    }

    #[test]
    fn capped_boundary() {
        let dir = std::env::temp_dir();
        let exact = dir.join("rdsh-cap-exact.txt");
        let over = dir.join("rdsh-cap-over.txt");
        let bin = dir.join("rdsh-cap-bin.bin");
        std::fs::write(&exact, vec![120u8; 2_000_000]).unwrap();
        let mut big = vec![120u8; 2_000_001];
        big.push(121);
        std::fs::write(&over, big).unwrap();
        std::fs::write(&bin, [0u8, 159, 146, 150]).unwrap();
        assert!(read_capped(&exact).is_some());
        assert!(read_capped(&over).is_none());
        assert!(read_capped(&bin).is_none());
        assert!(read_capped(&dir.join("rdsh-cap-missing.txt")).is_none());
        let _ = std::fs::remove_file(&exact);
        let _ = std::fs::remove_file(&over);
        let _ = std::fs::remove_file(&bin);
    }
}
