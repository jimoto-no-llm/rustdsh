//! Read-only inspection of $DSH_HOME without Node: sessions, logs, skills, profiles.
//! Never writes; missing dirs are reported, not errors (exit 0 with a note).

/// User home directory without a dirs/home crate: HOME, USERPROFILE, then
/// HOMEDRIVE+HOMEPATH (native Windows). One resolver for the whole binary so
/// no call site drifts back to a HOME-only fallback (which yields "./" on
/// Windows and diverges from every other feature).
pub fn home_dir() -> Option<String> {
    for k in ["HOME", "USERPROFILE"] {
        if let Ok(h) = std::env::var(k) {
            if !h.is_empty() {
                return Some(h);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        match (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
            (Ok(d), Ok(p)) if !d.is_empty() && !p.is_empty() => return Some(format!("{d}{p}")),
            _ => {}
        }
    }
    None
}

pub fn dsh_home() -> String {
    std::env::var("DSH_HOME").unwrap_or_else(|_| {
        let h = home_dir().unwrap_or_else(|| ".".to_string());
        format!("{h}/.dsh")
    })
}

// Civil date from epoch secs (Howard Hinnant algorithm), UTC. No chrono needed.
fn format_time(t: std::time::SystemTime) -> String {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86400);
    let tod = secs.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}",
        tod / 3600,
        (tod % 3600) / 60
    )
}

fn human_bytes(n: u64) -> String {
    const U: &[&str] = &["B", "KB", "MB", "GB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u + 1 < U.len() {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n}{}", U[u])
    } else {
        format!("{v:.1}{}", U[u])
    }
}

pub fn cmd_profiles() -> anyhow::Result<()> {
    list_dir(&format!("{}/profiles", dsh_home()), "profile")
}

pub fn cmd_skills() -> anyhow::Result<()> {
    list_dir(&format!("{}/skills", dsh_home()), "skill")
}

fn list_dir(dir: &str, kind: &str) -> anyhow::Result<()> {
    if std::fs::read_dir(dir).is_err() {
        println!("# no {kind} dir at {dir}");
        return Ok(());
    }
    let names = dir_names(dir);
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    for n in &names {
        let _ = writeln!(out, "{n}");
    }
    let _ = out.flush();
    eprintln!("[rdsh] {} {kind}(s)", names.len());
    Ok(())
}

struct Session {
    project: String,
    id: String,
    bytes: u64,
    mtime: u64,
    mtime_s: String,
}

/// All sessions under `root` (or one project), newest first. Shared by the
/// CLI table and the serve JSON view so the walk/stats live in one place.
/// Missing root yields an empty vec.
fn scan_sessions(root: &str, project: Option<&str>) -> Vec<Session> {
    let projs: Vec<String> = match project {
        Some(p) => vec![p.to_string()],
        None => match std::fs::read_dir(root) {
            Ok(e) => e
                .filter_map(|e| e.ok())
                .filter(|e| e.metadata().is_ok_and(|m| m.is_dir()))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
            Err(_) => return vec![],
        },
    };
    let mut out: Vec<Session> = vec![];
    if projs.len() >= 2 {
        // Bounded worker pool (issue #85-3): one batch at a time so a host
        // with hundreds of projects never spawns hundreds of threads.
        for batch in projs.chunks(parallelism()) {
            std::thread::scope(|s| {
                let mut handles = vec![];
                for proj in batch {
                    let pdir = std::path::Path::new(&root).join(proj);
                    let proj = proj.clone();
                    handles.push(s.spawn(move || scan_project(&pdir, &proj)));
                }
                for h in handles {
                    out.extend(h.join().unwrap_or_default());
                }
            });
        }
    } else {
        for proj in &projs {
            let pdir = std::path::Path::new(&root).join(proj);
            out.extend(scan_project(&pdir, proj));
        }
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.mtime));
    out
}

