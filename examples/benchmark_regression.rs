//! CI-oriented performance-regression runner for the real `rdsh` binary.
//!
//! It measures the core CLI fast paths by spawning an actual binary as a
//! subprocess with an isolated temporary `HOME`/`DSH_HOME`/`XDG_*` environment,
//! so no user data, sessions or credentials are read. Results are written as a
//! JSON trend report; an optional baseline binary or baseline JSON turns the
//! run into a before/after ratio check with an explicit regression threshold.
//!
//! Usage:
//!
//! ```sh
//! cargo run --release --example benchmark_regression -- \
//!   --bin ./target/release/rdsh --n 15 --output /tmp/rdsh-perf.json
//! ```
//!
//! See `docs/BENCHMARKS.md` for the schema and the threshold policy.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Bumped whenever the report layout changes incompatibly.
const SCHEMA_VERSION: u32 = 1;
/// Warmup iterations before sampling; never counted.
const WARMUPS: usize = 3;
/// `--n` lower bound, matching the other runners in this repository.
const MIN_SAMPLES: usize = 5;
/// Default regression budget in percent.
const DEFAULT_MAX_REGRESSION_PERCENT: f64 = 10.0;
/// Case names that participate in the hard regression gate.
const HEADLINE_CASES: [&str; 4] = [
    "version_startup",
    "tokens_1mib",
    "tokens_10mib",
    "search_tree_200_files",
];

// ---------------------------------------------------------------------------
// Process-wide child accounting: `getrusage(RUSAGE_CHILDREN)` is cumulative,
// so every subprocess we spawn must be recorded to map a "delta" back onto the
// one command we care about.
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn child_cpu_and_rss() -> Option<(f64, u64)> {
    // SAFETY: `getrusage` only writes into the `rusage` we own.
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_CHILDREN, &mut usage) != 0 {
            return None;
        }
        let seconds = |tv: libc::timeval| tv.tv_sec as f64 + tv.tv_usec as f64 / 1_000_000.0;
        let cpu = seconds(usage.ru_utime) + seconds(usage.ru_stime);
        // Linux reports KiB, macOS and the BSDs report bytes.
        let rss = if cfg!(target_os = "linux") {
            usage.ru_maxrss.max(0) as u64 * 1024
        } else {
            usage.ru_maxrss.max(0) as u64
        };
        Some((cpu, rss))
    }
}

#[cfg(not(unix))]
fn child_cpu_and_rss() -> Option<(f64, u64)> {
    None
}

/// Charges finished subprocesses to a shared, process-wide CPU total.
///
/// `getrusage(RUSAGE_CHILDREN)` is cumulative, so the total of every child this
/// runner has reaped is subtracted to isolate one command's CPU cost. Wall
/// clock stays the headline metric; CPU is reported next to it so a noisy
/// shared runner can be spotted.
#[derive(Clone)]
struct Meter(std::sync::Arc<std::sync::Mutex<MeterState>>);

#[derive(Default)]
struct MeterState {
    cpu_seconds: f64,
    children: u64,
}

impl Meter {
    fn new() -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(
            MeterState::default(),
        )))
    }

    /// Record a child that has just been reaped; returns its CPU seconds.
    fn record(&self) -> Option<f64> {
        let (cpu_now, _) = child_cpu_and_rss()?;
        let mut state = self.0.lock().ok()?;
        let charge = (cpu_now - state.cpu_seconds).max(0.0);
        state.cpu_seconds = cpu_now;
        state.children += 1;
        Some(charge)
    }
}

