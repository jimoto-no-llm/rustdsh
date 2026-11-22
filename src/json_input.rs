//! Bounded JSON input-file reader shared by the dashboard CLI ports.
//!
//! Every `--input-file` action reads one JSON document with the former
//! dashboard CLI's `localJson` rules: a regular file only, a size ceiling, Unix
//! `O_CLOEXEC | O_NONBLOCK` so a FIFO swapped into the path cannot block
//! `open`, one bounded `take()` read, strict UTF-8, a stripped BOM and a
//! `serde_json` parse. Only the ceiling and the diagnostics differ between
//! actions, so both are passed in by the caller.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::{anyhow, bail, Result};
use serde_json::Value;

/// The 256 KiB ceiling most `--input-file` actions accept.
pub(crate) const DEFAULT_MAX_BYTES: usize = 256 * 1024;

/// Accepted length and the localized diagnostics one action reports.
pub(crate) struct Limits<'a> {
    /// Accepted length in bytes; `None` reads without a ceiling.
    max_bytes: Option<usize>,
    /// Diagnostic for anything that is not a regular file within the ceiling.
    regular_file: &'a str,
    /// Diagnostic for input that grew past the ceiling after `metadata`.
    exceeds: &'a str,
}

impl<'a> Limits<'a> {
    /// A ceiling of `max_bytes`, plus the texts for both oversize refusals.
    pub(crate) fn capped(max_bytes: usize, regular_file: &'a str, exceeds: &'a str) -> Self {
        Self {
            max_bytes: Some(max_bytes),
            regular_file,
            exceeds,
        }
    }

    /// Regular-file check only: the caller places no ceiling on the input.
    pub(crate) fn regular_file_only(regular_file: &'a str) -> Self {
        Self {
            max_bytes: None,
            regular_file,
            exceeds: regular_file,
        }
    }

    /// Pre-allocation for a file of `length` bytes, bounded by the ceiling.
    fn capacity(&self, length: u64) -> usize {
        let length = usize::try_from(length).unwrap_or(usize::MAX);
        match self.max_bytes {
            Some(max) => length.min(max),
            // Pad LEN is the CLI's own buffer size; without a ceiling the
            // vector may still grow, exactly as the streaming reader did.
            None => length.min(64 * 1024),
        }
    }

    /// The `take()` probe is one byte past the ceiling, so a short read is
    /// reported as oversize rather than truncated.
    fn probe(&self) -> u64 {
        self.max_bytes
            .map_or(u64::MAX, |max| (max as u64).saturating_add(1))
    }

    fn exceeds(&self, length: usize) -> bool {
        self.max_bytes.is_some_and(|max| length > max)
    }
}

/// Open `path` read-only without handing the descriptor to a child process and
/// without blocking on a FIFO that replaced the validated path.
pub(crate) fn open_input(path: &Path) -> std::io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)
    }
    #[cfg(not(unix))]
    {
        File::open(path)
    }
}

/// Refuse anything that is not a regular file within the ceiling.
pub(crate) fn ensure_regular_file(metadata: &std::fs::Metadata, limits: &Limits<'_>) -> Result<()> {
    if !metadata.is_file()
        || limits
            .max_bytes
            .is_some_and(|max| metadata.len() > max as u64)
    {
        bail!(limits.regular_file.to_string());
    }
    Ok(())
}

/// One bounded read of an already-validated handle.
///
/// `context` is attached to I/O failures; callers that report raw `io::Error`s
/// pass `None`.
pub(crate) fn read_bounded(
    reader: impl Read,
    initial_length: usize,
    limits: &Limits<'_>,
    context: Option<&str>,
) -> Result<Vec<u8>> {
    let attached = |error: std::io::Error| match context {
        Some(context) => anyhow::Error::new(error).context(context.to_string()),
        None => anyhow::Error::new(error),
    };
    let mut bytes = Vec::with_capacity(limits.capacity(initial_length as u64));
    reader
        .take(limits.probe())
        .read_to_end(&mut bytes)
        .map_err(attached)?;
    if limits.exceeds(bytes.len()) {
        bail!(limits.exceeds.to_string());
    }
    Ok(bytes)
}