pub fn cmd_sessions(project: Option<String>, limit: usize, tokens: bool) -> anyhow::Result<()> {
    let root = format!("{}/sessions", dsh_home());
    if project.is_none() && std::fs::read_dir(&root).is_err() {
        println!("# no sessions dir at {root}");
        return Ok(());
    }
    let out = scan_sessions(&root, project.as_deref());
    let total = out.len();
    // Frame headers give exact sizes with std only (no subprocess); the CLI
    // is probed only when tokens are requested, and only used as a fallback
    // for frames that omit their content size.
    let zstd_cli = tokens && zstd_available();
    let shown: Vec<&Session> = out.iter().take(limit).collect();
    // NOTE: decompressed sizes feed only the tokens column (tokens set).
    // Otherwise the result is ignored, so skip all size work entirely.
    let sizes: Vec<Option<u64>> = if tokens {
        if shown.len() >= 2 {
            batch_decompressed(&root, &shown, zstd_cli)
        } else {
            shown
                .iter()
                .map(|s| session_decompressed_bytes(&root, &s.project, &s.id, zstd_cli))
                .collect()
        }
    } else {
        vec![None; shown.len()]
    };
    if tokens && !zstd_cli && sizes.iter().any(|s| s.is_none()) {
        eprintln!("[rdsh] note: zstd CLI not found; `?` rows show stored-bytes/4 estimate");
    }
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    for (s, decomp) in shown.iter().zip(sizes.iter()) {
        let tok = if tokens {
            match decomp {
                Some(b) => format!("~{}tok", b / 4),
                None => format!("~{}tok?", s.bytes / 4),
            }
        } else {
            "-".to_string()
        };
        let _ = writeln!(
            out,
            "{:>8} {:>10} {} {}/{}",
            human_bytes(s.bytes),
            tok,
            s.mtime_s,
            s.project,
            s.id
        );
    }
    let _ = out.flush();
    eprintln!("[rdsh] {total} session(s), showing up to {limit}");
    Ok(())
}

fn scan_project(pdir: &std::path::Path, proj: &str) -> Vec<Session> {
    let mut v = vec![];
    let entries = match std::fs::read_dir(pdir) {
        Ok(e) => e,
        Err(_) => return v,
    };
    for e in entries.filter_map(|e| e.ok()) {
        if !e.metadata().map(|m| m.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = e.file_name().to_string_lossy().into_owned();
        let (bytes, mtime, mtime_s) = dir_size_mtime(&e.path());
        v.push(Session {
            project: proj.to_string(),
            id,
            bytes,
            mtime,
            mtime_s,
        });
    }
    v
}

fn dir_size_mtime(dir: &std::path::Path) -> (u64, u64, String) {
    let mut bytes = 0u64;
    let mut mtime = 0u64;
    let mut best: Option<std::time::SystemTime> = None;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.filter_map(|e| e.ok()) {
            // One stat per entry: size + mtime come from the same metadata.
            let md = match e.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !md.is_file() {
                continue;
            }
            bytes += md.len();
            if let Ok(t) = md.modified() {
                let ms = t
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                if ms > mtime {
                    mtime = ms;
                    best = Some(t);
                }
            }
        }
    }
    // Format once for the newest file instead of once per file.
    let mtime_s = best.map(format_time).unwrap_or_else(|| "-".to_string());
    (bytes, mtime, mtime_s)
}

/// Shared worker cap (issues #85-3, #85-4): cores clamped to 1..=8 so a
/// 2-core host stays responsive while bigger machines still parallelize.
/// Crate-wide: `search` uses the same cap.
pub(crate) fn parallelism() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8)
}

/// Subprocess batch width: external `zstd` calls pay spawn latency each,
/// so waves must overlap it. Memory stays O(1) per process (64 KiB pump),
/// therefore oversubscribing CPU here is safe, unlike thread work.
/// Keeps a hard bound (no unbounded spawn storms) while hiding latency.
fn subprocess_width() -> usize {
    (parallelism() * 4).clamp(8, 32)
}

