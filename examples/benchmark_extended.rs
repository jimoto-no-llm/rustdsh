//! Bounded synthetic performance runner. It never reads user DSH data or credentials.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    sync::mpsc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
        for key in ["PATH", "SystemRoot", "COMSPEC", "TEMP"] {
            if let Some(value) = env::var_os(key) {
                c.env(key, value);
            }
        }
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
    n.map(Some)
        .ok_or_else(|| anyhow!("time did not report peak RSS"))
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
    json!({"median_ms":median,"p95_ms":percentile(v,0.95),"throughput_mib_s":if median == 0.0 || bytes == 0 { Value::Null } else { json!(bytes as f64/1_048_576.0/(median/1000.0)) },"samples_ms":v})
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
    let sessions = dsh.join("sessions/known");
    let stream_sessions = dsh.join("sessions/streaming");
    fs::create_dir_all(&sessions)?;
    fs::create_dir_all(&stream_sessions)?;
    fs::write(dsh.join("rdsh.json"), r#"{"sessions":{"stale_secs":0}}"#)?;
    let one = root.join("one");
    let half = root.join("half");
    fs::write(&one, vec![b'x'; 1_048_576])?;
    fs::write(&half, vec![b'y'; 524_288])?;
    let known = compress(z, &one, false)?;
    let half_known = compress(z, &half, false)?;
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
        fs::File::open(d.join("messages.jsonl.zstd"))?
            .set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_000 + i as u64))?;
    }
    for i in 0..20 {
        let d = stream_sessions.join(format!("s{i:02}"));
        fs::create_dir_all(&d)?;
        fs::write(d.join("messages.jsonl.zstd"), compress(z, &one, true)?)?;
        fs::File::open(d.join("messages.jsonl.zstd"))?
            .set_modified(UNIX_EPOCH + Duration::from_secs(1_700_100_000 + i as u64))?;
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
            fs::copy(e.path(), &d)?;
            fs::File::options()
                .write(true)
                .open(d)?
                .set_modified(e.metadata()?.modified()?)?;
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
fn validate_grown_sessions(out: &[u8]) -> Result<()> {
    let v: Value = serde_json::from_slice(out)?;
    let rows = v["sessions"]
        .as_array()
        .ok_or_else(|| anyhow!("sessions JSON lacks rows"))?;
    if rows.len() != 20 {
        bail!("expected 20 grown sessions")
    }
    let mut normal = 0;
    let mut grown = 0;
    for row in rows {
        if row["tokens_exact"].as_bool() != Some(true) {
            bail!("grown session is not exact: {row}")
        }
        match row["tokens"].as_u64() {
            Some(262_144) => normal += 1,
            Some(327_680) => grown += 1,
            _ => bail!("unexpected grown session tokens: {row}"),
        }
    }
    if normal != 19 || grown != 1 {
        bail!("expected 19 ordinary + 1 grown session")
    }
    Ok(())
}
fn validate_streaming_sessions(out: &[u8]) -> Result<()> {
    let v: Value = serde_json::from_slice(out).context("sessions stdout is not JSON")?;
    let rows = v["sessions"]
        .as_array()
        .ok_or_else(|| anyhow!("sessions JSON lacks rows"))?;
    if rows.len() != 20 {
        bail!("expected 20 sessions, got {}", rows.len())
    }
    for row in rows {
        if row["tokens_exact"].as_bool() != Some(true) {
            bail!("streaming session was not exact: {row}")
        }
        if row["tokens"].as_u64() != Some(262_144) {
            bail!("unexpected streaming token count: {row}")
        }
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
    let mut samples: BTreeMap<String, Vec<f64>> =
        bins.keys().map(|k| (k.clone(), Vec::new())).collect();
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
        outs.insert(label.clone(), want);
    }
    for iteration in 0..n {
        let mut labels: Vec<_> = bins.keys().collect();
        if iteration % 2 == 1 {
            labels.reverse();
        }
        for label in labels {
            let s = &boxes[label];
            if case.clear {
                let _ = fs::remove_file(s.cache_file());
            }
            let (ms, o) = invoke(s, &bins[label], &case.argv, case.cache)?;
            validate(&case.expect, &o)?;
            if o != outs[label] {
                bail!("stdout changed for {}/{}", case.name, label)
            }
            samples.get_mut(label).unwrap().push(ms);
        }
    }
    for (label, bin) in bins {
        let s = &boxes[label];
        let mut r = stats(&samples[label], case.bytes);
        if case.clear {
            let _ = fs::remove_file(s.cache_file());
        }
        r["peak_rss_bytes"] =
            peak_rss(s, bin, &case.argv, case.cache)?.map_or(Value::Null, Value::from);
        results.insert(label.clone(), r);
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
fn concurrent_check(bin: &Path, s: &Sandbox, argv: &[String], n: usize) -> Result<Value> {
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
    cache_json(s)?;
    let mut samples = Vec::with_capacity(n);
    for _ in 0..n {
        let _ = fs::remove_file(s.cache_file());
        let started = Instant::now();
        let mut wave = vec![];
        for _ in 0..4 {
            let (s, b, a) = (s.clone(), bin.to_path_buf(), argv.to_vec());
            wave.push(std::thread::spawn(move || invoke(&s, &b, &a, true)));
        }
        for h in wave {
            validate_sessions(
                &h.join().map_err(|_| anyhow!("writer panicked"))??.1,
                262_144,
                20,
            )?;
        }
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    cache_json(s)?;
    Ok(stats(&samples, 4 * 20 * 1_048_576))
}

fn growing_case(bin: &Path, s: &Sandbox, z: &Path, argv: &[String], n: usize) -> Result<Value> {
    let p = s.dsh.join("sessions/streaming/s00/messages.jsonl.zstd");
    let original = fs::read(&p)?;
    let part = s.root.join("growth-part");
    fs::write(&part, vec![b'z'; 262_144])?;
    let frame = compress(z, &part, true)?;
    let _ = fs::remove_file(s.cache_file());
    validate_sessions(&invoke(s, bin, argv, true)?.1, 262_144, 20)?;
    let result = (|| -> Result<Value> {
        let mut samples = Vec::new();
        for i in 0..n + 3 {
            fs::OpenOptions::new()
                .append(true)
                .open(&p)?
                .write_all(&frame)?;
            let (ms, out) = invoke(s, bin, argv, true)?;
            let rows: Value = serde_json::from_slice(&out)?;
            let rows = rows["sessions"]
                .as_array()
                .ok_or_else(|| anyhow!("missing sessions"))?;
            if rows.len() != 20 {
                bail!("missing growing sessions");
            }
            for row in rows {
                let expected = if row["id"] == "s00" {
                    262_144 + 65_536 * (i + 1)
                } else {
                    262_144
                };
                if row["tokens"] != expected || row["tokens_exact"] != true {
                    bail!("growing stream oracle mismatch: {row}");
                }
            }
            if i >= 3 {
                samples.push(ms);
            }
        }
        Ok(
            json!({"passed":true,"append_bytes_per_invocation":262144,"initial_bytes_per_session":1048576,"n":n,"results":stats(&samples,0)}),
        )
    })();
    fs::write(p, original)?;
    let _ = fs::remove_file(s.cache_file());
    result
}

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn http_case(bin: &Path, s: &Sandbox, n: usize) -> Result<Value> {
    let config = s.dsh.join("rdsh.json");
    let mut settings: Value = serde_json::from_slice(&fs::read(&config)?)?;
    settings["extras"] = json!({"enable":["serve"]});
    fs::write(config, settings.to_string())?;
    let mut command = s.command(bin, &["serve".into(), "--port".into(), "0".into()], true);
    let mut server = Server(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?,
    );
    let stderr = server.0.stderr.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(url) = line
                .split_whitespace()
                .find(|x| x.starts_with("http://127.0.0.1:"))
            {
                let _ = tx.send(url.to_owned());
            }
        }
    });
    let url = rx.recv_timeout(Duration::from_secs(15))?;
    let (port, token) = url
        .trim_start_matches("http://127.0.0.1:")
        .split_once("/#key=")
        .ok_or_else(|| anyhow!("invalid readiness URL"))?;
    let port: u16 = port.parse()?;
    let mut report = serde_json::Map::new();
    let text = "a".repeat(40960);
    for (name, method, route, body) in [
        ("version", "GET", "/api/version", String::new()),
        (
            "tokens_40kib",
            "POST",
            "/api/tokens",
            json!({"text":text}).to_string(),
        ),
        (
            "prune_40kib",
            "POST",
            "/api/prune",
            json!({"text":text,"max_tokens":1000}).to_string(),
        ),
    ] {
        let mut samples = Vec::new();
        for i in 0..n + 3 {
            let started = Instant::now();
            let mut stream = TcpStream::connect(("127.0.0.1", port))?;
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            stream.set_write_timeout(Some(Duration::from_secs(5)))?;
            write!(stream,"{method} {route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-RDSH-Token: {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len())?;
            let mut response = String::new();
            stream.read_to_string(&mut response)?;
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            let (head, payload) = response
                .split_once("\r\n\r\n")
                .ok_or_else(|| anyhow!("incomplete HTTP response"))?;
            if head.split_whitespace().nth(1) != Some("200") {
                bail!("HTTP benchmark request failed");
            }
            let value: Value = serde_json::from_str(payload)?;
            match name {
                "version" if value["name"] != "rdsh" => bail!("version oracle failed"),
                "tokens_40kib" if value["tokens"] != 10240 => bail!("tokens oracle failed"),
                "prune_40kib"
                    if value["budget"] != 1000
                        || value["after"].as_u64().is_none_or(|x| x > 1000) =>
                {
                    bail!("prune oracle failed")
                }
                _ => {}
            }
            if i >= 3 {
                samples.push(elapsed);
            }
        }
        report.insert(name.into(), stats(&samples, body.len() as u64));
    }
    Ok(
        json!({"timing":"TCP connect + HTTP response, persistent Rust server, no browser rendering","cases":report}),
    )
}

fn delegation_case(bin: &Path, original: &Path, s: &Sandbox, n: usize) -> Result<Value> {
    let shim_dir = s.root.join("shim-bin");
    fs::create_dir_all(&shim_dir)?;
    let shim = shim_dir.join(if cfg!(windows) { "dsh.exe" } else { "dsh" });
    fs::copy(bin, &shim)?;
    let args = vec!["--version".into()];
    let expected = invoke(s, original, &args, true)?.1;
    let cache_dir = s.root.join("home/.cache/rdsh-node-compile-cache");
    let mut report = serde_json::Map::new();
    for name in [
        "compile_cache_off",
        "compile_cache_warm",
        "compile_cache_empty",
    ] {
        let mut samples = Vec::new();
        for i in 0..n + 3 {
            if name == "compile_cache_empty" {
                let _ = fs::remove_dir_all(&cache_dir);
            }
            let started = Instant::now();
            let out = s
                .command(&shim, &args, true)
                .env("RDSH_ORIG_BIN", original)
                .env(
                    "RDSH_NODE_COMPILE_CACHE",
                    if name == "compile_cache_off" {
                        "0"
                    } else {
                        "1"
                    },
                )
                .output()?;
            if !out.status.success() || out.stdout != expected {
                bail!("real DSH delegation version oracle failed");
            }
            if i >= 3 {
                samples.push(started.elapsed().as_secs_f64() * 1000.0);
            }
        }
        report.insert(name.into(),json!({"results":stats(&samples,0),"compile_cache_directory_written":cache_dir.exists(),"stdout_matches_original":true}));
    }
    Ok(
        json!({"scope":"copied unchanged rdsh invoked as dsh, delegated real original --version; no model calls, no Desktop startup","cases":report}),
    )
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
        "--project".into(),
        "known".into(),
        "--limit".into(),
        "20".into(),
        "--tokens".into(),
        "--json".into(),
    ];
    let streaming_sessions = vec![
        "sessions".into(),
        "--project".into(),
        "streaming".into(),
        "--limit".into(),
        "20".into(),
        "--tokens".into(),
        "--json".into(),
    ];
    let mut concurrent = serde_json::Map::new();
    for (label, bin) in &bins {
        concurrent.insert(
            label.clone(),
            concurrent_check(bin, &boxes[label], &sessions, a.n)?,
        );
    }
    // stale_secs=0: grow a no-content-size frame and require the exact new answer before timing.
    for (label, bin) in &bins {
        let s = &boxes[label];
        validate_sessions(&invoke(s, bin, &sessions, true)?.1, 262_144, 20)?;
        let quarter = tmp.path().join("quarter");
        fs::write(&quarter, vec![b'z'; 262_144])?;
        let grow = compress(&z, &quarter, true)?;
        let p = s.dsh.join("sessions/known/s00/messages.jsonl.zstd");
        let mut old = fs::read(&p)?;
        old.extend(grow);
        fs::write(p, old)?;
        validate_grown_sessions(&invoke(s, bin, &sessions, true)?.1)?;
    }
    // The growth assertion is an E2E correctness check only; timing keeps the
    // named known-frame workload free of no-content-size appended frames.
    for s in boxes.values() {
        fs::remove_dir_all(&s.dsh)?;
        copy_dir(&f.dsh, &s.dsh)?;
        let _ = fs::remove_file(s.cache_file());
    }
    let cases = vec![
        Case {
            name: "sessions_known_frame_first_cache_miss",
            argv: sessions.clone(),
            bytes: 20 * 1_048_576,
            cache: true,
            clear: true,
            expect: Validation::Sessions(262_144),
        },
        Case {
            name: "sessions_cache_disabled",
            argv: sessions.clone(),
            bytes: 20 * 1_048_576,
            cache: false,
            clear: false,
            expect: Validation::Sessions(262_144),
        },
        Case {
            name: "sessions_cache_warm",
            argv: sessions.clone(),
            bytes: 20 * 1_048_576,
            cache: true,
            clear: false,
            expect: Validation::Sessions(262_144),
        },
        Case {
            name: "sessions_streaming_zstd_no_content_size",
            argv: streaming_sessions,
            bytes: 20 * 1_048_576,
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
            bytes: fs::read_dir(&f.small)?
                .map(|e| e.and_then(|e| e.metadata()).map(|m| m.len()))
                .collect::<std::io::Result<Vec<_>>>()?
                .into_iter()
                .sum(),
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
            bytes: fs::read_dir(&f.large)?
                .map(|e| e.and_then(|e| e.metadata()).map(|m| m.len()))
                .collect::<std::io::Result<Vec<_>>>()?
                .into_iter()
                .sum(),
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
    let mut growing = serde_json::Map::new();
    for (label, bin) in &bins {
        let result = growing_case(bin, &boxes[label], &z, &cases[3].argv, a.n);
        if label == "candidate" {
            growing.insert(label.clone(), result?);
        } else {
            growing.insert(
                label.clone(),
                match result {
                    Ok(v) => v,
                    Err(e) => json!({"passed":false,"error":e.to_string()}),
                },
            );
        }
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
        json!({"version_only":true,"results":stats(&v,0),"peak_rss_bytes":peak_rss(&s,&dsh,&av,true)?,"delegated_candidate":delegation_case(&bins["candidate"],&dsh,&s,a.n)?})
    } else {
        Value::Null
    };
    let mut native_http = serde_json::Map::new();
    for (label, bin) in &bins {
        native_http.insert(label.clone(), http_case(bin, &boxes[label], a.n)?);
    }
    let mut hashes = serde_json::Map::new();
    for (label, b) in &bins {
        hashes.insert(label.clone(), Value::String(fingerprint(&fs::read(b)?)));
    }
    let report = json!({"n":a.n,"warmups":3,"timing":"parent wall clock including process launch; OS filesystem remains warm by design","scope":"synthetic fixtures only; no model calls or credentials","comparison_order":"alternates per sample for sequential cases; separate blocks for concurrent/growing/HTTP/delegation cases","throughput":"logical fixture bytes per second, not physical IO throughput; growing has no single fixed byte count","binaries":hashes,"cases":report_cases,"concurrent_4_writers":concurrent,"growing_stream":growing,"original_dsh":original,"native_http":native_http});
    if let Some(p) = a.output.parent() {
        fs::create_dir_all(p)?;
    }
    fs::write(a.output, serde_json::to_vec_pretty(&report)?)?;
    println!("saved {} cases with {} samples each", cases.len(), a.n);
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