/// Read one JSON document from `path`, attaching `context` to I/O failures and
/// reporting `invalid` for a non-UTF-8 body or a parse failure.
pub(crate) fn read_value(
    path: &Path,
    context: &str,
    limits: &Limits<'_>,
    invalid: &str,
) -> Result<Value> {
    let file =
        open_input(path).map_err(|error| anyhow::Error::new(error).context(context.to_string()))?;
    read_value_from(file, context, limits, invalid)
}

/// Read the bounded bytes of `path`, attaching `context` to I/O failures.
///
/// Callers that deserialize into their own type (and therefore report the
/// parser's own error) use this instead of [`read_value`]. A `None` context
/// keeps the raw `io::Error`, for actions that never localized this failure.
pub(crate) fn read_bytes(
    path: &Path,
    context: Option<&str>,
    limits: &Limits<'_>,
) -> Result<Vec<u8>> {
    let attached = |error: std::io::Error| match context {
        Some(context) => anyhow::Error::new(error).context(context.to_string()),
        None => anyhow::Error::new(error),
    };
    let file = open_input(path).map_err(attached)?;
    let metadata = file.metadata().map_err(attached)?;
    ensure_regular_file(&metadata, limits)?;
    read_bounded(file, metadata.len() as usize, limits, context)
}

/// [`read_value`] for a handle that was already opened, so a path replaced
/// after `open` cannot redirect the read.
pub(crate) fn read_value_from(
    file: File,
    context: &str,
    limits: &Limits<'_>,
    invalid: &str,
) -> Result<Value> {
    let attached = |error: std::io::Error| anyhow::Error::new(error).context(context.to_string());
    let metadata = file.metadata().map_err(attached)?;
    ensure_regular_file(&metadata, limits)?;
    let bytes = read_bounded(file, metadata.len() as usize, limits, Some(context))?;
    let Ok(text) = std::str::from_utf8(&bytes) else {
        bail!(invalid.to_string());
    };
    // `TextDecoder("utf-8")` in the dashboard CLI removed a leading BOM.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    serde_json::from_str(text).map_err(|_| anyhow!(invalid.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const INVALID: &str = "Input JSON is invalid";

    fn limits() -> Limits<'static> {
        Limits::capped(DEFAULT_MAX_BYTES, "must be a regular file", "exceeds")
    }

    fn fixture(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "rdsh-json-input-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn read_value_uses_the_open_file_if_its_path_is_replaced() {
        let root = fixture("replaced");
        let path = root.join("input.json");
        std::fs::write(&path, r#"{"operation":"schema","state":{"tasks":[]}}"#).unwrap();
        let file = open_input(&path).unwrap();
        std::fs::rename(&path, root.join("opened.json")).unwrap();
        std::fs::write(&path, "not the validated input").unwrap();

        let parsed = read_value_from(file, "context", &limits(), INVALID).unwrap();
        assert_eq!(parsed["operation"], "schema");
        assert_eq!(parsed["state"]["tasks"], json!([]));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_value_strips_a_leading_bom_and_requires_utf8() {
        let root = fixture("bom");
        let path = root.join("input.json");
        std::fs::write(&path, b"\xef\xbb\xbf{\"a\":1}").unwrap();
        assert_eq!(
            read_value(&path, "context", &limits(), INVALID).unwrap()["a"],
            json!(1)
        );

        std::fs::write(&path, [0xff]).unwrap();
        let error = read_value(&path, "context", &limits(), INVALID).unwrap_err();
        assert_eq!(error.to_string(), INVALID);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_value_refuses_directories_and_input_past_the_ceiling() {
        let root = fixture("bounds");
        let error = read_value(&root, "context", &limits(), INVALID).unwrap_err();
        assert_eq!(error.to_string(), "must be a regular file");

        let path = root.join("large.json");
        std::fs::write(&path, vec![b' '; DEFAULT_MAX_BYTES + 1]).unwrap();
        let error = read_value(&path, "context", &limits(), INVALID).unwrap_err();
        assert_eq!(error.to_string(), "must be a regular file");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_bounded_stops_when_the_input_grows_after_metadata() {
        struct GrowingInput(usize);
        impl Read for GrowingInput {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                self.0 += bytes.len();
                Ok(bytes.len())
            }
        }

        let limits = Limits::capped(8, "must be a regular file", "exceeds");
        let mut reader = GrowingInput(0);
        let error = read_bounded(&mut reader, 0, &limits, None).unwrap_err();
        assert_eq!(error.to_string(), "exceeds");
        assert_eq!(reader.0, 9);
    }
}