fn batch_decompressed(root: &str, shown: &[&Session], zstd_cli: bool) -> Vec<Option<u64>> {
    let mut out: Vec<Option<u64>> = vec![None; shown.len()];
    let width = subprocess_width();
    for (base, chunk) in shown.chunks(width).enumerate() {
        std::thread::scope(|s| {
            let mut handles = vec![];
            for (j, sess) in chunk.iter().enumerate() {
                let root = root.to_string();
                let proj = sess.project.clone();
                let id = sess.id.clone();
                handles.push((
                    j,
                    s.spawn(move || session_decompressed_bytes(&root, &proj, &id, zstd_cli)),
                ));
            }
            for (j, h) in handles {
                out[base * width + j] = h.join().unwrap_or(None);
            }
        });
    }
    out
}

fn zstd_available() -> bool {
    std::process::Command::new("zstd")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Exact decompressed byte total for one session: std-only frame headers
/// first, streaming `zstd -dc` only for files whose frames omit the size.
/// Returns None when no `.zstd` file yielded a size (same `?` set as before).
fn session_decompressed_bytes(root: &str, project: &str, id: &str, zstd_cli: bool) -> Option<u64> {
    let dir = std::path::Path::new(root).join(project).join(id);
    let entries = std::fs::read_dir(dir).ok()?;
    let mut total = 0u64;
    let mut any = false;
    let mut deferred = vec![];
    for e in entries.filter_map(|e| e.ok()) {
        let p = e.path();
        let name = p.file_name()?.to_string_lossy().into_owned();
        if !name.ends_with(".zstd") {
            continue;
        }
        match zstd_frame_content_size(&p) {
            Some(n) => {
                total += n;
                any = true;
            }
            None => deferred.push(p),
        }
    }
    if !deferred.is_empty() {
        if !zstd_cli {
            return None;
        }
        // Same skip set as the old per-file `zstd -dc`: unreadable files
        // are skipped, they only force `?` when nothing else resolved.
        for p in &deferred {
            if let Some(n) = stream_decompressed_bytes(p) {
                total += n;
                any = true;
            }
        }
    }
    if any {
        Some(total)
    } else {
        None
    }
}

/// Sum of zstd frame content sizes (RFC 8878 §3.1) without decompressing.
/// Returns None when any frame omits its size or the stream is not a plain
/// sequence of frames — the caller then streams `zstd -dc` instead.
fn zstd_frame_content_size(path: &std::path::Path) -> Option<u64> {
    const MAGIC: u32 = 0xFD2F_B528;
    let bytes = std::fs::read(path).ok()?;
    let mut pos = 0usize;
    let mut total = 0u64;
    let mut frames = 0u32;
    while pos + 4 <= bytes.len() {
        let magic =
            u32::from_le_bytes([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]]);
        if magic == MAGIC {
            pos += 4;
            if pos >= bytes.len() {
                return None;
            }
            let desc = bytes[pos];
            pos += 1;
            if desc & 0x08 != 0 {
                return None; // reserved bit; stay conservative
            }
            let fcs_flag = desc >> 6;
            let single = desc >> 5 & 1 == 1;
            let checksum = desc >> 2 & 1 == 1;
            let dict_len = match desc & 0x03 {
                0 => 0,
                1 => 1,
                2 => 2,
                _ => 4,
            };
            let fcs_len = match (fcs_flag, single) {
                (0, true) => 1,
                (0, false) => 0,
                (1, _) => 2,
                (2, _) => 4,
                _ => 8,
            };
            let head = (usize::from(!single)) + dict_len + fcs_len;
            if pos.checked_add(head)? > bytes.len() {
                return None;
            }
            if !single {
                pos += 1; // window descriptor (value unneeded)
            }
            pos += dict_len;
            let fcs = match fcs_len {
                0 => None, // size omitted: must stream
                1 => Some(bytes[pos] as u64),
                2 => Some(u16::from_le_bytes([bytes[pos], bytes[pos + 1]]) as u64 + 256),
                4 => Some(u32::from_le_bytes([
                    bytes[pos],
                    bytes[pos + 1],
                    bytes[pos + 2],
                    bytes[pos + 3],
                ]) as u64),
                _ => Some(u64::from_le_bytes([
                    bytes[pos],
                    bytes[pos + 1],
                    bytes[pos + 2],
                    bytes[pos + 3],
                    bytes[pos + 4],
                    bytes[pos + 5],
                    bytes[pos + 6],
                    bytes[pos + 7],
                ])),
            };
            pos += fcs_len;
            total = total.checked_add(fcs?)?;
            frames += 1;
            // Walk data blocks to the next frame (block header: last(1) +
            // type(2) + size(21) bits, little-endian).
            loop {
                if pos + 3 > bytes.len() {
                    return None;
                }
                let v = bytes[pos] as u32
                    | (bytes[pos + 1] as u32) << 8
                    | (bytes[pos + 2] as u32) << 16;
                let btype = v >> 1 & 3;
                let bsize = (v >> 3) as usize;
                if btype == 3 {
                    return None; // reserved block type
                }
                pos += 3;
                pos = pos.checked_add(if btype == 1 { 1 } else { bsize })?;
                if pos > bytes.len() {
                    return None;
                }
                if v & 1 == 1 {
                    if checksum {
                        pos = pos.checked_add(4)?;
                        if pos > bytes.len() {
                            return None;
                        }
                    }
                    break;
                }
            }
        } else if magic & 0xFFFF_FFF0 == 0x184D_2A50 {
            // Skippable frame: 4-byte LE payload size follows the magic.
            if pos + 8 > bytes.len() {
                return None;
            }
            let skip = u32::from_le_bytes([
                bytes[pos + 4],
                bytes[pos + 5],
                bytes[pos + 6],
                bytes[pos + 7],
            ]) as usize;
            pos += 8;
            pos = pos.checked_add(skip)?;
            if pos > bytes.len() {
                return None;
            }
        } else {
            return None;
        }
    }
    if pos != bytes.len() || frames == 0 {
        return None;
    }
    Some(total)
}

