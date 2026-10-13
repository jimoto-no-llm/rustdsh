//! Always-on compatibility preload for delegated DSH boots.
//!
//! OpenCode zen endpoints reject requests without the per-conversation
//! `x-opencode-session` header (`400 MissingSessionID`). DSH attaches it only
//! through the built-in `opencode` / `opencode-go` provider wrappers, so any
//! custom pi-ai route that points at an OpenCode endpoint (its own
//! `createProvider` in `@deepseek-ai/dsh-llm-pi-ai`) never gets it. The embedded
//! preload keys the header off the request endpoint instead, so custom routes
//! behave like the built-ins.
//!
//! Set `RDSH_OPENCODE_SESSION_HEADER=0` to opt out.
//!
//! The preload is JavaScript that Node executes as the invoking user, so it must
//! never live at a path another local user can influence. `temp_dir()` is shared
//! on Unix (`/tmp`), where a fixed name can be pre-created as a symlink or
//! swapped between a content check and Node's `--import`. This module therefore
//! writes into a freshly created `0700` directory with an unguessable name and
//! opens the file with `O_CREAT|O_EXCL` (which never follows a symlink).
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const PRELOAD: &str = include_str!("../security/opencode-session-header.mjs");
const FILE_NAME: &str = "opencode-session-header.mjs";
const DIR_ATTEMPTS: usize = 32;

fn enabled() -> bool {
    std::env::var("RDSH_OPENCODE_SESSION_HEADER").map_or(true, |v| v != "0")
}

/// Write the embedded preload into this process's private directory and return
/// the file path. Created at most once per process.
pub fn preload_path() -> Option<PathBuf> {
    if !enabled() {
        return None;
    }
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE.get_or_init(write_preload).clone()
}

/// The `--import` specifier for the preload, or `None` when it is disabled or
/// could not be staged.
///
/// Node resolves `--import` as an ES-module specifier, not as a filesystem path.
/// A raw path breaks outside the happy case: on Windows `C:\...` parses as the
/// URL scheme `c:` (`ERR_UNSUPPORTED_ESM_URL_SCHEME`), and on Unix `#` or `?`
/// starts a fragment or query instead of naming the file.
pub fn import_specifier() -> Option<String> {
    preload_path().map(|path| file_url(&path))
}

fn write_preload() -> Option<PathBuf> {
    let directory = private_directory()?;
    let path = directory.join(FILE_NAME);
    write_new_private_file(&path, PRELOAD).ok()?;
    Some(path)
}

/// Create an empty directory only this user can enter, under a name nobody can
/// predict. `create_dir` fails on an existing entry (including a symlink), so a
/// planted path can never be adopted.
///
/// One directory per `rdsh` process is left behind (a few KiB, removed when the
/// platform clears its temp area). Reusing a fixed path instead is what made the
/// original symlink attack possible.
fn private_directory() -> Option<PathBuf> {
    let base = std::env::temp_dir();
    for _ in 0..DIR_ATTEMPTS {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).ok()?;
        let directory = base.join(format!(
            "rdsh-opencode-preload-{}-{}",
            std::process::id(),
            hex(&nonce)
        ));
        match create_private_directory(&directory) {
            Ok(()) => return Some(directory),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

#[cfg(unix)]
fn create_private_directory(directory: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700);
    builder.create(directory)
}

#[cfg(not(unix))]
fn create_private_directory(directory: &Path) -> std::io::Result<()> {
    std::fs::DirBuilder::new().create(directory)
}

/// Write a file that must not already exist. `create_new` maps to
/// `O_CREAT|O_EXCL`, so a symlink at `path` fails the open instead of being
/// followed.
fn write_new_private_file(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())
}

#[cfg(unix)]
fn file_url(path: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;
    file_url_from_path_bytes(path.as_os_str().as_bytes())
}

#[cfg(not(unix))]
fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    // `\\?\UNC\server\share` is an extended UNC path: strip the verbatim prefix
    // but keep the authority. Plain `\\?\C:\...` just drops the prefix.
    let normalized = if let Some(rest) = text.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = text.strip_prefix("//?/") {
        rest.to_string()
    } else {
        text.clone()
    };
    file_url_from_path_bytes(normalized.as_bytes())
}

