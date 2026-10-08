//! Bounded synthetic performance runner. It never reads user DSH data or credentials.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Result<Self> {
        let p = env::temp_dir().join(format!(
            "rdsh-benchmark-{}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p)?;
        Ok(Self(p))
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Args {
    bin: PathBuf,
    baseline: Option<PathBuf>,
    dsh: Option<PathBuf>,
    n: usize,
    output: PathBuf,
}
fn next(it: &mut std::iter::Skip<std::env::ArgsOs>, flag: &str) -> Result<PathBuf> {
    it.next()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("{flag} requires a value"))
}
fn args() -> Result<Args> {
    let (mut bin, mut baseline, mut dsh, mut output, mut n) = (None, None, None, None, 15usize);
    let mut it = env::args_os().skip(1);
    while let Some(flag) = it.next() {
        match flag.to_string_lossy().as_ref() {
        "--bin" => bin = Some(next(&mut it, "--bin")?), "--baseline" => baseline = Some(next(&mut it, "--baseline")?), "--dsh" => dsh = Some(next(&mut it, "--dsh")?), "--output" => output = Some(next(&mut it, "--output")?),
        "--n" => n = it.next().ok_or_else(|| anyhow!("--n requires a value"))?.to_string_lossy().parse().context("--n must be an integer")?,
        _ => bail!("unknown argument {flag:?}; usage: cargo run --release --example benchmark_extended -- --bin PATH [--baseline PATH] [--dsh PATH] [--n 15] --output PATH"),
    }
    }
    if n < 5 {
        bail!("--n must be at least 5");
    }
    Ok(Args {
        bin: bin
            .ok_or_else(|| anyhow!("--bin is required"))?
            .canonicalize()?,
        baseline: baseline.map(|p| p.canonicalize()).transpose()?,
        dsh: dsh.map(|p| p.canonicalize()).transpose()?,
        n,
        output: output.ok_or_else(|| anyhow!("--output is required"))?,
    })
}

#[derive(Clone)]
struct Sandbox {
    root: PathBuf,
    dsh: PathBuf,
    cache: PathBuf,
}
impl Sandbox {
    fn new(root: &Path, label: &str) -> Result<Self> {
        let root = root.join(label);
        let dsh = root.join("dsh");
        let cache = root.join("cache");
        fs::create_dir_all(dsh.join("sessions"))?;
        fs::create_dir_all(&cache)?;
        Ok(Self { root, dsh, cache })
    }
    fn command(&self, bin: &Path, argv: &[String], cache: bool) -> Command {
        let mut c = Command::new(bin);
        c.args(argv);
        c.env_clear();
        c.env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("DSH_HOME", &self.dsh)
            .env("XDG_DATA_HOME", self.root.join("data"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("XDG_CACHE_HOME", &self.cache)
            .env("RDSH_TOKENS_CACHE", if cache { "1" } else { "0" });
        c
    }
    fn cache_file(&self) -> PathBuf {
        self.cache.join("rdsh/sessions-tokens.json")
    }
}
fn invoke(s: &Sandbox, bin: &Path, argv: &[String], cache: bool) -> Result<(f64, Vec<u8>)> {
    let started = Instant::now();
    let out = s.command(bin, argv, cache).output()?;
    if !out.status.success() {
        bail!(
            "{} {:?} exited {:?}: {}",
            bin.display(),
            argv,
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok((started.elapsed().as_secs_f64() * 1000.0, out.stdout))
}
fn peak_rss(s: &Sandbox, bin: &Path, argv: &[String], cache: bool) -> Result<Option<u64>> {
    let Some((time, mac)) = (if cfg!(target_os = "macos") && Path::new("/usr/bin/time").exists() {
        Some((PathBuf::from("/usr/bin/time"), true))
    } else if cfg!(target_os = "linux") && Path::new("/usr/bin/time").exists() {
        Some((PathBuf::from("/usr/bin/time"), false))
    } else {
        None
    }) else {
        return Ok(None);
    };
    let mut c = s.command(&time, &[], cache);
    if mac {
        c.arg("-l");
    } else {
        c.args(["-f", "RSS_KIB=%M"]);
    }
    c.arg(bin).args(argv);
    let out = c.output()?;
    if !out.status.success() {
        bail!("time wrapper failed")
    };
    let text = String::from_utf8_lossy(&out.stderr);
    let n = if mac {
        text.lines()
            .find_map(|x| x.strip_suffix("  maximum resident set size"))
            .and_then(|x| x.trim().parse().ok())
    } else {
        text.lines()
            .find_map(|x| x.strip_prefix("RSS_KIB="))
            .and_then(|x| x.parse().ok())
            .map(|n: u64| n * 1024)
    };
    Ok(n)
}
fn percentile(samples: &[f64], q: f64) -> f64 {
    assert!(!samples.is_empty());
    let mut v = samples.to_vec();
    v.sort_by(f64::total_cmp);
    v[((v.len() as f64 * q).ceil() as usize)
        .saturating_sub(1)
        .min(v.len() - 1)]
}
fn stats(v: &[f64], bytes: u64) -> Value {
    let median = percentile(v, 0.5);
    json!({"median_ms":median,"p95_ms":percentile(v,0.95),"throughput_mib_s":if median == 0.0 { Value::Null } else { json!(bytes as f64/1_048_576.0/(median/1000.0)) },"samples_ms":v})
}
fn fingerprint(bytes: &[u8]) -> String {
    let mut h = 0xcbf29ce484222325u64;
    for b in bytes {
        h = (h ^ *b as u64).wrapping_mul(0x100000001b3)
    }
    format!("fnv1a64:{h:016x}")
}
fn zstd() -> Result<PathBuf> {
    let p=env::var_os("PATH").and_then(|p| env::split_paths(&p).map(|d|d.join("zstd")).find(|p|p.is_file())).ok_or_else(||anyhow!("zstd CLI is required for streaming --no-content-size fixtures; install zstd and retry"))?;
    if !Command::new(&p)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        bail!("zstd CLI is required for streaming --no-content-size fixtures")
    }
    Ok(p)
}
fn compress(z: &Path, source: &Path, no_size: bool) -> Result<Vec<u8>> {
    let mut c = Command::new(z);
    c.args(["-q", "-c"]);
    if no_size {
        c.arg("--no-content-size");
    }
    let o = c.arg(source).output()?;
    if !o.status.success() {
        bail!("zstd compression failed")
    };
    Ok(o.stdout)
}

struct Fixtures {
    dsh: PathBuf,
    small: PathBuf,
    large: PathBuf,
    compact: PathBuf,
}
fn fixtures(root: &Path, z: &Path) -> Result<Fixtures> {
    let dsh = root.join("fixtures-dsh");
    let sessions = dsh.join("sessions/project");
    fs::create_dir_all(&sessions)?;
    fs::write(dsh.join("rdsh.json"), r#"{"sessions":{"stale_secs":0}}"#)?;
    let one = root.join("one");
    let half = root.join("half");
    fs::write(&one, vec![b'x'; 1_048_576])?;
    fs::write(&half, vec![b'y'; 524_288])?;
    let known = compress(z, &one, false)?;
    let half_known = compress(z, &half, false)?;
    // Create the no-content-size session first, so the 20 known-size entries
    // are the deterministic first page for the cache-miss/warm cases.
    let streaming = sessions.join("streaming");
    fs::create_dir_all(&streaming)?;
    fs::write(
        streaming.join("messages.jsonl.zstd"),
        compress(z, &one, true)?,
    )?;
    for i in 0..20 {
        let d = sessions.join(format!("s{i:02}"));
        fs::create_dir_all(&d)?;
        fs::write(
            d.join("messages.jsonl.zstd"),
            if i == 0 {
                [half_known.clone(), half_known.clone()].concat()
            } else {
                known.clone()
            },
        )?;
    }
    let small = root.join("search-under-32");
    let large = root.join("search-at-least-32");
    for (dir, n) in [(&small, 16usize), (&large, 40usize)] {
        fs::create_dir_all(dir)?;
        for i in 0..n {
            fs::write(
                dir.join(format!("f{i:02}.txt")),
                format!("ordinary\nneedle-{i}\n"),
            )?;
        }
    }
    let compact = root.join("compact.jsonl");
    let mut t = String::new();
    while t.len() < 1_048_576 {
        t.push_str("{\"role\":\"user\",\"content\":\"benchmark compact payload\"}\n")
    }
    fs::write(&compact, t)?;
    Ok(Fixtures {
        dsh,
        small,
        large,
        compact,
    })
}
fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let d = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &d)?
        } else {
            fs::copy(e.path(), d)?;
        }
    }
    Ok(())
}
fn validate_sessions(out: &[u8], tokens: u64, count: usize) -> Result<()> {
    let v: Value = serde_json::from_slice(out).context("sessions stdout is not JSON")?;
    let rows = v["sessions"]
        .as_array()
        .ok_or_else(|| anyhow!("sessions JSON lacks rows"))?;
    if rows.len() != count {
        bail!("expected {count} sessions, got {}", rows.len())
    };
    for row in rows {
        if row["tokens"].as_u64() != Some(tokens) || row["tokens_exact"].as_bool() != Some(true) {
            bail!("session oracle mismatch: {row}")
        }
    }
    Ok(())
}
fn validate_streaming_sessions(out: &[u8]) -> Result<()> {
    let v: Value = serde_json::from_slice(out).context("sessions stdout is not JSON")?;
    let rows = v["sessions"]
        .as_array()
        .ok_or_else(|| anyhow!("sessions JSON lacks rows"))?;
    if rows.len() != 21 {
        bail!("expected 21 sessions, got {}", rows.len())
    }
    let mut ordinary = 0usize;
    let mut grown = 0usize;
    for row in rows {
        if row["tokens_exact"].as_bool() != Some(true) {
            bail!("streaming session was not exact: {row}")
        }
        match row["tokens"].as_u64() {
            Some(262_144) => ordinary += 1,
            Some(327_680) => grown += 1,
            other => bail!("unexpected streaming token count {other:?}"),
        }
    }
    if ordinary != 20 || grown != 1 {
        bail!("streaming session oracle mismatch: ordinary={ordinary}, grown={grown}")
    }
    Ok(())
}
fn cache_json(s: &Sandbox) -> Result<()> {
    let v: Value = serde_json::from_str(
        &fs::read_to_string(s.cache_file()).context("token cache was not written")?,
    )
    .context("token cache is not valid JSON")?;
    if !v.is_object() {
        bail!("token cache must be an object")
    };
    Ok(())
}
#[derive(Clone)]
enum Validation {
    Sessions(u64),
    Streaming,
    Search(usize),
    Nonempty,
}
#[derive(Clone)]
struct Case {
    name: &'static str,
    argv: Vec<String>,
    bytes: u64,
    cache: bool,
    clear: bool,
    expect: Validation,
}
fn validate(expect: &Validation, out: &[u8]) -> Result<()> {
    match expect {
        Validation::Sessions(n) => validate_sessions(out, *n, 20),
        Validation::Streaming => validate_streaming_sessions(out),
        Validation::Search(n) => {
            if String::from_utf8_lossy(out).lines().count() != *n {
                bail!("search expected {n} hits")
            }
            Ok(())
        }
        Validation::Nonempty => {
            if out.is_empty() {
                bail!("unexpected empty stdout")
            } else {
                Ok(())
            }
        }
    }
}
fn run_case(
    case: &Case,
    bins: &BTreeMap<String, PathBuf>,
    boxes: &BTreeMap<String, Sandbox>,
    n: usize,
) -> Result<Value> {
    let (mut outs, mut results) = (BTreeMap::new(), serde_json::Map::new());
    for (label, bin) in bins {
        let s = &boxes[label];
        let mut standard = None;
        for _ in 0..3 {
            if case.clear {
                let _ = fs::remove_file(s.cache_file());
            }
            let (_, o) = invoke(s, bin, &case.argv, case.cache)?;
            validate(&case.expect, &o)?;
            if let Some(x) = &standard {
                if x != &o {
                    bail!("unstable stdout for {}/{}", case.name, label)
                }
            }
            standard = Some(o);
        }
        let want = standard.unwrap();
        let mut samples = vec![];
        for _ in 0..n {
            if case.clear {
                let _ = fs::remove_file(s.cache_file());
            }
            let (ms, o) = invoke(s, bin, &case.argv, case.cache)?;
            validate(&case.expect, &o)?;
            if o != want {
                bail!("stdout changed for {}/{}", case.name, label)
            }
            samples.push(ms);
        }
        let mut r = stats(&samples, case.bytes);
        r["peak_rss_bytes"] =
            peak_rss(s, bin, &case.argv, case.cache)?.map_or(Value::Null, Value::from);
        results.insert(label.clone(), r);
        outs.insert(label.clone(), want);
    }
    if outs
        .values()
        .skip(1)
        .any(|o| o != outs.values().next().unwrap())
    {
        bail!("candidate/baseline stdout differs for {}", case.name)
    }
    Ok(
        json!({"bytes":case.bytes,"stdout_equal":true,"stdout_fnv1a64":fingerprint(outs.values().next().unwrap()),"results":results}),
    )
}
fn concurrent_check(bin: &Path, s: &Sandbox, argv: &[String]) -> Result<()> {
    let _ = fs::remove_file(s.cache_file());
    let mut hs = vec![];
    for _ in 0..4 {
        let (s, b, a) = (s.clone(), bin.to_path_buf(), argv.to_vec());
        hs.push(std::thread::spawn(move || invoke(&s, &b, &a, true)))
    }
    let mut first = None;
    for h in hs {
        let (_, o) = h.join().map_err(|_| anyhow!("writer panicked"))??;
        validate_sessions(&o, 262_144, 20)?;
        if let Some(x) = &first {
            if x != &o {
                bail!("concurrent writers changed stdout")
            }
        }
        first = Some(o)
    }
    cache_json(s)
}

fn main() -> Result<()> {
    let a = args()?;
    let z = zstd()?;
    let tmp = TempDir::new()?;
    let f = fixtures(tmp.path(), &z)?;
    let mut bins: BTreeMap<String, PathBuf> = BTreeMap::new();
    bins.insert("candidate".to_string(), a.bin);
    if let Some(b) = a.baseline {
        bins.insert("baseline".to_string(), b);
    }
    let mut boxes: BTreeMap<String, Sandbox> = BTreeMap::new();
    for label in bins.keys() {
        let s = Sandbox::new(tmp.path(), label)?;
        copy_dir(&f.dsh, &s.dsh)?;
        boxes.insert(label.clone(), s);
    }
    let sessions = vec![
        "sessions".into(),
        "--limit".into(),
        "20".into(),
        "--tokens".into(),
        "--json".into(),
    ];
    let streaming_sessions = vec![
        "sessions".into(),
        "--limit".into(),
        "21".into(),
        "--tokens".into(),
        "--json".into(),
    ];
    for (label, bin) in &bins {
        concurrent_check(bin, &boxes[label], &sessions)?;
    }
    // stale_secs=0: grow a no-content-size frame and require the exact new answer before timing.
    for (label, bin) in &bins {
        let s = &boxes[label];
        validate_sessions(&invoke(s, bin, &sessions, true)?.1, 262_144, 20)?;
        let quarter = tmp.path().join("quarter");
        fs::write(&quarter, vec![b'z'; 262_144])?;
        let grow = compress(&z, &quarter, true)?;
        let p = s.dsh.join("sessions/project/s00/messages.jsonl.zstd");
        let mut old = fs::read(&p)?;
        old.extend(grow);
        fs::write(p, old)?;
        validate_sessions(&invoke(s, bin, &sessions, true)?.1, 327_680, 20)?;
    }
    let cases = vec![
        Case {
            name: "sessions_known_frame_first_cache_miss",
            argv: sessions.clone(),
            bytes: 20 * 1_048_576,
            cache: true,
            clear: true,
            expect: Validation::Sessions(327_680),
        },
        Case {
            name: "sessions_cache_disabled",
            argv: sessions.clone(),
            bytes: 20 * 1_048_576,
            cache: false,
            clear: false,
            expect: Validation::Sessions(327_680),
        },
        Case {
            name: "sessions_cache_warm",
            argv: sessions.clone(),
            bytes: 20 * 1_048_576,
            cache: true,
            clear: false,
            expect: Validation::Sessions(327_680),
        },
        Case {
            name: "sessions_streaming_zstd_no_content_size",
            argv: streaming_sessions,
            bytes: 21 * 1_048_576,
            cache: true,
            clear: true,
            expect: Validation::Streaming,
        },
        Case {
            name: "search_under_32",
            argv: vec![
                "search".into(),
                "needle-".into(),
                "--dir".into(),
                f.small.display().to_string(),
                "--max".into(),
                "100".into(),
            ],
            bytes: 256,
            cache: true,
            clear: false,
            expect: Validation::Search(16),
        },
        Case {
            name: "search_at_least_32",
            argv: vec![
                "search".into(),
                "needle-".into(),
                "--dir".into(),
                f.large.display().to_string(),
                "--max".into(),
                "100".into(),
            ],
            bytes: 640,
            cache: true,
            clear: false,
            expect: Validation::Search(40),
        },
        Case {
            name: "compact_jsonl_1mib",
            argv: vec![
                "compact".into(),
                f.compact.display().to_string(),
                "--max-tokens".into(),
                "4000".into(),
            ],
            bytes: fs::metadata(&f.compact)?.len(),
            cache: true,
            clear: false,
            expect: Validation::Nonempty,
        },
    ];
    let mut report_cases = serde_json::Map::new();
    for c in &cases {
        report_cases.insert(c.name.into(), run_case(c, &bins, &boxes, a.n)?);
    }
    let original = if let Some(dsh) = a.dsh {
        let s = Sandbox::new(tmp.path(), "original-dsh")?;
        let av = vec!["--version".into()];
        let mut v = vec![];
        for _ in 0..3 {
            let _ = invoke(&s, &dsh, &av, true)?;
        }
        for _ in 0..a.n {
            v.push(invoke(&s, &dsh, &av, true)?.0);
        }
        json!({"version_only":true,"results":stats(&v,0),"peak_rss_bytes":peak_rss(&s,&dsh,&av,true)?})
    } else {
        Value::Null
    };
    let mut hashes = serde_json::Map::new();
    for (label, b) in &bins {
        hashes.insert(label.clone(), Value::String(fingerprint(&fs::read(b)?)));
    }
    let report = json!({"n":a.n,"warmups":3,"timing":"parent wall clock including process launch; OS filesystem remains warm by design","scope":"synthetic fixtures only; no model calls or credentials","binaries":hashes,"cases":report_cases,"original_dsh":original});
    if let Some(p) = a.output.parent() {
        fs::create_dir_all(p)?;
    }
    fs::write(a.output, serde_json::to_vec_pretty(&report)?)?;
    println!("{}", serde_json::to_string(&report["cases"])?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn p95_uses_nearest_rank_and_keeps_last_sample() {
        assert_eq!(percentile(&[1., 2., 3., 4., 5.], 0.95), 5.)
    }
    #[test]
    fn session_oracle_rejects_wrong_or_inexact_values() {
        validate_sessions(
            br#"{"sessions":[{"tokens":262144,"tokens_exact":true}]}"#,
            262144,
            1,
        )
        .unwrap();
        assert!(validate_sessions(
            br#"{"sessions":[{"tokens":2,"tokens_exact":false}]}"#,
            262144,
            1
        )
        .is_err())
    }
}