/// Streaming `zstd -dc` byte count with O(1) memory: the pipe is pumped in
/// 64 KiB chunks instead of buffering the whole output (old `.output()`).
fn stream_decompressed_bytes(path: &std::path::Path) -> Option<u64> {
    use std::io::Read;
    let mut child = std::process::Command::new("zstd")
        .arg("-dc")
        .arg("--")
        .arg(path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut total = 0u64;
    let mut buf = [0u8; 65536];
    if let Some(mut out) = child.stdout.take() {
        loop {
            match out.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => total += n as u64,
                Err(_) => {
                    let _ = child.wait();
                    return None;
                }
            }
        }
    }
    if child.wait().ok()?.success() {
        Some(total)
    } else {
        None
    }
}

pub fn cmd_logs(tail: usize, grep: Option<String>, file: Option<String>) -> anyhow::Result<()> {
    let dir = format!("{}/logs", dsh_home());
    let path = match file {
        Some(f) => std::path::PathBuf::from(if f.contains('/') {
            f
        } else {
            format!("{dir}/{f}")
        }),
        None => match latest_file(&dir) {
            Some(p) => p,
            None => {
                println!("# no logs at {dir}");
                return Ok(());
            }
        },
    };
    eprintln!("[rdsh] reading {}", path.display());
    let text = std::fs::read_to_string(&path)?;
    // Single pass: count matches while keeping only the last `tail` lines.
    // (Old code collected every line, then filtered in a second pass.)
    let pat = grep.as_deref();
    let mut n = 0usize;
    let mut kept: std::collections::VecDeque<&str> =
        std::collections::VecDeque::with_capacity(tail.min(512));
    for line in text.lines() {
        if pat.map(|p| line.contains(p)).unwrap_or(true) {
            n += 1;
            if tail > 0 {
                if kept.len() == tail {
                    kept.pop_front();
                }
                kept.push_back(line);
            }
        }
    }
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    for l in &kept {
        let _ = writeln!(out, "{l}");
    }
    let _ = out.flush();
    eprintln!(
        "[rdsh] {} line(s){}",
        n,
        grep.map(|g| format!(" matching {g:?}")).unwrap_or_default()
    );
    Ok(())
}

fn latest_file(dir: &str) -> Option<std::path::PathBuf> {
    let mut best: Option<(u64, std::path::PathBuf)> = None;
    for e in std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok()) {
        // One stat per entry; the display string is not needed here.
        let md = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !md.is_file() {
            continue;
        }
        let m = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if best.as_ref().map(|(bm, _)| m > *bm).unwrap_or(true) {
            best = Some((m, e.path()));
        }
    }
    best.map(|(_, p)| p)
}