// ---------------------------------------------------------------------------
// Isolated sandbox
// ---------------------------------------------------------------------------

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self> {
        let mut nonce = [0_u8; 8];
        getrandom::fill(&mut nonce).map_err(|e| anyhow!("nonce generation failed: {e}"))?;
        let name: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let path = std::env::temp_dir().join(format!("rdsh-perf-{}-{name}", std::process::id()));
        std::fs::create_dir_all(path.join("home"))?;
        std::fs::create_dir_all(path.join("dsh"))?;
        std::fs::create_dir_all(path.join("data"))?;
        std::fs::create_dir_all(path.join("config"))?;
        std::fs::create_dir_all(path.join("cache"))?;
        std::fs::create_dir_all(path.join("cwd"))?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Environment shim handed to every measured process.
#[derive(Clone)]
struct Sandbox {
    root: PathBuf,
    meter: Meter,
}

impl Sandbox {
    fn new(root: &Path, meter: Meter) -> Self {
        Self {
            root: root.to_path_buf(),
            meter,
        }
    }

    /// A command with a scrubbed environment: only the temporary directories
    /// plus the handful of variables needed to find shared libraries survive.
    fn command(&self, program: &Path, argv: &[String]) -> Command {
        let mut command = Command::new(program);
        command.args(argv);
        command.current_dir(self.root.join("cwd"));
        command.env_clear();
        command
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("DSH_HOME", self.root.join("dsh"))
            .env("XDG_DATA_HOME", self.root.join("data"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("XDG_CACHE_HOME", self.root.join("cache"))
            .env("TMPDIR", self.root.join("cache"));
        for key in [
            "PATH",
            "SystemRoot",
            "COMSPEC",
            "TEMP",
            "TMP",
            "LD_LIBRARY_PATH",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
    }
}

/// Result of one measured subprocess.
struct Run {
    elapsed_ms: f64,
    elapsed_cpu_ms: Option<f64>,
    stdout: Vec<u8>,
    exit_code: Option<i32>,
}

/// Spawn `argv`, read stdout to EOF and wait; the stopwatch stops at EOF so a
/// noisy shared runner cannot inflate the reported latency.
fn invoke(sandbox: &Sandbox, bin: &Path, argv: &[String]) -> Result<Run> {
    let started = Instant::now();
    let mut child = sandbox
        .command(bin, argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to spawn {}", bin.display()))?;
    let mut stdout = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_end(&mut stdout)
            .context("failed to read child stdout")?;
    }
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let status = child.wait().context("failed to wait for child")?;
    let charge = sandbox.meter.record();
    if !status.success() {
        bail!(
            "{} {:?} exited with {:?}",
            bin.display(),
            argv,
            status.code()
        );
    }
    Ok(Run {
        elapsed_ms,
        elapsed_cpu_ms: charge.map(|seconds| seconds * 1000.0),
        stdout,
        exit_code: status.code(),
    })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// Deterministic xorshift64* stream: fixtures stay byte-identical across runs
/// and machines, which keeps stdout comparisons meaningful.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn pick<'a>(&mut self, words: &[&'a str]) -> &'a str {
        words[(self.next() % words.len() as u64) as usize]
    }
}

const WORDS: [&str; 12] = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet",
    "kilo", "lima",
];

/// One text file of at least `bytes` bytes: 12 words per line, then a marker.
fn generate_text(path: &Path, bytes: usize, rng: &mut Rng) -> Result<()> {
    let mut file = std::io::BufWriter::new(std::fs::File::create(path)?);
    let mut written = 0usize;
    while written < bytes {
        let mut line = String::with_capacity(96);
        for i in 0..12 {
            if i > 0 {
                line.push(' ');
            }
            line.push_str(rng.pick(&WORDS));
        }
        line.push('\n');
        written += line.len();
        file.write_all(line.as_bytes())?;
    }
    file.write_all(b"regression-needle-tail\n")?;
    file.flush()?;
    Ok(())
}

/// A two-level tree of `files` text files, each carrying one needle line.
fn generate_tree(root: &Path, files: usize, per_file: usize, rng: &mut Rng) -> Result<()> {
    std::fs::create_dir_all(root)?;
    for index in 0..files {
        let dir = root.join(format!("d{:02}", index % 10));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("f{index:03}.txt"));
        let mut file = std::io::BufWriter::new(std::fs::File::create(&path)?);
        for line in 0..per_file {
            let mut text = String::with_capacity(96);
            for i in 0..10 {
                if i > 0 {
                    text.push(' ');
                }
                text.push_str(rng.pick(&WORDS));
            }
            writeln!(file, "line {line} {text}")?;
        }
        writeln!(file, "regression-needle-{index}")?;
        file.flush()?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/// How a case decides whether the produced stdout was correct.
enum Oracle {
    /// stdout must be byte-identical to the baseline (or the record run).
    Stable,
    /// `rdsh tokens` on a file of `bytes` bytes; value checked arithmetically.
    Tokens { bytes: u64 },
    /// `rdsh search` over a tree of `hits` needles.
    Search { hits: usize },
}

struct Case {
    name: &'static str,
    argv: Vec<String>,
    input_bytes: u64,
    oracle: Oracle,
    /// Wire bytes the command is expected to move, for the throughput column.
    throughput_bytes: u64,
}

impl Case {
    /// Check the value this case is supposed to produce, independently of any
    /// baseline. Returns the evidence string stored in the report.
    fn validate(&self, stdout: &[u8]) -> Result<String> {
        match &self.oracle {
            Oracle::Stable => {
                if stdout.is_empty() {
                    bail!("{} produced empty stdout", self.name);
                }
                Ok(format!("bytes={}", stdout.len()))
            }
            Oracle::Tokens { bytes } => {
                let text = String::from_utf8_lossy(stdout);
                let tokens: u64 = text
                    .split_whitespace()
                    .next()
                    .context("tokens stdout is empty")?
                    .parse()
                    .context("tokens stdout is not an integer")?;
                let expected = bytes.div_ceil(4);
                if tokens != expected {
                    bail!(
                        "{}: expected {expected} tokens for {bytes} ASCII bytes, got {tokens}",
                        self.name
                    );
                }
                Ok(format!("tokens={tokens}"))
            }
            Oracle::Search { hits } => {
                let text = String::from_utf8_lossy(stdout);
                let lines: Vec<&str> = text.lines().collect();
                if lines.len() != *hits {
                    bail!(
                        "{}: expected {hits} search hits, got {}",
                        self.name,
                        lines.len()
                    );
                }
                if !lines.iter().all(|line| line.contains("regression-needle-")) {
                    bail!("{}: a search hit did not match the needle", self.name);
                }
                let unique: std::collections::BTreeSet<&str> = lines.iter().copied().collect();
                if unique.len() != *hits {
                    bail!("{}: duplicate search hits", self.name);
                }
                // A row count plus a uniqueness check is not enough: 200 rows
                // all ending in `regression-needle-0` satisfy both while 199
                // needles are missing, and with no baseline in CI that
                // truncated output would be recorded as correct. Require the
                // needle ids to be exactly `0..hits`.
                let mut seen = std::collections::BTreeSet::new();
                for line in &lines {
                    let id = line
                        .rsplit_once("regression-needle-")
                        .map(|(_, id)| id.trim())
                        .and_then(|id| id.parse::<usize>().ok())
                        .ok_or_else(|| {
                            anyhow!(
                                "{}: search hit has no readable needle id: {line}",
                                self.name
                            )
                        })?;
                    if !seen.insert(id) {
                        bail!("{}: needle {id} was reported more than once", self.name);
                    }
                }
                let expected: std::collections::BTreeSet<usize> = (0..*hits).collect();
                if seen != expected {
                    let missing: Vec<usize> = expected.difference(&seen).copied().collect();
                    bail!(
                        "{}: search output is missing needle(s) {missing:?}",
                        self.name
                    );
                }
                Ok(format!("hits={hits}"))
            }
        }
    }
}

fn cases(fixtures: &Path, small: &Path, large: &Path, tree: &Path, hits: usize) -> Vec<Case> {
    let mut list = vec![
        Case {
            name: "version_startup",
            argv: vec!["--version".into()],
            input_bytes: 0,
            oracle: Oracle::Stable,
            throughput_bytes: 0,
        },
        Case {
            name: "tokens_1mib",
            argv: vec![
                "tokens".into(),
                small.display().to_string(),
                "--preview".into(),
                "0".into(),
            ],
            input_bytes: std::fs::metadata(small).map(|m| m.len()).unwrap_or(0),
            oracle: Oracle::Tokens {
                bytes: std::fs::metadata(small).map(|m| m.len()).unwrap_or(0),
            },
            throughput_bytes: std::fs::metadata(small).map(|m| m.len()).unwrap_or(0),
        },
        Case {
            name: "tokens_10mib",
            argv: vec![
                "tokens".into(),
                large.display().to_string(),
                "--preview".into(),
                "0".into(),
            ],
            input_bytes: std::fs::metadata(large).map(|m| m.len()).unwrap_or(0),
            oracle: Oracle::Tokens {
                bytes: std::fs::metadata(large).map(|m| m.len()).unwrap_or(0),
            },
            throughput_bytes: std::fs::metadata(large).map(|m| m.len()).unwrap_or(0),
        },
        Case {
            name: "search_tree_200_files",
            argv: vec![
                "search".into(),
                "regression-needle".into(),
                "--dir".into(),
                tree.display().to_string(),
                "--max".into(),
                (hits + 10).to_string(),
            ],
            input_bytes: 0,
            oracle: Oracle::Search { hits },
            throughput_bytes: directory_bytes(tree).unwrap_or(0),
        },
    ];
    debug_assert!(fixtures.exists());
    list.retain(|case| !case.argv.is_empty());
    list
}

fn directory_bytes(root: &Path) -> Result<u64> {
    let mut total = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)?.filter_map(Result::ok) {
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                total += metadata.len();
            }
        }
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/// Nearest-rank percentile; keeps the largest sample at q=0.95 for small n.
fn percentile(samples: &[f64], q: f64) -> f64 {
    assert!(!samples.is_empty(), "percentile needs at least one sample");
    let mut ordered = samples.to_vec();
    ordered.sort_by(f64::total_cmp);
    let rank = ((ordered.len() as f64 * q).ceil() as usize)
        .saturating_sub(1)
        .min(ordered.len() - 1);
    ordered[rank]
}

fn median(samples: &[f64]) -> f64 {
    percentile(samples, 0.5)
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn stats(samples: &[f64], input_bytes: u64) -> Value {
    let median_ms = median(samples);
    let throughput = if median_ms <= 0.0 || input_bytes == 0 {
        Value::Null
    } else {
        json!(round3(
            input_bytes as f64 / 1_048_576.0 / (median_ms / 1000.0)
        ))
    };
    json!({
        "samples_ms": samples.iter().map(|v| round3(*v)).collect::<Vec<_>>(),
        "median_ms": round3(median_ms),
        "p95_ms": round3(percentile(samples, 0.95)),
        "min_ms": round3(percentile(samples, 0.0)),
        "max_ms": round3(percentile(samples, 1.0)),
        "throughput_mib_s": throughput,
    })
}

fn fingerprint(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
struct Args {
    bin: PathBuf,
    baseline: Option<PathBuf>,
    baseline_json: Option<PathBuf>,
    n: usize,
    max_regression_percent: f64,
    output: PathBuf,
}

const USAGE: &str = "usage: cargo run --release --example benchmark_regression -- \
    --bin PATH --output PATH [--n 15] [--baseline PATH] [--baseline-json PATH] \
    [--max-regression-percent 10]";

fn parse_args<I, S>(argv: I) -> Result<Args>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut bin: Option<PathBuf> = None;
    let mut baseline: Option<PathBuf> = None;
    let mut baseline_json: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut n = 15usize;
    let mut max_regression_percent = DEFAULT_MAX_REGRESSION_PERCENT;
    let mut iter = argv.into_iter().map(Into::into);
    while let Some(flag) = iter.next() {
        let mut value = |name: &str| -> Result<String> {
            iter.next()
                .ok_or_else(|| anyhow!("{name} requires a value; {USAGE}"))
        };
        match flag.as_str() {
            "--bin" => bin = Some(PathBuf::from(value("--bin")?)),
            "--baseline" => baseline = Some(PathBuf::from(value("--baseline")?)),
            "--baseline-json" => baseline_json = Some(PathBuf::from(value("--baseline-json")?)),
            "--output" => output = Some(PathBuf::from(value("--output")?)),
            "--n" => {
                n = value("--n")?
                    .parse()
                    .context("--n must be a positive integer")?
            }
            "--max-regression-percent" => {
                max_regression_percent = value("--max-regression-percent")?
                    .parse()
                    .context("--max-regression-percent must be a number")?
            }
            other => bail!("unknown argument {other:?}; {USAGE}"),
        }
    }
    if n < MIN_SAMPLES {
        bail!("--n must be at least {MIN_SAMPLES}");
    }
    if let (Some(_), Some(_)) = (&baseline, &baseline_json) {
        bail!("--baseline and --baseline-json are mutually exclusive");
    }
    if !max_regression_percent.is_finite() || max_regression_percent < 0.0 {
        bail!("--max-regression-percent must be a non-negative finite number");
    }
    Ok(Args {
        bin: bin.ok_or_else(|| anyhow!("--bin is required; {USAGE}"))?,
        baseline,
        baseline_json,
        n,
        max_regression_percent,
        output: output.ok_or_else(|| anyhow!("--output is required; {USAGE}"))?,
    })
}

// ---------------------------------------------------------------------------
// Baseline loading
// ---------------------------------------------------------------------------

/// A previously recorded median for one case, from a baseline binary or JSON.
struct BaselineMedians {
    label: String,
    medians: std::collections::BTreeMap<String, f64>,
}

impl BaselineMedians {
    fn from_json(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let report: Value = serde_json::from_str(&raw)
            .with_context(|| format!("{} is not valid JSON", path.display()))?;
        let schema = report["schema_version"].as_u64();
        if schema != Some(SCHEMA_VERSION as u64) {
            bail!(
                "{} has schema_version {:?}, expected {SCHEMA_VERSION}",
                path.display(),
                schema
            );
        }
        let cases = report["cases"]
            .as_object()
            .ok_or_else(|| anyhow!("{} has no cases object", path.display()))?;
        let mut medians = std::collections::BTreeMap::new();
        for (name, case) in cases {
            // Fail closed. Skipping an unusable entry would silently remove
            // that case from the comparison, so a truncated or hand-edited
            // baseline would make the gate report success while checking
            // nothing. A non-finite or non-positive median is not a usable
            // reference either: it would produce a NaN or inverted ratio.
            let median = case["median_ms"].as_f64().ok_or_else(|| {
                anyhow!(
                    "{} case {name:?} has no numeric median_ms; refusing an incomplete baseline",
                    path.display()
                )
            })?;
            if !median.is_finite() || median <= 0.0 {
                bail!(
                    "{} case {name:?} has median_ms {median}; a baseline median must be finite and positive",
                    path.display()
                );
            }
            medians.insert(name.clone(), median);
        }
        if medians.is_empty() {
            bail!(
                "{} records no cases; refusing an empty baseline",
                path.display()
            );
        }
        Ok(Self {
            label: format!("json:{}", path.display()),
            medians,
        })
    }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// One fully measured case for one binary.
struct Measured {
    samples: Vec<f64>,
    cpu_samples: Vec<f64>,
    peak_rss_bytes: Option<u64>,
    stdout: Vec<u8>,
    evidence: String,
    exit_code: Option<i32>,
}

/// Run every case for one binary; returns measurements in case order.
fn measure_all(sandbox: &Sandbox, bin: &Path, cases: &[Case], n: usize) -> Result<Vec<Measured>> {
    let mut measured = Vec::with_capacity(cases.len());
    for case in cases {
        let mut reference: Option<Vec<u8>> = None;
        let mut evidence = String::new();
        let mut exit_code = None;
        for _ in 0..WARMUPS {
            let run = invoke(sandbox, bin, &case.argv)?;
            let current = case.validate(&run.stdout)?;
            exit_code = run.exit_code;
            match &reference {
                Some(previous) if previous != &run.stdout => {
                    bail!("{}: stdout is not stable across warmups", case.name)
                }
                _ => {
                    reference = Some(run.stdout);
                    evidence = current;
                }
            }
        }
        let mut samples = Vec::with_capacity(n);
        let mut cpu_samples = Vec::with_capacity(n);
        for _ in 0..n {
            let run = invoke(sandbox, bin, &case.argv)?;
            case.validate(&run.stdout)?;
            if reference.as_deref() != Some(run.stdout.as_slice()) {
                bail!("{}: stdout changed between samples", case.name);
            }
            samples.push(run.elapsed_ms);
            exit_code = run.exit_code;
            if let Some(cpu) = run.elapsed_cpu_ms {
                cpu_samples.push(cpu);
            }
        }
        let peak_rss_bytes = if case.name == "version_startup" {
            measure_peak_rss(sandbox, bin, case)?
        } else {
            None
        };
        measured.push(Measured {
            samples,
            cpu_samples,
            peak_rss_bytes,
            stdout: reference.unwrap_or_default(),
            evidence,
            exit_code,
        });
    }
    Ok(measured)
}

/// Peak RSS for `--version`, taken from the process table (portable on Linux
/// and macOS), then from `/usr/bin/time` as a fallback. `None` means the
/// platform could not report it; the run continues.
fn measure_peak_rss(sandbox: &Sandbox, bin: &Path, case: &Case) -> Result<Option<u64>> {
    if let Some(bytes) = sample_peak_rss(sandbox, bin, case)? {
        return Ok(Some(bytes));
    }
    time_peak_rss(sandbox, bin, &case.argv)
}

/// Poll `ps -o rss=` while the child runs; a tighter sampling interval catches
/// a short-lived process better than a single post-exit read.
///
/// The child goes through [`Sandbox::command`] like every other measurement so
/// it sees the same isolated HOME/DSH_HOME/XDG environment. Spawning it
/// directly would let the probe read the real user's settings and credentials,
/// which is exactly what the harness promises not to do.
fn sample_peak_rss(sandbox: &Sandbox, bin: &Path, case: &Case) -> Result<Option<u64>> {
    if !cfg!(unix) {
        return Ok(None);
    }
    let mut command = sandbox.command(bin, &case.argv);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let _ = sandbox.meter.record();
    let pid = child.id().to_string();
    let mut peak = 0u64;
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if let Ok(output) = Command::new("ps").args(["-o", "rss=", "-p", &pid]).output() {
            if let Ok(value) = String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<u64>()
            {
                peak = peak.max(value * 1024);
            }
        }
        std::thread::sleep(Duration::from_micros(200));
    }
    Ok((peak > 0).then_some(peak))
}

fn time_peak_rss(sandbox: &Sandbox, bin: &Path, argv: &[String]) -> Result<Option<u64>> {
    let macos = cfg!(target_os = "macos");
    let linux = cfg!(target_os = "linux");
    if !(macos || linux) || !Path::new("/usr/bin/time").exists() {
        return Ok(None);
    }
    let mut command = sandbox.command(Path::new("/usr/bin/time"), &[]);
    if macos {
        command.arg("-l");
    } else {
        command.args(["-f", "RSS_KIB=%M"]);
    }
    command.arg(bin).args(argv);
    let output = command.output()?;
    let _ = sandbox.meter.record();
    if !output.status.success() {
        return Ok(None);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let parsed = if macos {
        stderr
            .lines()
            .find_map(|line| line.strip_suffix("  maximum resident set size"))
            .and_then(|value| value.trim().parse::<u64>().ok())
    } else {
        stderr
            .lines()
            .find_map(|line| line.strip_prefix("RSS_KIB="))
            .and_then(|value| value.parse::<u64>().ok())
            .map(|kib| kib * 1024)
    };
    Ok(parsed)
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

struct Comparison {
    ratio: f64,
    delta_percent: f64,
    regressed: bool,
}

fn compare(
    candidate_ms: f64,
    baseline_ms: f64,
    stdout_equal: bool,
    max_regression_percent: f64,
) -> Comparison {
    let ratio = if baseline_ms > 0.0 {
        candidate_ms / baseline_ms
    } else {
        f64::NAN
    };
    let delta_percent = (ratio - 1.0) * 100.0;
    // Ratios are binary floats, so a run sitting exactly on the budget can land
    // a few ULPs above it. Compare with a small tolerance instead of letting
    // representation error decide the gate.
    const SLACK_PERCENT: f64 = 1e-6;
    Comparison {
        ratio,
        delta_percent,
        // A candidate that already failed correctness never reports a speed
        // ratio as a regression; it is reported as `failed` instead.
        regressed: stdout_equal
            && delta_percent.is_finite()
            && delta_percent > max_regression_percent + SLACK_PERCENT,
    }
}

fn outcome(failed: bool, regressed: bool) -> &'static str {
    match (failed, regressed) {
        (true, _) => "failed",
        (false, true) => "regressed",
        (false, false) => "ok",
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn toolchain_versions() -> Value {
    let version_of = |program: &str| -> Value {
        Command::new(program)
            .arg("--version")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| Value::String(String::from_utf8_lossy(&output.stdout).trim().to_string()))
            .unwrap_or(Value::Null)
    };
    json!({
        "rustc": version_of("rustc"),
        "cargo": version_of("cargo"),
    })
}

fn binary_facts(bin: &Path) -> Result<Value> {
    let bytes = std::fs::read(bin).with_context(|| format!("failed to read {}", bin.display()))?;
    Ok(json!({
        "path": bin.display().to_string(),
        "size_bytes": bytes.len(),
        "sha256": fingerprint(&bytes),
    }))
}

fn main() -> Result<()> {
    let args = parse_args(std::env::args().skip(1))?;
    let bin = args
        .bin
        .canonicalize()
        .with_context(|| format!("--bin {} does not exist", args.bin.display()))?;
    let baseline_bin = args
        .baseline
        .as_ref()
        .map(|path| {
            path.canonicalize()
                .with_context(|| format!("--baseline {} does not exist", path.display()))
        })
        .transpose()?;

    // A recorded JSON baseline is read up front and compared without a second
    // binary; otherwise the live baseline is measured after the candidate.
    let recorded_baseline = args
        .baseline_json
        .as_deref()
        .map(BaselineMedians::from_json)
        .transpose()?;

    let temp = TempDir::new()?;
    let root = temp.path();
    let mut rng = Rng::new(0x5eed_1234_abcd_0001);
    let small = root.join("tokens-1mib.txt");
    let large = root.join("tokens-10mib.txt");
    let tree = root.join("search-tree");
    generate_text(&small, 1_048_576, &mut rng)?;
    generate_text(&large, 10_485_760, &mut rng)?;
    const TREE_FILES: usize = 200;
    generate_tree(&tree, TREE_FILES, 200, &mut rng)?;

    let cases = cases(root, &small, &large, &tree, TREE_FILES);

    let meter = Meter::new();
    let sandbox = Sandbox::new(root, meter);
    let measured = measure_all(&sandbox, &bin, &cases, args.n)?;

    // A live baseline binary runs in its own sandbox and with its own meter, so
    // neither its isolated HOME nor its RSS accounting can mix with the
    // candidate's.
    let baseline_runs = match &baseline_bin {
        Some(path) => Some(measure_all(
            &Sandbox::new(root, Meter::new()),
            path,
            &cases,
            args.n,
        )?),
        None => None,
    };
    let medians = match (recorded_baseline, &baseline_runs, &baseline_bin) {
        (Some(recorded), _, _) => Some(recorded),
        (None, Some(runs), Some(path)) => Some(BaselineMedians {
            label: format!("binary:{}", path.display()),
            medians: cases
                .iter()
                .zip(runs)
                .map(|(case, run)| (case.name.to_string(), median(&run.samples)))
                .collect(),
        }),
        (None, _, _) => None,
    };

    let mut report_cases = Map::new();
    let mut failures: Vec<String> = Vec::new();
    let mut regressions: Vec<String> = Vec::new();
    let mut comparison_rows: Vec<(String, Comparison, f64, f64)> = Vec::new();

    for (index, case) in cases.iter().enumerate() {
        let run = &measured[index];
        let mut entry = stats(&run.samples, case.throughput_bytes);
        entry["correct"] = Value::Bool(true);
        entry["evidence"] = Value::String(run.evidence.clone());
        entry["input_bytes"] = json!(case.input_bytes);
        if !run.cpu_samples.is_empty() {
            entry["cpu_median_ms"] = json!(round3(median(&run.cpu_samples)));
        }
        entry["peak_rss_bytes"] = run.peak_rss_bytes.map_or(Value::Null, |bytes| json!(bytes));
        entry["exit_code"] = run.exit_code.map_or(Value::Null, |code| json!(code));
        entry["argv"] = json!(case.argv);

        let candidate_median = median(&run.samples);
        match medians
            .as_ref()
            .and_then(|m| m.medians.get(case.name).copied())
        {
            Some(baseline_median) => {
                let stdout_equal = match &baseline_runs {
                    Some(runs) => runs[index].stdout == run.stdout,
                    // A recorded JSON carries no stdout, so equality is only
                    // claimed when the candidate passed its own oracle.
                    None => true,
                };
                let comparison = compare(
                    candidate_median,
                    baseline_median,
                    stdout_equal,
                    args.max_regression_percent,
                );
                entry["correct"] = Value::Bool(stdout_equal);
                entry["comparison"] = json!({
                    "baseline_label": medians.as_ref().map(|m| m.label.clone()),
                    "baseline_median_ms": round3(baseline_median),
                    "ratio": round3(comparison.ratio),
                    "delta_percent": round3(comparison.delta_percent),
                    "stdout_equal": stdout_equal,
                    "regressed": comparison.regressed,
                });
                entry["outcome"] = json!(outcome(!stdout_equal, comparison.regressed));
                if !stdout_equal {
                    failures.push(format!("{}: stdout differs from the baseline", case.name));
                } else if comparison.regressed {
                    regressions.push(format!(
                        "{}: {:.1}% slower than the baseline (limit {:.1}%)",
                        case.name, comparison.delta_percent, args.max_regression_percent
                    ));
                }
                comparison_rows.push((
                    case.name.to_string(),
                    comparison,
                    candidate_median,
                    baseline_median,
                ));
            }
            None => {
                entry["comparison"] = Value::Null;
                entry["outcome"] = json!("recorded");
            }
        }
        entry["headline"] = Value::Bool(HEADLINE_CASES.contains(&case.name));
        report_cases.insert(case.name.to_string(), entry);
    }

    let generated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut binaries = Map::new();
    binaries.insert("candidate".into(), binary_facts(&bin)?);
    if let Some(path) = &baseline_bin {
        binaries.insert("baseline".into(), binary_facts(path)?);
    }

    let report = json!({
        "schema_version": SCHEMA_VERSION,
        "tool": "benchmark_regression",
        "generated_at_utc": generated_at,
        "platform": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
            "cpu_count": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        },
        "toolchain": toolchain_versions(),
        "config": {
            "n": args.n,
            "warmups": WARMUPS,
            "max_regression_percent": args.max_regression_percent,
            "headline_cases": HEADLINE_CASES,
            "timing": "parent wall clock from spawn to last stdout byte; process launch included",
            "scope": "real rdsh binary as a subprocess with an isolated HOME/DSH_HOME/XDG environment; no model calls and no credentials",
            "fixtures": {
                "tokens_1mib_bytes": std::fs::metadata(&small)?.len(),
                "tokens_10mib_bytes": std::fs::metadata(&large)?.len(),
                "search_tree_files": TREE_FILES,
                "search_tree_bytes": directory_bytes(&tree)?,
            },
        },
        "binaries": Value::Object(binaries),
        "cases": Value::Object(report_cases),
        "failures": failures,
        "regressions": regressions,
    });

    if let Some(parent) = args.output.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(&args.output, serde_json::to_vec_pretty(&report)?)
        .with_context(|| format!("failed to write {}", args.output.display()))?;

    print_summary(
        &cases,
        &measured,
        medians.as_ref(),
        args.max_regression_percent,
    );

    if !failures.is_empty() {
        eprintln!("\nFAILED correctness:");
        for failure in &failures {
            eprintln!("  - {failure}");
        }
    }
    if !regressions.is_empty() {
        eprintln!("\nFAILED regression gate:");
        for regression in &regressions {
            eprintln!("  - {regression}");
        }
    }
    println!("wrote {}", args.output.display());
    if !failures.is_empty() || !regressions.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}

fn print_summary(
    cases: &[Case],
    measured: &[Measured],
    baseline: Option<&BaselineMedians>,
    limit: f64,
) {
    println!(
        "{:<26} {:>10} {:>10} {:>10} {:>12} {:>9}  outcome",
        "case", "median_ms", "p95_ms", "min_ms", "baseline_ms", "ratio"
    );
    for (case, run) in cases.iter().zip(measured) {
        let median_ms = median(&run.samples);
        let baseline_ms = baseline.and_then(|b| b.medians.get(case.name).copied());
        let (ratio, outcome) = match baseline_ms {
            Some(value) => {
                let ratio = if value > 0.0 {
                    median_ms / value
                } else {
                    f64::NAN
                };
                let delta = (ratio - 1.0) * 100.0;
                (
                    format!("{ratio:.3}"),
                    if delta > limit {
                        format!("REGRESSED +{delta:.1}%")
                    } else {
                        format!("ok {delta:+.1}%")
                    },
                )
            }
            None => ("-".to_string(), "recorded".to_string()),
        };
        println!(
            "{:<26} {:>10.3} {:>10.3} {:>10.3} {:>12} {:>9}  {}",
            case.name,
            median_ms,
            percentile(&run.samples, 0.95),
            percentile(&run.samples, 0.0),
            baseline_ms.map_or("-".to_string(), |v| format!("{v:.3}")),
            ratio,
            outcome
        );
    }
    if let Some(run) = measured.first() {
        if let Some(bytes) = run.peak_rss_bytes {
            println!(
                "peak RSS (--version): {:.1} MiB",
                bytes as f64 / 1_048_576.0
            );
        } else {
            println!("peak RSS (--version): unavailable on this platform");
        }
    }
}

// ---------------------------------------------------------------------------
// Tests (cargo test --example benchmark_regression)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn args_of(argv: &[&str]) -> Result<Args> {
        parse_args(argv.iter().copied())
    }

    #[test]
    fn parser_applies_documented_defaults() {
        let parsed = args_of(&["--bin", "/tmp/rdsh", "--output", "/tmp/out.json"]).unwrap();
        assert_eq!(parsed.n, 15);
        assert_eq!(parsed.max_regression_percent, 10.0);
        assert_eq!(parsed.baseline, None);
        assert_eq!(parsed.baseline_json, None);
        assert_eq!(parsed.output, PathBuf::from("/tmp/out.json"));
    }

    #[test]
    fn parser_rejects_short_or_conflicting_runs() {
        assert!(
            args_of(&["--bin", "/tmp/rdsh"]).is_err(),
            "--output is required"
        );
        assert!(
            args_of(&["--output", "/tmp/out.json"]).is_err(),
            "--bin is required"
        );
        assert!(
            args_of(&["--bin", "/tmp/rdsh", "--output", "/tmp/o", "--n", "4"]).is_err(),
            "--n below the minimum must fail"
        );
        assert!(
            args_of(&["--bin", "/tmp/rdsh", "--output", "/tmp/o", "--n", "abc"]).is_err(),
            "non-numeric --n must fail"
        );
        assert!(
            args_of(&[
                "--bin",
                "/tmp/rdsh",
                "--output",
                "/tmp/o",
                "--baseline",
                "/tmp/b",
                "--baseline-json",
                "/tmp/b.json"
            ])
            .is_err(),
            "both baseline sources must be rejected"
        );
        assert!(args_of(&["--bin", "/tmp/rdsh", "--output", "/tmp/o", "--wat"]).is_err());
        assert!(args_of(&[
            "--bin",
            "/tmp/rdsh",
            "--output",
            "/tmp/o",
            "--max-regression-percent",
            "-1"
        ])
        .is_err());
    }

    #[test]
    fn parser_accepts_the_ci_invocation() {
        let parsed = args_of(&[
            "--bin",
            "./target/release/rdsh",
            "--n",
            "15",
            "--output",
            "/tmp/rdsh-perf.json",
        ])
        .unwrap();
        assert_eq!(parsed.n, 15);
        assert_eq!(parsed.bin, PathBuf::from("./target/release/rdsh"));
    }

    #[test]
    fn p95_uses_nearest_rank_and_keeps_the_last_sample() {
        assert_eq!(percentile(&[1., 2., 3., 4., 5.], 0.95), 5.);
        let samples: Vec<f64> = (1..=20).map(f64::from).collect();
        assert_eq!(percentile(&samples, 0.95), 19.);
        assert_eq!(median(&[5., 1., 3.]), 3.);
        assert_eq!(percentile(&samples, 1.0), 20.);
    }

    #[test]
    fn comparison_gate_respects_the_threshold_and_correctness() {
        let within = compare(110.0, 100.0, true, 10.0);
        assert!(
            !within.regressed,
            "exactly at the limit is not a regression"
        );
        assert!((within.delta_percent - 10.0).abs() < 1e-9);

        let over = compare(121.0, 100.0, true, 10.0);
        assert!(over.regressed);
        assert!(over.delta_percent > 20.9 && over.delta_percent < 21.1);

        let faster = compare(80.0, 100.0, true, 10.0);
        assert!(!faster.regressed);
        assert!((faster.ratio - 0.8).abs() < 1e-9);

        let incorrect = compare(500.0, 100.0, false, 10.0);
        assert!(
            !incorrect.regressed,
            "an incorrect candidate must not be reported as a speed regression"
        );
        assert_eq!(outcome(true, incorrect.regressed), "failed");
        assert_eq!(outcome(false, over.regressed), "regressed");
        assert_eq!(outcome(false, within.regressed), "ok");
    }

    #[test]
    fn tokens_oracle_counts_ascii_bytes_in_quarters() {
        let case = Case {
            name: "tokens_1mib",
            argv: vec![],
            input_bytes: 1_048_576,
            oracle: Oracle::Tokens { bytes: 1_048_576 },
            throughput_bytes: 1_048_576,
        };
        assert_eq!(
            case.validate(b"  262144  /tmp/tokens-1mib.txt\n").unwrap(),
            "tokens=262144"
        );
        assert!(case.validate(b"  262145  /tmp/tokens-1mib.txt\n").is_err());
        assert!(case.validate(b"").is_err());
    }

    #[test]
    fn search_oracle_requires_exactly_one_row_per_needle() {
        let case = Case {
            name: "search_tree_200_files",
            argv: vec![],
            input_bytes: 0,
            oracle: Oracle::Search { hits: 2 },
            throughput_bytes: 0,
        };
        let good =
            b"/tmp/t/d00/f000.txt:regression-needle-0\n/tmp/t/d01/f001.txt:regression-needle-1\n";
        assert_eq!(case.validate(good).unwrap(), "hits=2");
        assert!(case
            .validate(b"/tmp/t/d00/f000.txt:regression-needle-0\n")
            .is_err());
        assert!(
            case.validate(
                b"/tmp/t/d00/f000.txt:regression-needle-0\n/tmp/t/d00/f000.txt:regression-needle-0\n"
            )
            .is_err(),
            "duplicates must fail"
        );
        assert!(case
            .validate(b"/tmp/t/d00/f000.txt:no-marker\n/tmp/t/d01/f001.txt:no-marker\n")
            .is_err());
        // The row count and uniqueness can both hold while a needle is
        // missing: two distinct rows, both for needle 0, never report needle
        // 1. Counting rows alone would record this as correct.
        assert!(
            case.validate(
                b"/tmp/t/d00/f000.txt:regression-needle-0\n/tmp/t/d01/f001.txt:regression-needle-0\n"
            )
            .is_err(),
            "a missing needle must fail even when the row count matches"
        );
        // Conversely, an out-of-range id is not one of the generated needles.
        assert!(
            case.validate(
                b"/tmp/t/d00/f000.txt:regression-needle-0\n/tmp/t/d01/f001.txt:regression-needle-9\n"
            )
            .is_err(),
            "an unexpected needle id must fail"
        );
    }

    #[test]
    fn stable_oracle_rejects_empty_output() {
        let case = Case {
            name: "version_startup",
            argv: vec![],
            input_bytes: 0,
            oracle: Oracle::Stable,
            throughput_bytes: 0,
        };
        assert_eq!(case.validate(b"rdsh 0.3.3\n").unwrap(), "bytes=11");
        assert!(case.validate(b"").is_err());
    }

    #[test]
    fn stats_report_median_p95_and_raw_samples() {
        let values = [4.0, 1.0, 3.0, 2.0, 5.0];
        let value = stats(&values, 1_048_576);
        assert_eq!(value["median_ms"], json!(3.0));
        assert_eq!(value["p95_ms"], json!(5.0));
        assert_eq!(value["min_ms"], json!(1.0));
        assert_eq!(value["max_ms"], json!(5.0));
        assert_eq!(value["samples_ms"].as_array().unwrap().len(), 5);
        assert!(value["throughput_mib_s"].as_f64().unwrap() > 0.0);
        assert_eq!(stats(&values, 0)["throughput_mib_s"], Value::Null);
    }

    #[test]
    fn deterministic_fixtures_repeat_the_same_bytes() {
        let tmp = TempDir::new().unwrap();
        let one = tmp.path().join("a.txt");
        let two = tmp.path().join("b.txt");
        generate_text(&one, 4096, &mut Rng::new(7)).unwrap();
        generate_text(&two, 4096, &mut Rng::new(7)).unwrap();
        let first = std::fs::read(&one).unwrap();
        assert_eq!(first, std::fs::read(&two).unwrap());
        assert!(first.len() >= 4096);
        // A different seed must not reproduce the same fixture.
        generate_text(&two, 4096, &mut Rng::new(8)).unwrap();
        assert_ne!(first, std::fs::read(&two).unwrap());
        assert_eq!(fingerprint(b"rdsh").len(), 64);
    }

    #[test]
    fn baseline_json_of_another_schema_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("baseline.json");
        std::fs::write(
            &path,
            br#"{"schema_version":999,"cases":{"version_startup":{"median_ms":1.0}}}"#,
        )
        .unwrap();
        assert!(BaselineMedians::from_json(&path).is_err());

        std::fs::write(
            &path,
            br#"{"schema_version":1,"cases":{"version_startup":{"median_ms":1.5}}}"#,
        )
        .unwrap();
        let loaded = BaselineMedians::from_json(&path).unwrap();
        assert_eq!(loaded.medians.get("version_startup"), Some(&1.5));

        std::fs::write(&path, b"not json").unwrap();
        assert!(BaselineMedians::from_json(&path).is_err());
    }

    /// A baseline missing a usable median must be refused rather than quietly
    /// dropping that case from the comparison, which would let the gate report
    /// success while checking nothing.
    #[test]
    fn baseline_json_without_a_usable_median_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("baseline.json");
        for (label, json) in [
            (
                "missing median_ms",
                br#"{"schema_version":1,"cases":{"version_startup":{}}}"#.as_slice(),
            ),
            (
                "null median_ms",
                br#"{"schema_version":1,"cases":{"version_startup":{"median_ms":null}}}"#
                    .as_slice(),
            ),
            (
                "string median_ms",
                br#"{"schema_version":1,"cases":{"version_startup":{"median_ms":"1.0"}}}"#
                    .as_slice(),
            ),
            (
                "zero median_ms",
                br#"{"schema_version":1,"cases":{"version_startup":{"median_ms":0.0}}}"#.as_slice(),
            ),
            (
                "negative median_ms",
                br#"{"schema_version":1,"cases":{"version_startup":{"median_ms":-1.0}}}"#
                    .as_slice(),
            ),
            (
                "empty cases",
                br#"{"schema_version":1,"cases":{}}"#.as_slice(),
            ),
        ] {
            std::fs::write(&path, json).unwrap();
            assert!(
                BaselineMedians::from_json(&path).is_err(),
                "{label} should be refused"
            );
        }
    }

    #[test]
    fn headline_cases_are_all_produced_by_the_case_table() {
        // The gate can only apply to cases the runner actually measures.
        for name in HEADLINE_CASES {
            assert!([
                "version_startup",
                "tokens_1mib",
                "tokens_10mib",
                "search_tree_200_files"
            ]
            .contains(&name));
        }
        assert_eq!(HEADLINE_CASES.len(), 4);
    }

    #[test]
    fn sandbox_scrubs_the_environment() {
        let tmp = TempDir::new().unwrap();
        std::env::set_var("RDSH_LEAK_CANARY", "1");
        let sandbox = Sandbox::new(tmp.path(), Meter::new());
        let command = sandbox.command(Path::new("/bin/true"), &[]);
        let scrubbed = !command
            .get_envs()
            .any(|(key, _)| key == std::ffi::OsStr::new("RDSH_LEAK_CANARY"));
        assert!(
            scrubbed,
            "sandboxed processes must not inherit the caller env"
        );
        std::env::remove_var("RDSH_LEAK_CANARY");
    }

    #[test]
    fn meter_tracks_spawned_children() {
        let meter = Meter::new();
        let sandbox = Sandbox::new(&std::env::temp_dir(), meter.clone());
        let argv = vec!["-n".to_string(), "1".to_string(), "1".to_string()];
        if let Ok(run) = invoke(&sandbox, Path::new("/bin/sleep"), &argv) {
            assert!(run.elapsed_ms > 0.0);
            if cfg!(unix) {
                assert!(
                    run.elapsed_cpu_ms.is_some(),
                    "getrusage(RUSAGE_CHILDREN) should account for the child"
                );
            }
        }
    }
}
