//! Precompressed cache for the DSH web shell assets.
//!
//! The DSH web frontend ships a dist/assets tree of text bundles. Serving them
//! through the webserver costs CPU (Node gzip) and bytes (gzip is bigger than
//! brotli). This module pays that cost once, at rdsh start-up, off the request
//! path:
//!
//! 1. Walk the assets directory recursively.
//! 2. Derive a fingerprint (docs/webui-asset-cache.md section 1): the literal
//!    "v1", a NUL, the brotli quality, a NUL, the gzip level and a NUL,
//!    followed by relpath NUL size NUL mtime_ns LF for every file sorted by
//!    relative path; SHA-256 that byte string and keep the first 16 hex chars.
//! 3. Look for $DSH_HOME/webui/assets/<fingerprint>/manifest.json. When it
//!    exists the cache is current and nothing is rebuilt, so warm start-ups pay
//!    only a directory walk.
//! 4. Otherwise compress every text asset with brotli q11 and gzip level 6 in
//!    parallel (min of cpu count and file count threads), mirror the source
//!    subdirectory layout, and write manifest.json last.
//!
//! The caller passes the returned directory to DSH as RDSH_WEB_ASSETS
//! (contract section 4); the plugins/rdsh-web-cache server plugin then serves
//! those files with content-encoding br, an ETag and immutable caching.
//!
//! Failure policy (contract section 6): every error path returns None. A missing
//! cache only costs the optimization; start-up and rendering must never break
//! because of it.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

/// Feature id gating the whole cache (`features.web_assets` in rdsh.json).
pub const FEATURE_ID: &str = "web_assets";

/// Brotli quality for the one-time, off-path compression. q11 is the smallest
/// static encoding and is affordable precisely because it is cached on disk.
pub const BROTLI_QUALITY: i32 = 11;

/// gzip fallback level for clients without brotli. Level 6 is the webserver's
/// own tuned level, so the fallback is never a regression.
pub const GZIP_LEVEL: u32 = 6;

/// Bump when the fingerprint input layout changes; old caches then miss.
const FINGERPRINT_VERSION: &str = "v1";
const FINGERPRINT_HEX_CHARS: usize = 16;
const ETAG_HEX_CHARS: usize = 16;
const MANIFEST_NAME: &str = "manifest.json";
const MANIFEST_VERSION: u32 = 1;
/// Cache root below $DSH_HOME.
const CACHE_DIR: &str = "webui/assets";
const BR_EXT: &str = "br";
const GZIP_EXT: &str = "gz";
/// ASCII record separator inside the fingerprint input.
const NUL: u8 = 0;
/// ASCII line feed terminating one file record in the fingerprint input.
const LF: u8 = 0x0a;

/// Extensions worth compressing (contract section 2). Everything else is
/// already compressed (fonts, images) or too small to be worth the bytes.
const COMPRESSIBLE_EXTENSIONS: [&str; 8] =
    ["js", "mjs", "css", "json", "map", "svg", "html", "txt"];

/// Build (or reuse) the precompressed cache and return its absolute path.
///
/// dsh_home is the DSH home directory; assets_dir is the installed
/// <dsh-web-frontend>/dist/assets directory. Returns None when the tree cannot
/// be read, an asset cannot be compressed, or the cache cannot be written: the
/// caller must then launch DSH without RDSH_WEB_ASSETS.
pub fn prepare(dsh_home: &Path, assets_dir: &Path) -> Option<PathBuf> {
    let source = absolute(assets_dir)?;
    let files = scan_assets(&source)?;
    // Nothing to cache. Treat it as a no-op rather than writing an empty cache
    // that would make the plugin claim an empty asset tree.
    if files.is_empty() {
        return None;
    }
    let fingerprint = fingerprint(&files, BROTLI_QUALITY, GZIP_LEVEL);
    let cache_dir = absolute(dsh_home)?.join(CACHE_DIR).join(fingerprint);
    // Contract section 1: an existing manifest means this exact tree was
    // already compressed; do not touch it again.
    if cache_dir.join(MANIFEST_NAME).is_file() {
        return Some(cache_dir);
    }
    build(&source, &files, &cache_dir)?;
    Some(cache_dir)
}