fn dir_names(dir: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|e| {
            e.filter_map(|e| e.ok())
                .filter(|e| e.metadata().is_ok_and(|m| m.is_dir()))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

pub fn names_json(kind: &str) -> String {
    let dir = format!("{}/{}", dsh_home(), kind);
    serde_json::json!({"kind": kind, "names": dir_names(&dir)}).to_string()
}

pub fn sessions_json(limit: usize) -> String {
    let root = format!("{}/sessions", dsh_home());
    let projects = dir_names(&root).len();
    // Same walk the CLI uses (newest first by numeric mtime); the old code
    // re-implemented it and sorted by the minute-precision display string.
    let sessions = scan_sessions(&root, None);
    let out: Vec<serde_json::Value> = sessions
        .iter()
        .take(limit.clamp(1, 100))
        .map(|s| {
            serde_json::json!({
                "project": s.project,
                "id": s.id,
                "bytes": s.bytes,
                "mtime": s.mtime_s,
            })
        })
        .collect();
    serde_json::json!({"sessions": out, "projects": projects}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_cap() {
        // Issues #85-3, #85-4: scan/token threads follow cores, clamped 1..=8.
        assert!((1..=8).contains(&parallelism()));
    }

    /// Minimal single-segment frame with one raw block (RFC 8878 §3.1).
    fn raw_frame(
        fcs_flag: u8,
        dict_id: &[u8],
        fcs: &[u8],
        payload: &[u8],
        checksum: bool,
    ) -> Vec<u8> {
        let mut v = vec![0x28, 0xB5, 0x2F, 0xFD];
        let single = u8::from(fcs_flag == 0 && dict_id.is_empty() && fcs.len() == 1);
        let dict_flag = match dict_id.len() {
            0 => 0,
            1 => 1,
            2 => 2,
            _ => 3,
        };
        let desc = fcs_flag << 6 | single << 5 | u8::from(checksum) << 2 | dict_flag;
        v.push(desc);
        if single == 0 {
            v.push(0x00); // window descriptor (value irrelevant here)
        }
        v.extend_from_slice(dict_id);
        v.extend_from_slice(fcs);
        let size = payload.len() as u32;
        assert!(size < (1 << 21));
        let hdr = 1u32 | size << 3; // last block, raw type
        v.push((hdr & 0xFF) as u8);
        v.push(((hdr >> 8) & 0xFF) as u8);
        v.push(((hdr >> 16) & 0xFF) as u8);
        v.extend_from_slice(payload);
        if checksum {
            v.extend_from_slice(&[0, 0, 0, 0]);
        }
        v
    }

    fn write_tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn frame_header_sizes() {
        // 1-byte FCS (single segment): exact size.
        let p = write_tmp(
            "rdsh-zstd-1b.zstd",
            &raw_frame(0, &[], &[5], b"hello", false),
        );
        assert_eq!(zstd_frame_content_size(&p), Some(5));
        // 2-byte FCS: stored value + 256.
        let body = vec![7u8; 300];
        let p2 = write_tmp(
            "rdsh-zstd-2b.zstd",
            &raw_frame(1, &[], &[44, 0], &body, false),
        );
        assert_eq!(zstd_frame_content_size(&p2), Some(300));
        // 4-byte FCS with dictionary id and checksum.
        let body4 = vec![9u8; 70000];
        let mut fcs = 70000u32.to_le_bytes().to_vec();
        let _ = fcs.pop();
        let f4 = raw_frame(2, &[0xAA], &[fcs[0], fcs[1], fcs[2], 0], &body4, true);
        let p4 = write_tmp("rdsh-zstd-4b.zstd", &f4);
        assert_eq!(zstd_frame_content_size(&p4), Some(70000));
        for f in [&p, &p2, &p4] {
            let _ = std::fs::remove_file(f);
        }
    }

    #[test]
    fn frame_header_fallback_cases() {
        // Multi-frame streams sum.
        let mut two = raw_frame(0, &[], &[5], b"hello", false);
        two.extend_from_slice(&raw_frame(0, &[], &[3], b"abc", false));
        let pm = write_tmp("rdsh-zstd-multi.zstd", &two);
        assert_eq!(zstd_frame_content_size(&pm), Some(8));
        // Skippable frame in front is skipped.
        let mut sk = vec![0x50, 0x2A, 0x4D, 0x18, 0x02, 0x00, 0x00, 0x00, 0xAA, 0xBB];
        sk.extend_from_slice(&raw_frame(0, &[], &[5], b"hello", false));
        let ps = write_tmp("rdsh-zstd-skip.zstd", &sk);
        assert_eq!(zstd_frame_content_size(&ps), Some(5));
        // Unknown size (non-single-segment, FCS flag 0) needs streaming.
        let pu = write_tmp(
            "rdsh-zstd-unk.zstd",
            &raw_frame(0, &[0xAA], &[], b"abc", false),
        );
        assert_eq!(zstd_frame_content_size(&pu), None);
        // Truncated / garbage files need streaming too.
        let pt = write_tmp("rdsh-zstd-trunc.zstd", &[0x28, 0xB5, 0x2F, 0xFD, 0x20]);
        assert_eq!(zstd_frame_content_size(&pt), None);
        let pg = write_tmp("rdsh-zstd-garbage.zstd", b"not zstd at all!!");
        assert_eq!(zstd_frame_content_size(&pg), None);
        for f in [&pm, &ps, &pu, &pt, &pg] {
            let _ = std::fs::remove_file(f);
        }
    }

    #[test]
    fn header_matches_stream_on_real_files() {
        // Real session files are streaming-compressed (no stored size), so
        // they exercise the streaming fallback; it must agree with the old
        // buffered `zstd -dc` byte count (covered by the old-vs-new diff).
        // A CLI-compressed file (seekable input carries FCS) proves the
        // header path against a real encoder. Skips without fixtures/CLI.
        if !zstd_available() {
            return;
        }
        let dir = std::env::temp_dir();
        let src = dir.join("rdsh-zstd-fixture.bin");
        let dst = dir.join("rdsh-zstd-fixture.bin.zst");
        // Random bytes (incompressible) keep every block large and raw-free.
        let mut seed = 0x9E37_79B9u64;
        let mut body = vec![0u8; 100_000];
        for b in &mut body {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            *b = (seed >> 33) as u8;
        }
        std::fs::write(&src, &body).unwrap();
        let status = std::process::Command::new("zstd")
            .arg("-q")
            .arg("-f")
            .arg(&src)
            .arg("-o")
            .arg(&dst)
            .status();
        if status.map(|s| s.success()).unwrap_or(false) {
            assert_eq!(
                zstd_frame_content_size(&dst),
                stream_decompressed_bytes(&dst)
            );
            assert_eq!(zstd_frame_content_size(&dst), Some(body.len() as u64));
        }
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
        let root = format!("{}/sessions", dsh_home());
        let Ok(projs) = std::fs::read_dir(&root) else {
            return;
        };
        let mut checked = 0;
        'scan: for proj in projs.filter_map(|e| e.ok()) {
            let Ok(sess) = std::fs::read_dir(proj.path()) else {
                continue;
            };
            for s in sess.filter_map(|e| e.ok()) {
                let Ok(files) = std::fs::read_dir(s.path()) else {
                    continue;
                };
                for f in files.filter_map(|e| e.ok()) {
                    let p = f.path();
                    if p.extension().and_then(|e| e.to_str()) != Some("zstd") {
                        continue;
                    }
                    // Header-resolved files must agree with the stream count;
                    // FCS-less files (None) are the expected fallback set.
                    if let Some(n) = zstd_frame_content_size(&p) {
                        assert_eq!(Some(n), stream_decompressed_bytes(&p), "{}", p.display());
                    }
                    checked += 1;
                    if checked >= 6 {
                        break 'scan;
                    }
                }
            }
        }
        assert!(checked > 0, "expected real session fixtures");
    }
}
