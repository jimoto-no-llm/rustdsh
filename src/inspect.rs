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

#[derive(Clone)]
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
                    handles.push(s.spawn(move || scan_project(&pdir, proj)));
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

pub fn cmd_sessions(
    project: Option<String>,
    limit: usize,
    tokens: bool,
    json: bool,
    stale_secs: u64,
) -> anyhow::Result<()> {
    let root = format!("{}/sessions", dsh_home());
    if project.is_none() && std::fs::read_dir(&root).is_err() {
        if json {
            println!("{}", serde_json::json!({"sessions": [], "total": 0}));
        } else {
            println!("# no sessions dir at {root}");
        }
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
    let sizes: Vec<(Option<u64>, bool)> = if tokens {
        // Content-keyed cache: repeat views skip re-decompression.
        let mut cache = TokensCache::load();
        let out = if shown.len() >= 2 {
            batch_decompressed(&root, &shown, zstd_cli, stale_secs, &mut cache)
        } else {
            shown
                .iter()
                .map(|s| session_decompressed_bytes(&root, s, zstd_cli, stale_secs, &mut cache))
                .collect()
        };
        cache.save();
        out
    } else {
        vec![(None, false); shown.len()]
    };
    if tokens && !zstd_cli && sizes.iter().any(|(s, _)| s.is_none()) {
        eprintln!("[rdsh] note: zstd CLI not found; `?` rows show stored-bytes/4 estimate");
    }
    if json {
        let items: Vec<serde_json::Value> = shown
            .iter()
            .zip(sizes.iter())
            .map(|(s, (decomp, exact))| {
                let tok = match decomp {
                    Some(b) => Some(b / 4),
                    None => Some(s.bytes / 4),
                };
                if tokens {
                    serde_json::json!({
                        "project": s.project,
                        "id": s.id,
                        "bytes": s.bytes,
                        "mtime": s.mtime_s,
                        "tokens": tok,
                        "tokens_exact": exact,
                    })
                } else {
                    serde_json::json!({
                        "project": s.project,
                        "id": s.id,
                        "bytes": s.bytes,
                        "mtime": s.mtime_s,
                        "tokens": null,
                        "tokens_exact": false,
                    })
                }
            })
            .collect();
        println!("{}", serde_json::json!({"sessions": items, "total": total}));
        eprintln!("[rdsh] {total} session(s), showing up to {limit}");
        return Ok(());
    }
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    for (s, (decomp, exact)) in shown.iter().zip(sizes.iter()) {
        let tok = if tokens {
            match decomp {
                Some(b) if *exact => format!("~{}tok", b / 4),
                Some(b) => format!("~{}tok~", b / 4),
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
        if !e.metadata().is_ok_and(|m| m.is_dir()) {
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

/// Content-keyed cache for decompressed session sizes.
///
/// Session logs only grow, so `(mtime_ms, stored_bytes)` identifies the
/// content: repeat views (a desktop sidecar polling `sessions --tokens`)
/// skip re-decompression entirely. Best-effort file cache — any error
/// means recompute, never a wrong value. `RDSH_TOKENS_CACHE=0` disables it.
///
/// Entries are `(mtime, bytes, decomp, ts, cli)`; `cli` records whether the
/// zstd CLI was available when the value was computed. A `None` is only
/// authoritative with `cli` set: without the CLI, FCS-less frames are
/// unresolvable, so such `None`s are never stored, and legacy `null`
/// entries (no `cli` field) are recomputed once the CLI is available.
#[derive(Clone)]
struct TokensCache {
    path: Option<String>,
    map: std::collections::HashMap<String, (u64, u64, Option<u64>, u64, bool)>,
    dirty: bool,
}

impl TokensCache {
    fn key(root: &str, project: &str, id: &str) -> String {
        format!("{root}/{project}/{id}")
    }

    fn path() -> Option<String> {
        if std::env::var("RDSH_TOKENS_CACHE").as_deref() == Ok("0") {
            return None;
        }
        let base = std::env::var("XDG_CACHE_HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| home_dir().map(|h| format!("{h}/.cache")))?;
        Some(format!("{base}/rdsh/sessions-tokens.json"))
    }

    fn load() -> Self {
        Self::load_from(Self::path())
    }

    fn load_from(path: Option<String>) -> Self {
        let mut map = std::collections::HashMap::new();
        if let Some(p) = path.as_deref() {
            if let Ok(text) = std::fs::read_to_string(p) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(obj) = v.as_object() {
                        for (k, e) in obj {
                            // Cap on load so a foreign huge file stays harmless.
                            if map.len() >= 2000 {
                                break;
                            }
                            let m = e.get("mtime").and_then(|x| x.as_u64()).unwrap_or(0);
                            let b = e.get("bytes").and_then(|x| x.as_u64()).unwrap_or(0);
                            let d = e.get("decomp").and_then(|x| x.as_u64());
                            let t = e.get("ts").and_then(|x| x.as_u64()).unwrap_or(0);
                            let c = e.get("cli").and_then(|x| x.as_bool()).unwrap_or(false);
                            map.insert(k.clone(), (m, b, d, t, c));
                        }
                    }
                }
            }
        }
        TokensCache {
            path,
            map,
            dirty: false,
        }
    }

    /// Cache hit returns the stored result (which may itself be `None`
    /// for unresolvable sessions); key mismatch means recompute, and so does
    /// a `None` computed without the zstd CLI when the CLI is now available.
    fn get(&self, key: &str, mtime: u64, bytes: u64, zstd_cli: bool) -> Option<Option<u64>> {
        match self.map.get(key) {
            Some((m, b, d, _, c))
                if *m == mtime && *b == bytes && (d.is_some() || *c || !zstd_cli) =>
            {
                Some(*d)
            }
            _ => None,
        }
    }

    /// Stale reuse: a previous exact value for a grown file, valid when
    /// computed recently. Callers must mark the row inexact.
    fn stale(&self, key: &str, max_age_secs: u64) -> Option<u64> {
        let (.., d, t, _) = *self.map.get(key)?;
        let age = now_secs().saturating_sub(t);
        if age <= max_age_secs {
            d
        } else {
            None
        }
    }

    fn put(&mut self, key: &str, mtime: u64, bytes: u64, decomp: Option<u64>, zstd_cli: bool) {
        // Without the CLI a `None` may just mean "needs `zstd -dc`": storing
        // it would pin `?` after the CLI is installed.
        if self.path.is_none() || (decomp.is_none() && !zstd_cli) {
            return;
        }
        self.map.insert(
            key.to_string(),
            (mtime, bytes, decomp, now_secs(), zstd_cli),
        );
        self.dirty = true;
    }

    /// File-level key inside a session dir (session-level keys have no `f:`
    /// prefix, so the two namespaces never collide).
    fn file_key(root: &str, project: &str, id: &str, file: &str) -> String {
        format!("f:{root}/{project}/{id}/{file}")
    }

    /// Merge another cache (per-thread clones) into this one.
    fn merge(&mut self, other: &TokensCache) {
        if self.path.is_none() {
            return;
        }
        for (k, v) in &other.map {
            if self.map.get(k) != Some(v) {
                self.map.insert(k.clone(), *v);
                self.dirty = true;
            }
        }
    }

    fn save(&self) {
        let Some(p) = self.path.as_deref() else {
            return;
        };
        if !self.dirty {
            return;
        }
        // Deterministic cap: sorted keys, first 1000.
        let mut keys: Vec<&String> = self.map.keys().collect();
        keys.sort();
        let mut obj = serde_json::Map::new();
        for k in keys.into_iter().take(1000) {
            if let Some((m, b, d, t, c)) = self.map.get(k) {
                obj.insert(
                    k.clone(),
                    serde_json::json!({"mtime": m, "bytes": b, "decomp": d, "ts": t, "cli": c}),
                );
            }
        }
        let text = serde_json::Value::Object(obj).to_string();
        if let Some(parent) = std::path::Path::new(p).parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return;
            }
        }
        // Atomic replace so concurrent readers never see a torn file.
        let tmp = format!("{p}.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, p);
        }
    }
}

fn batch_decompressed(
    root: &str,
    shown: &[&Session],
    zstd_cli: bool,
    stale_secs: u64,
    cache: &mut TokensCache,
) -> Vec<(Option<u64>, bool)> {
    let mut out: Vec<(Option<u64>, bool)> = vec![(None, false); shown.len()];
    // Serial cache pass first: hits never touch threads or IO.
    let mut pending: Vec<(usize, Session)> = vec![];
    for (i, sess) in shown.iter().enumerate() {
        let key = TokensCache::key(root, &sess.project, &sess.id);
        match cache.get(&key, sess.mtime, sess.bytes, zstd_cli) {
            Some(hit) => out[i] = (hit, true),
            None => pending.push((i, (*sess).clone())),
        }
    }
    if pending.is_empty() {
        return out;
    }
    let width = subprocess_width();
    for chunk in pending.chunks(width) {
        std::thread::scope(|s| {
            let mut handles = vec![];
            for (i, sess) in chunk {
                let root = root.to_string();
                let sess = (*sess).clone();
                let mut local = cache.clone();
                handles.push((
                    *i,
                    s.spawn(move || {
                        let r = session_decompressed_bytes(
                            &root, &sess, zstd_cli, stale_secs, &mut local,
                        );
                        (r, local)
                    }),
                ));
            }
            for (i, h) in handles {
                if let Ok(((r, _), local)) = h.join() {
                    cache.merge(&local);
                    let sess = &shown[i];
                    cache.put(
                        &TokensCache::key(root, &sess.project, &sess.id),
                        sess.mtime,
                        sess.bytes,
                        r,
                        zstd_cli,
                    );
                    out[i] = (r, true);
                }
            }
        });
    }
    out
}

fn zstd_available() -> bool {
    std::process::Command::new("zstd")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Exact decompressed byte total for one session: std-only frame headers
/// first, streaming `zstd -dc` only for files whose frames omit the size.
/// Returns None when no `.zstd` file yielded a size (same `?` set as before).
/// Cached entry point: content-keyed by `(mtime_ms, stored_bytes)`, so only
/// grown sessions pay for re-decompression.
fn session_decompressed_bytes(
    root: &str,
    sess: &Session,
    zstd_cli: bool,
    stale_secs: u64,
    cache: &mut TokensCache,
) -> (Option<u64>, bool) {
    let key = TokensCache::key(root, &sess.project, &sess.id);
    if let Some(hit) = cache.get(&key, sess.mtime, sess.bytes, zstd_cli) {
        return (hit, true);
    }
    let (r, exact) = session_decompressed_bytes_uncached(
        root,
        &sess.project,
        &sess.id,
        zstd_cli,
        stale_secs,
        cache,
    );
    cache.put(&key, sess.mtime, sess.bytes, r, zstd_cli);
    (r, exact)
}

fn session_decompressed_bytes_uncached(
    root: &str,
    project: &str,
    id: &str,
    zstd_cli: bool,
    stale_secs: u64,
    cache: &mut TokensCache,
) -> (Option<u64>, bool) {
    let dir = std::path::Path::new(root).join(project).join(id);
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return (None, false),
    };
    let mut total = 0u64;
    let mut any = false;
    let mut estimated = false;
    let mut deferred = vec![];
    for e in entries.filter_map(|e| e.ok()) {
        let p = e.path();
        let Some(name) = p.file_name().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
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
            return (None, false);
        }
        // Per-file cache: only grown/added files pay for re-expansion.
        let mut todo: Vec<std::path::PathBuf> = vec![];
        for p in &deferred {
            let Some(name) = p.file_name().map(|s| s.to_string_lossy().into_owned()) else {
                continue;
            };
            let Some((mtime, bytes)) = file_meta(p) else {
                continue;
            };
            let fkey = TokensCache::file_key(root, project, id, &name);
            match cache.get(&fkey, mtime, bytes, zstd_cli) {
                Some(hit) => {
                    if let Some(n) = hit {
                        total += n;
                        any = true;
                    }
                }
                None => todo.push(p.clone()),
            }
        }
        // Stale reuse: grown files with a recent exact value skip expansion
        // (marked inexact by the caller via the returned flag).
        let stale_window = stale_secs;
        let mut todo2: Vec<std::path::PathBuf> = vec![];
        for p in &todo {
            let stale_hit = p
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .and_then(|name| {
                    cache.stale(
                        &TokensCache::file_key(root, project, id, &name),
                        stale_window,
                    )
                });
            match stale_hit {
                Some(n) => {
                    total += n;
                    any = true;
                    estimated = true;
                }
                None => todo2.push(p.clone()),
            }
        }
        let todo = todo2;
        if todo.len() == 1 {
            let p = &todo[0];
            if let Some(name) = p.file_name().map(|s| s.to_string_lossy().into_owned()) {
                if let Some((mtime, bytes)) = file_meta(p) {
                    let n = stream_decompressed_bytes(p);
                    cache.put(
                        &TokensCache::file_key(root, project, id, &name),
                        mtime,
                        bytes,
                        n,
                        zstd_cli,
                    );
                    if let Some(n) = n {
                        total += n;
                        any = true;
                    }
                }
            }
        } else if !todo.is_empty() {
            // Several misses: one spawn for all (sums are order-independent).
            // Per-file attribution is impossible here, so only the session
            // entry (saved by the caller) covers this round.
            let refs: Vec<&std::path::PathBuf> = todo.iter().collect();
            match stream_many_decompressed_bytes(&refs) {
                Some(n) => {
                    total += n;
                    any = true;
                }
                None => {
                    for p in &todo {
                        if let Some(n) = stream_decompressed_bytes(p) {
                            total += n;
                            any = true;
                        }
                    }
                }
            }
        }
        if any {
            return (Some(total), !estimated);
        }
        return (None, false);
    }
    if any {
        (Some(total), !estimated)
    } else {
        (None, false)
    }
}

/// Sum of zstd frame content sizes (RFC 8878 §3.1) without decompressing.
/// Returns None when any frame omits its size or the stream is not a plain
/// sequence of frames — the caller then streams `zstd -dc` instead.
fn zstd_frame_content_size(path: &std::path::Path) -> Option<u64> {
    const MAGIC: u32 = 0xFD2F_B528;
    // Prefix sniff first: session logs are streaming-written with the size
    // omitted, so most files are decided from the first frame header alone
    // instead of reading megabytes just to discard them.
    if first_frame_denies_size(path) {
        return None;
    }
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

/// First-frame prefix sniff (<=32 bytes): reports true only for cases the
/// full walk below also rejects — non-zstd magic, reserved descriptor bit,
/// or an omitted frame content size. Anything indecisive (short/truncated
/// prefix, skippable first frame) returns false so the full walk decides.
/// Output-identical by construction: it only shortcuts definite rejections.
fn first_frame_denies_size(path: &std::path::Path) -> bool {
    const MAGIC: u32 = 0xFD2F_B528;
    let prefix: Vec<u8> = match std::fs::File::open(path) {
        Ok(mut f) => {
            use std::io::Read;
            let mut buf = [0u8; 32];
            let mut n = 0usize;
            while n < buf.len() {
                match f.read(&mut buf[n..]) {
                    Ok(0) => break,
                    Ok(k) => n += k,
                    Err(_) => return false,
                }
            }
            buf[..n].to_vec()
        }
        Err(_) => return false,
    };
    if prefix.len() < 5 {
        return false; // tiny file: full walk decides (cheap anyway)
    }
    let magic = u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]);
    if magic != MAGIC {
        // A non-skippable first frame is rejected by the full walk too.
        if prefix.len() >= 8 && magic & 0xFFFF_FFF0 != 0x184D_2A50 {
            return true;
        }
        return false;
    }
    let desc = prefix[4];
    if desc & 0x08 != 0 {
        return true; // reserved bit: full walk rejects
    }
    let fcs_flag = desc >> 6;
    let single = desc >> 5 & 1 == 1;
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
    // First header needs magic(4) + desc(1) + window(0/1) + dict + fcs.
    let head = 4 + 1 + usize::from(!single) + dict_len + fcs_len;
    if prefix.len() < head {
        return false; // truncated header: full walk decides
    }
    fcs_len == 0 // omitted size: full walk hits `fcs?` -> None
}

/// Streaming `zstd -dc` byte count with O(1) memory: the pipe is pumped in
/// 64 KiB chunks instead of buffering the whole output (old `.output()`).
/// Wall-clock seconds for cache freshness windows.
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// (mtime_ms, bytes) for cache identity; None when the file is unreadable.
fn file_meta(path: &std::path::Path) -> Option<(u64, u64)> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((mtime, md.len()))
}

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