/// One file found under the assets root.
#[derive(Debug, Clone)]
struct SourceFile {
    /// Path relative to the root, slash-separated, used as the manifest key.
    rel_path: String,
    /// The same path as a native PathBuf, used to mirror the layout.
    rel: PathBuf,
    abs_path: PathBuf,
    size: u64,
    mtime_ns: u128,
}

impl SourceFile {
    fn new(root: &Path, abs_path: PathBuf, metadata: &fs::Metadata) -> Option<Self> {
        let rel = abs_path.strip_prefix(root).ok()?.to_path_buf();
        let rel_path = relative_key(&rel)?;
        // A missing or pre-epoch mtime contributes 0. The manifest itself is
        // keyed by the fresh fingerprint, so a changed file can never be served
        // stale by accident; the worst case is one redundant rebuild.
        let mtime_ns = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |since_epoch| since_epoch.as_nanos());
        Some(Self {
            rel_path,
            rel,
            abs_path,
            size: metadata.len(),
            mtime_ns,
        })
    }
}

/// One compressed asset in the manifest (contract section 3).
#[derive(Debug, Clone)]
struct AssetEntry {
    identity: u64,
    br: Option<u64>,
    gzip: Option<u64>,
    etag: String,
}

/// A file queued for compression, derived from a SourceFile.
struct Job {
    rel_path: String,
    rel: PathBuf,
    abs_path: PathBuf,
    compressible: bool,
}

impl Job {
    fn from_source(source: &SourceFile) -> Self {
        Self {
            rel_path: source.rel_path.clone(),
            rel: source.rel.clone(),
            abs_path: source.abs_path.clone(),
            // Zero-byte files stay identity-only: contract section 2.
            compressible: source.size > 0 && is_compressible(&source.rel),
        }
    }
}

/// Walk the asset tree recursively, sorted by manifest key.
///
/// Symlinks are not followed (DirEntry::metadata does not) and are simply left
/// out of the manifest; the server plugin falls back to identity bytes for
/// them, which keeps the safe path intact (contract section 5.3).
fn scan_assets(root: &Path) -> Option<Vec<SourceFile>> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).ok()? {
            let entry = entry.ok()?;
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                files.push(SourceFile::new(root, path, &metadata)?);
            }
        }
    }
    files.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    Some(files)
}

/// Slash-separated path from the assets root, for manifest keys.
fn relative_key(rel: &Path) -> Option<String> {
    let mut key = String::new();
    for component in rel.components() {
        let part = component.as_os_str().to_str()?;
        if !key.is_empty() {
            key.push('/');
        }
        key.push_str(part);
    }
    if key.is_empty() {
        return None;
    }
    Some(key)
}

/// Contract section 1: cache key over the layout plus the compression settings.
fn fingerprint(files: &[SourceFile], brotli_quality: i32, gzip_level: u32) -> String {
    let mut input = Vec::new();
    input.extend_from_slice(FINGERPRINT_VERSION.as_bytes());
    input.push(NUL);
    input.extend_from_slice(brotli_quality.to_string().as_bytes());
    input.push(NUL);
    input.extend_from_slice(gzip_level.to_string().as_bytes());
    input.push(NUL);
    for file in files {
        input.extend_from_slice(file.rel_path.as_bytes());
        input.push(NUL);
        input.extend_from_slice(file.size.to_string().as_bytes());
        input.push(NUL);
        input.extend_from_slice(file.mtime_ns.to_string().as_bytes());
        input.push(LF);
    }
    hex_prefix(&Sha256::digest(&input), FINGERPRINT_HEX_CHARS)
}