/// Encode `/`-separated path bytes as a `file:` URL, percent-encoding every byte
/// that a URL would otherwise interpret. `:` is kept so `C:/...` survives, and a
/// leading `//` is treated as a UNC authority (`//server/share` -> `file://server/share`)
/// rather than a fourth slash.
fn file_url_from_path_bytes(bytes: &[u8]) -> String {
    let mut url = String::with_capacity(bytes.len() + 8);
    match bytes {
        [b'/', b'/', ..] => url.push_str("file:"),
        [b'/', ..] => url.push_str("file://"),
        _ => url.push_str("file:///"),
    }
    for &byte in bytes {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                url.push(char::from(byte))
            }
            _ => url.push_str(&format!("%{byte:02X}")),
        }
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_embedded_preload() {
        std::env::remove_var("RDSH_OPENCODE_SESSION_HEADER");
        let path = preload_path().expect("preload path");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), PRELOAD);
        assert!(PRELOAD.contains("__RDSH_OPENCODE_SESSION_HEADER__"));
        assert!(PRELOAD.contains("x-opencode-session"));
    }

    #[test]
    fn the_preload_never_sits_directly_in_the_shared_temp_root() {
        std::env::remove_var("RDSH_OPENCODE_SESSION_HEADER");
        let path = preload_path().expect("preload path");
        let directory = path.parent().expect("preload directory");
        assert_eq!(path.file_name().unwrap(), FILE_NAME);
        assert_ne!(directory, std::env::temp_dir());
        assert!(directory.starts_with(std::env::temp_dir()));
    }

    #[test]
    fn import_specifier_is_a_file_url_for_the_staged_preload() {
        std::env::remove_var("RDSH_OPENCODE_SESSION_HEADER");
        let specifier = import_specifier().expect("import specifier");
        assert!(
            specifier.starts_with("file:///"),
            "unexpected specifier: {specifier}"
        );
        assert!(specifier.ends_with(FILE_NAME), "unexpected: {specifier}");
    }

    #[cfg(unix)]
    #[test]
    fn preload_directory_and_file_are_private() {
        use std::os::unix::fs::PermissionsExt;
        std::env::remove_var("RDSH_OPENCODE_SESSION_HEADER");
        let path = preload_path().expect("preload path");
        let directory = path.parent().unwrap();
        assert_eq!(
            std::fs::metadata(directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_preexisting_symlink_is_not_followed() {
        use std::os::unix::fs::symlink;
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).unwrap();
        let directory =
            std::env::temp_dir().join(format!("rdsh-preload-link-test-{}", hex(&nonce)));
        create_private_directory(&directory).unwrap();
        let attacker = directory.join("attacker.mjs");
        std::fs::write(&attacker, "// attacker controlled\n").unwrap();
        let planted = directory.join(FILE_NAME);
        symlink(&attacker, &planted).unwrap();

        assert!(write_new_private_file(&planted, PRELOAD).is_err());
        assert_eq!(
            std::fs::read_to_string(&attacker).unwrap(),
            "// attacker controlled\n"
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn node_accepts_the_staged_preload_url() {
        // A real delegated launch. The directory carries a space and `#`, which
        // is exactly what the raw-path form cannot express.
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).unwrap();
        let directory = std::env::temp_dir().join(format!("rdsh preload#{}", hex(&nonce)));
        create_private_directory(&directory).unwrap();
        let path = directory.join(FILE_NAME);
        write_new_private_file(&path, "globalThis.__rdshPreloadRan = 'yes';\n").unwrap();

        let run = std::process::Command::new("node")
            .arg("--import")
            .arg(file_url(&path))
            .arg("--input-type=module")
            .arg("-e")
            .arg("if (globalThis.__rdshPreloadRan !== 'yes') process.exit(3);")
            .output();
        let Ok(output) = run else {
            std::fs::remove_dir_all(&directory).unwrap();
            return; // no Node runtime in this environment
        };
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "node rejected the staged preload URL: {stderr}"
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn file_urls_keep_plain_unix_and_windows_paths_readable() {
        assert_eq!(
            file_url_from_path_bytes(b"/tmp/rdsh-preload/p.mjs"),
            "file:///tmp/rdsh-preload/p.mjs"
        );
        assert_eq!(
            file_url_from_path_bytes(b"C:/Users/alice/AppData/Local/Temp/p.mjs"),
            "file:///C:/Users/alice/AppData/Local/Temp/p.mjs"
        );
    }

    #[test]
    fn file_urls_encode_reserved_characters() {
        // A raw `#`/`?`/space path is what eightman999 reported as broken.
        assert_eq!(
            file_url_from_path_bytes(b"/tmp/a#b?c d/p.mjs"),
            "file:///tmp/a%23b%3Fc%20d/p.mjs"
        );
        assert_eq!(
            file_url_from_path_bytes(b"/tmp/100%/p.mjs"),
            "file:///tmp/100%25/p.mjs"
        );
    }

    #[test]
    fn file_urls_keep_unc_authorities_readable() {
        // `\\server\share` becomes `//server/share`; it must not gain a fourth
        // slash, which the Windows file-URL parser rejects.
        assert_eq!(
            file_url_from_path_bytes(b"//server/share/Temp/p.mjs"),
            "file://server/share/Temp/p.mjs"
        );
    }

    #[cfg(not(unix))]
    #[test]
    fn extended_unc_paths_map_to_a_plain_file_url() {
        assert_eq!(
            file_url(Path::new(r"\\?\UNC\server\share\Temp\p.mjs")),
            "file://server/share/Temp/p.mjs"
        );
        assert_eq!(
            file_url(Path::new(r"\\server\share\Temp\p.mjs")),
            "file://server/share/Temp/p.mjs"
        );
    }
}