/// Batched `zstd -dc` over several files: one spawn, concatenated output.
/// Byte sums are order-independent, so the total matches looping
/// `stream_decompressed_bytes` per file. `None` on empty input, spawn
/// failure, or nonzero exit (caller falls back to the per-file loop).
fn stream_many_decompressed_bytes(paths: &[&std::path::PathBuf]) -> Option<u64> {
    use std::io::Read;
    if paths.is_empty() {
        return None;
    }
    let mut child = std::process::Command::new("zstd")
        .arg("-dc")
        .arg("--")
        .args(paths.iter().map(|p| p.as_path()))
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

    fn tmp_cache(dir: &std::path::Path) -> TokensCache {
        TokensCache::load_from(Some(dir.join("cache.json").to_string_lossy().into_owned()))
    }

    fn sess(project: &str, id: &str) -> Session {
        Session {
            project: project.to_string(),
            id: id.to_string(),
            bytes: 13,
            mtime: 1000,
            mtime_s: String::new(),
        }
    }

    #[test]
    fn tokens_cache_skips_none_without_cli() {
        // A FCS-less frame is `?` without the zstd CLI; that `None` must not
        // be cached on the session, batch or file path, or installing zstd
        // later would never resolve the unchanged session.
        let dir = std::env::temp_dir().join(format!("rdsh-tc-skip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.join("sessions");
        std::fs::create_dir_all(root.join("p/s1")).unwrap();
        std::fs::create_dir_all(root.join("p/s2")).unwrap();
        std::fs::write(
            root.join("p/s1/a.zstd"),
            raw_frame(0, &[], &[5], b"hello", false),
        )
        .unwrap();
        std::fs::write(
            root.join("p/s2/a.zstd"),
            raw_frame(0, &[0xAA], &[], b"abcd", false),
        )
        .unwrap();
        let root = root.to_string_lossy().into_owned();
        let (s1, s2) = (sess("p", "s1"), sess("p", "s2"));
        let k1 = TokensCache::key(&root, "p", "s1");
        let k2 = TokensCache::key(&root, "p", "s2");

        // Session path.
        let mut cache = tmp_cache(&dir);
        assert_eq!(
            session_decompressed_bytes(&root, &s2, false, 0, &mut cache),
            (None, false)
        );
        assert!(!cache.map.contains_key(&k2));
        assert!(!cache.dirty);

        // Batch path: the resolvable session is cached, the `?` one is not.
        let mut cache = tmp_cache(&dir);
        let out = batch_decompressed(&root, &[&s1, &s2], false, 0, &mut cache);
        assert_eq!(out, vec![(Some(5), true), (None, true)]);
        assert_eq!(cache.get(&k1, s1.mtime, s1.bytes, true), Some(Some(5)));
        assert!(!cache.map.contains_key(&k2));
        cache.save();
        let reloaded = tmp_cache(&dir);
        assert!(!reloaded.map.contains_key(&k2));

        // File path (and put itself): CLI-less `None` is dropped, a `None`
        // computed with the CLI is authoritative and kept.
        let fkey = TokensCache::file_key(&root, "p", "s2", "a.zstd");
        let mut cache = tmp_cache(&dir);
        cache.put(&fkey, 1, 2, None, false);
        assert!(!cache.map.contains_key(&fkey));
        cache.put(&fkey, 1, 2, None, true);
        assert_eq!(cache.get(&fkey, 1, 2, true), Some(None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tokens_cache_legacy_null_rechecked_with_cli() {
        // Caches written before the `cli` field may hold `null` from a host
        // without zstd: a miss once the CLI exists, still a hit without it.
        let dir = std::env::temp_dir().join(format!("rdsh-tc-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("cache.json"),
            r#"{"n":{"mtime":1,"bytes":2,"decomp":null,"ts":0},"v":{"mtime":1,"bytes":2,"decomp":40,"ts":0}}"#,
        )
        .unwrap();
        let mut cache = tmp_cache(&dir);
        assert_eq!(cache.get("n", 1, 2, true), None);
        assert_eq!(cache.get("n", 1, 2, false), Some(None));
        assert_eq!(cache.get("v", 1, 2, true), Some(Some(40)));
        // Recomputed with the CLI and still unresolvable: now authoritative,
        // and the flag survives a save/load round trip.
        cache.put("n", 1, 2, None, true);
        cache.save();
        let reloaded = tmp_cache(&dir);
        assert_eq!(reloaded.get("n", 1, 2, true), Some(None));
        let _ = std::fs::remove_dir_all(&dir);
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