/// Lowercase hex of the leading bytes of a digest.
fn hex_prefix(digest: &[u8], hex_chars: usize) -> String {
    digest
        .iter()
        .take(hex_chars / 2)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Text assets are worth compressing; pre-compressed binaries are not.
fn is_compressible(rel: &Path) -> bool {
    let Some(extension) = rel.extension().and_then(|extension| extension.to_str()) else {
        return false;
    };
    COMPRESSIBLE_EXTENSIONS
        .iter()
        .any(|candidate| extension.eq_ignore_ascii_case(candidate))
}

/// Compress everything and write the manifest last, so a crash mid-build can
/// only leave a manifest-less directory that the next start-up rebuilds.
fn build(source: &Path, files: &[SourceFile], cache_dir: &Path) -> Option<()> {
    fs::create_dir_all(cache_dir).ok()?;
    let jobs: Vec<Job> = files.iter().map(Job::from_source).collect();
    let threads = thread_count(jobs.len());
    let next = AtomicUsize::new(0);
    let collected: Vec<Option<Vec<(String, AssetEntry)>>> = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(threads);
        for _ in 0..threads {
            let next = &next;
            let jobs = &jobs;
            handles.push(scope.spawn(move || {
                let mut done = Vec::new();
                while let Some(job) = jobs.get(next.fetch_add(1, Ordering::Relaxed)) {
                    done.push(process_job(job, cache_dir)?);
                }
                Some(done)
            }));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().ok().flatten())
            .collect()
    });

    let mut assets: BTreeMap<String, AssetEntry> = BTreeMap::new();
    for batch in collected {
        for (rel_path, entry) in batch? {
            assets.insert(rel_path, entry);
        }
    }
    if assets.len() != jobs.len() {
        return None;
    }

    let mut manifest_assets = serde_json::Map::new();
    for (rel_path, entry) in &assets {
        manifest_assets.insert(
            rel_path.clone(),
            serde_json::json!({
                "identity": entry.identity,
                "br": entry.br,
                "gzip": entry.gzip,
                "etag": entry.etag,
            }),
        );
    }
    let manifest = serde_json::json!({
        "version": MANIFEST_VERSION,
        "source": source.to_str()?,
        "assets": manifest_assets,
    });
    let bytes = serde_json::to_vec(&manifest).ok()?;
    write_manifest(cache_dir, &bytes)
}

/// Compress one asset and write its .br and .gz products.
fn process_job(job: &Job, cache_dir: &Path) -> Option<(String, AssetEntry)> {
    let bytes = fs::read(&job.abs_path).ok()?;
    let digest = Sha256::digest(&bytes);
    let hex = hex_prefix(&digest, ETAG_HEX_CHARS);
    let quote = '"';
    let etag = format!("{quote}{hex}{quote}");
    let (br, gzip) = if job.compressible && !bytes.is_empty() {
        let brotli_bytes = brotli_compress(&bytes)?;
        let gzip_bytes = gzip_compress(&bytes)?;
        let out = cache_dir.join(&job.rel);
        write_artifact(&out, BR_EXT, &brotli_bytes)?;
        write_artifact(&out, GZIP_EXT, &gzip_bytes)?;
        (
            Some(brotli_bytes.len() as u64),
            Some(gzip_bytes.len() as u64),
        )
    } else {
        (None, None)
    };
    Some((
        job.rel_path.clone(),
        AssetEntry {
            identity: bytes.len() as u64,
            br,
            gzip,
            etag,
        },
    ))
}

/// brotli q11 over a whole in-memory asset.
fn brotli_compress(input: &[u8]) -> Option<Vec<u8>> {
    let params = brotli::enc::BrotliEncoderParams {
        quality: BROTLI_QUALITY,
        ..Default::default()
    };
    let mut out = Vec::new();
    brotli::BrotliCompress(&mut &input[..], &mut out, &params).ok()?;
    Some(out)
}

/// gzip level 6 over a whole in-memory asset.
fn gzip_compress(input: &[u8]) -> Option<Vec<u8>> {
    let mut encoder =
        flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(GZIP_LEVEL));
    encoder.write_all(input).ok()?;
    encoder.finish().ok()
}

/// Write <rel>.<extension> below the cache directory, creating parents.
fn write_artifact(rel_path: &Path, extension: &str, bytes: &[u8]) -> Option<()> {
    let mut out = rel_path.to_path_buf();
    let name = out.file_name()?.to_str()?;
    out.set_file_name(format!("{name}.{extension}"));
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).ok()?;
    }
    fs::write(&out, bytes).ok()?;
    Some(())
}

/// manifest.json is the cache's commit point: write it to a sibling temporary
/// file and rename, so a reader never sees a half-written manifest.
fn write_manifest(cache_dir: &Path, bytes: &[u8]) -> Option<()> {
    let temporary = cache_dir.join(format!(".manifest.json.{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).ok()?;
    let manifest = cache_dir.join(MANIFEST_NAME);
    if fs::rename(&temporary, &manifest).is_err() {
        let _ = fs::remove_file(&temporary);
        return None;
    }
    Some(())
}

/// Contract: threads are the minimum of the cpu count and the file count.
fn thread_count(files: usize) -> usize {
    let cpus = std::thread::available_parallelism().map_or(1, |count| count.get());
    cpus.min(files).max(1)
}

/// Resolve a possibly relative path against the current directory.
fn absolute(path: &Path) -> Option<PathBuf> {
    if path.is_absolute() {
        Some(path.to_path_buf())
    } else {
        std::env::current_dir().ok().map(|cwd| cwd.join(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    /// Self-cleaning scratch directory under the system temp dir.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "rdsh-webui-assets-{}-{sequence}-{tag}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_asset(root: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("asset has a parent")).expect("create parents");
        fs::write(&path, bytes).expect("write asset");
        path
    }

    fn scan_fingerprint(dist: &Path) -> String {
        let files = scan_assets(dist).expect("scan succeeds");
        fingerprint(&files, BROTLI_QUALITY, GZIP_LEVEL)
    }

    fn read_manifest(cache_dir: &Path) -> serde_json::Value {
        let text = fs::read_to_string(cache_dir.join(MANIFEST_NAME)).expect("manifest exists");
        serde_json::from_str(&text).expect("manifest is valid json")
    }

    fn set_mtime(path: &Path, seconds: u64) {
        let file = fs::File::options()
            .write(true)
            .open(path)
            .expect("open asset for times");
        file.set_times(
            fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(seconds)),
        )
        .expect("set asset mtime");
    }

    fn modified(path: &Path) -> std::time::SystemTime {
        fs::metadata(path)
            .expect("metadata")
            .modified()
            .expect("mtime")
    }

    fn etag_for(bytes: &[u8]) -> String {
        let quote = '"';
        let hex = hex_prefix(&Sha256::digest(bytes), ETAG_HEX_CHARS);
        format!("{quote}{hex}{quote}")
    }

    #[test]
    fn missing_dist_returns_none() {
        let tmp = TempDir::new("missing");
        let home = tmp.path.join("home");
        assert_eq!(prepare(&home, &tmp.path.join("does-not-exist")), None);
        assert!(
            !home.exists(),
            "cache must not be created for a missing source"
        );
    }

    #[test]
    fn empty_dist_returns_none() {
        let tmp = TempDir::new("empty");
        let dist = tmp.path.join("assets");
        fs::create_dir_all(&dist).expect("create empty dist");
        assert_eq!(prepare(&tmp.path.join("home"), &dist), None);
    }

    #[test]
    fn fingerprint_tracks_size_and_mtime() {
        let tmp = TempDir::new("fingerprint");
        let dist = tmp.path.join("assets");
        let asset = write_asset(&dist, "index.js", b"console.log(1);");
        set_mtime(&asset, 1_000);
        let initial = scan_fingerprint(&dist);

        // Same mtime, longer content: size is part of the fingerprint.
        fs::write(&asset, b"console.log(11);").expect("rewrite");
        set_mtime(&asset, 1_000);
        let larger = scan_fingerprint(&dist);
        assert_ne!(initial, larger);

        // Same size, different mtime: a content rewrite moves the mtime, and
        // the fingerprint must follow it. (The contract keys on path+size+mtime,
        // not on the bytes themselves.)
        set_mtime(&asset, 2_000);
        let newer = scan_fingerprint(&dist);
        assert_ne!(larger, newer);
    }

    #[test]
    fn fingerprint_hashes_the_contract_encoding() {
        let tmp = TempDir::new("encoding");
        let dist = tmp.path.join("assets");
        write_asset(&dist, "b.css", b"body{}");
        write_asset(&dist, "langs/a.js", b"a()");
        set_mtime(&dist.join("b.css"), 1_500);
        set_mtime(&dist.join("langs/a.js"), 2_500);

        let files = scan_assets(&dist).expect("scan succeeds");
        let keys: Vec<&str> = files.iter().map(|file| file.rel_path.as_str()).collect();
        assert_eq!(keys, vec!["b.css", "langs/a.js"], "sorted by relative path");

        let mut expected = Vec::new();
        expected.extend_from_slice(b"v1");
        expected.push(NUL);
        expected.extend_from_slice(BROTLI_QUALITY.to_string().as_bytes());
        expected.push(NUL);
        expected.extend_from_slice(GZIP_LEVEL.to_string().as_bytes());
        expected.push(NUL);
        for (rel_path, size, mtime_ns) in [
            ("b.css", 6_u64, 1_500_000_000_000_u128),
            ("langs/a.js", 3, 2_500_000_000_000),
        ] {
            expected.extend_from_slice(rel_path.as_bytes());
            expected.push(NUL);
            expected.extend_from_slice(size.to_string().as_bytes());
            expected.push(NUL);
            expected.extend_from_slice(mtime_ns.to_string().as_bytes());
            expected.push(LF);
        }
        let expected = hex_prefix(&Sha256::digest(&expected), FINGERPRINT_HEX_CHARS);
        assert_eq!(expected.len(), FINGERPRINT_HEX_CHARS);
        assert_eq!(fingerprint(&files, BROTLI_QUALITY, GZIP_LEVEL), expected);
    }

    #[test]
    fn fingerprint_changes_with_compression_settings() {
        let tmp = TempDir::new("levels");
        let dist = tmp.path.join("assets");
        write_asset(&dist, "a.js", b"a();");
        let files = scan_assets(&dist).expect("scan succeeds");
        let baseline = fingerprint(&files, BROTLI_QUALITY, GZIP_LEVEL);
        assert_ne!(
            baseline,
            fingerprint(&files, BROTLI_QUALITY - 2, GZIP_LEVEL)
        );
        assert_ne!(
            baseline,
            fingerprint(&files, BROTLI_QUALITY, GZIP_LEVEL - 1)
        );
    }

    #[test]
    fn only_text_assets_are_compressible() {
        for name in [
            "a.js", "a.mjs", "a.css", "a.json", "a.map", "a.svg", "a.html", "a.txt", "A.JS",
        ] {
            assert!(
                is_compressible(Path::new(name)),
                "{name} must be compressed"
            );
        }
        for name in [
            "a.woff2", "a.woff", "a.png", "a.jpg", "a.webp", "a.ico", "a.bin", "asset",
        ] {
            assert!(
                !is_compressible(Path::new(name)),
                "{name} must not be compressed"
            );
        }
    }

    #[test]
    fn warm_start_reuses_the_cache_without_recompressing() {
        let tmp = TempDir::new("warm");
        let dist = tmp.path.join("assets");
        let content = "console.log('warm');".repeat(64);
        write_asset(&dist, "index.js", content.as_bytes());
        let home = tmp.path.join("home");

        let first = prepare(&home, &dist).expect("cold prepare");
        assert!(
            first.is_absolute(),
            "cache path must be absolute: {first:?}"
        );
        let manifest = first.join(MANIFEST_NAME);
        let brotli = first.join("index.js.br");
        let gzip = first.join("index.js.gz");
        for product in [&manifest, &brotli, &gzip] {
            assert!(product.is_file(), "missing product {product:?}");
        }

        // A rebuild would rewrite the products and move their mtimes; the warm
        // path must not touch them at all.
        let marker = UNIX_EPOCH + Duration::from_secs(1_000);
        for product in [&manifest, &brotli, &gzip] {
            set_mtime(product, 1_000);
        }
        let second = prepare(&home, &dist).expect("warm prepare");
        assert_eq!(second, first);
        for product in [&manifest, &brotli, &gzip] {
            assert_eq!(modified(product), marker, "warm start rewrote {product:?}");
        }
    }

    #[test]
    fn cache_directory_without_manifest_is_rebuilt() {
        let tmp = TempDir::new("rebuild");
        let dist = tmp.path.join("assets");
        write_asset(&dist, "index.js", b"rebuild();");
        let home = tmp.path.join("home");
        let cache = prepare(&home, &dist).expect("cold prepare");
        fs::remove_file(cache.join(MANIFEST_NAME)).expect("drop manifest");
        set_mtime(&cache.join("index.js.br"), 1_000);

        let rebuilt = prepare(&home, &dist).expect("rebuild prepare");
        assert_eq!(rebuilt, cache);
        assert!(cache.join(MANIFEST_NAME).is_file());
        assert_ne!(
            modified(&cache.join("index.js.br")),
            UNIX_EPOCH + Duration::from_secs(1_000),
            "the brotli product must be regenerated"
        );
    }

    #[test]
    fn changed_content_builds_a_new_cache_directory() {
        let tmp = TempDir::new("changed");
        let dist = tmp.path.join("assets");
        let asset = write_asset(&dist, "index.js", b"before();");
        set_mtime(&asset, 1_000);
        let home = tmp.path.join("home");
        let first = prepare(&home, &dist).expect("cold prepare");

        fs::write(&asset, b"after();").expect("rewrite");
        set_mtime(&asset, 2_000);
        let second = prepare(&home, &dist).expect("second prepare");
        assert_ne!(
            second, first,
            "a changed asset must land in a new fingerprint directory"
        );
        assert!(second.join(MANIFEST_NAME).is_file());
    }

    #[test]
    fn manifest_matches_the_contract_shape() {
        let tmp = TempDir::new("manifest");
        let dist = tmp.path.join("assets");
        let js = "export const answer = 42;".repeat(20);
        let png = vec![0x89_u8, b'P', b'N', b'G', 0, 1, 2, 3];
        write_asset(&dist, "index-CN7NIWNw.js", js.as_bytes());
        write_asset(&dist, "fonts/KaTeX_Main-Regular-B22Nviop.woff2", &png);
        write_asset(&dist, "empty.txt", b"");

        let cache = prepare(&tmp.path.join("home"), &dist).expect("prepare");
        let manifest = read_manifest(&cache);

        assert_eq!(
            manifest.get("version").and_then(|value| value.as_u64()),
            Some(1)
        );
        assert_eq!(
            manifest.get("source").and_then(|value| value.as_str()),
            dist.to_str()
        );

        let assets = manifest
            .get("assets")
            .and_then(|value| value.as_object())
            .expect("assets map");
        assert_eq!(
            assets.len(),
            3,
            "keys: {:?}",
            assets.keys().collect::<Vec<_>>()
        );

        let js_entry = assets
            .get("index-CN7NIWNw.js")
            .and_then(|value| value.as_object())
            .expect("js entry");
        let mut keys: Vec<&str> = js_entry.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["br", "etag", "gzip", "identity"]);
        assert_eq!(
            js_entry.get("identity").and_then(|value| value.as_u64()),
            Some(js.len() as u64)
        );
        let br_bytes = fs::metadata(cache.join("index-CN7NIWNw.js.br"))
            .expect("brotli product")
            .len();
        let gzip_bytes = fs::metadata(cache.join("index-CN7NIWNw.js.gz"))
            .expect("gzip product")
            .len();
        assert!(br_bytes > 0 && gzip_bytes > 0);
        assert_eq!(
            js_entry.get("br").and_then(|value| value.as_u64()),
            Some(br_bytes)
        );
        assert_eq!(
            js_entry.get("gzip").and_then(|value| value.as_u64()),
            Some(gzip_bytes)
        );
        assert_eq!(
            js_entry.get("etag").and_then(|value| value.as_str()),
            Some(etag_for(js.as_bytes()).as_str())
        );

        // Identity-only assets are still listed, with null products.
        for (key, identity) in [
            ("fonts/KaTeX_Main-Regular-B22Nviop.woff2", png.len() as u64),
            ("empty.txt", 0),
        ] {
            let entry = assets
                .get(key)
                .and_then(|value| value.as_object())
                .expect("identity entry");
            assert_eq!(
                entry.get("identity").and_then(|value| value.as_u64()),
                Some(identity)
            );
            assert!(
                entry.get("br").is_some_and(serde_json::Value::is_null),
                "{key} br must be null"
            );
            assert!(
                entry.get("gzip").is_some_and(serde_json::Value::is_null),
                "{key} gzip must be null"
            );
            assert!(!cache.join(format!("{key}.br")).exists());
            assert!(!cache.join(format!("{key}.gz")).exists());
        }
    }

    #[test]
    fn subdirectory_assets_keep_their_relative_paths() {
        let tmp = TempDir::new("subdir");
        let dist = tmp.path.join("assets");
        write_asset(&dist, "langs/rust-B1yitclQ.js", b"export default 1;");
        let cache = prepare(&tmp.path.join("home"), &dist).expect("prepare");

        let manifest = read_manifest(&cache);
        let assets = manifest
            .get("assets")
            .and_then(|value| value.as_object())
            .expect("assets map");
        assert!(
            assets.contains_key("langs/rust-B1yitclQ.js"),
            "keys: {:?}",
            assets.keys().collect::<Vec<_>>()
        );
        assert!(cache.join("langs/rust-B1yitclQ.js.br").is_file());
        assert!(cache.join("langs/rust-B1yitclQ.js.gz").is_file());
        // The cache mirrors the source tree; it must not flatten it.
        assert!(!cache.join("rust-B1yitclQ.js.br").exists());
    }
}
