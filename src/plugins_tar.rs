//! Safe extraction of the release's `rdsh-plugins.tar.gz`.
//!
//! The archive is a plain tree rooted at `plugins/` (see
//! `scripts/verify-release-assets.py`). Nothing else is accepted: no `..`, no
//! absolute or drive-lettered path, no backslash, no link of any kind, no device
//! or fifo, no duplicate entry, nothing outside `plugins/`. Sizes are capped per
//! file, in total and per entry count, and the decompressed stream is capped too,
//! so a small gzip cannot expand without bound.
//!
//! No `tar` crate is a dependency of rdsh, and the reader below only needs the
//! formats GNU tar (the release workflow) and pax can produce: ustar headers, a
//! GNU long name (`L`) and pax `path`/`size` records.

use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use flate2::read::GzDecoder;

const BLOCK: usize = 512;

/// Ceilings for one extraction.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    pub max_entries: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
}

impl Limits {
    /// The real tree is ~8MB over ~700 entries; these leave generous headroom.
    pub(crate) const RELEASE: Limits = Limits {
        max_entries: 20_000,
        max_file_bytes: 64 * 1024 * 1024,
        max_total_bytes: 256 * 1024 * 1024,
    };
}

/// What an extraction wrote.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Stats {
    pub files: usize,
    pub dirs: usize,
    pub bytes: u64,
}

/// A reader that fails (instead of silently ending) once it has produced more
/// than `left` bytes: the decompression-bomb guard.
struct Capped<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for Capped<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n as u64 > self.left {
            return Err(io::Error::other("the archive expands past its size limit"));
        }
        self.left -= n as u64;
        Ok(n)
    }
}

/// Parse an octal header field (NUL/space padded). The base-256 form GNU tar
/// uses for huge values is refused: nothing here is that large.
fn octal(field: &[u8]) -> Result<u64> {
    ensure!(
        field.first().is_none_or(|byte| byte & 0x80 == 0),
        "unsupported numeric field in a tar header"
    );
    let text: String = field
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as char)
        .collect();
    let text = text.trim();
    if text.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(text, 8).with_context(|| format!("bad number in a tar header: {text:?}"))
}

fn cstr(field: &[u8]) -> String {
    let end = field
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).into_owned()
}

fn checksum_ok(header: &[u8; BLOCK]) -> Result<bool> {
    let stored = octal(&header[148..156])?;
    let sum: u64 = header
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            if (148..156).contains(&index) {
                u64::from(b' ')
            } else {
                u64::from(*byte)
            }
        })
        .sum();
    Ok(sum == stored)
}

/// Turn an archive member name into a safe relative path under `plugins/`.
/// Everything a hostile archive could use to leave the destination is refused.
pub(crate) fn safe_relative_path(name: &str) -> Result<PathBuf> {
    ensure!(!name.is_empty(), "empty entry name");
    ensure!(
        !name.contains(['\0', '\\']) && !name.starts_with('/'),
        "unsafe entry name: {name:?}"
    );
    let mut out = PathBuf::new();
    for part in name.split('/') {
        match part {
            "" | "." => continue,
            ".." => bail!("entry name escapes the destination: {name:?}"),
            // A drive letter or an NTFS stream (`C:`, `a:b`) means something on
            // Windows even though it is an ordinary character on Unix.
            part if part.contains(':') => bail!("unsafe entry name: {name:?}"),
            part => out.push(part),
        }
    }
    let mut components = out.components();
    ensure!(
        matches!(components.next(), Some(Component::Normal(first)) if first == "plugins"),
        "entry is outside plugins/: {name:?}"
    );
    ensure!(
        out.components().all(|c| matches!(c, Component::Normal(_))),
        "unsafe entry name: {name:?}"
    );
    Ok(out)
}

/// `<len> <key>=<value>\n` records of a pax extended header.
fn pax_records(data: &[u8]) -> Vec<(String, String)> {
    let mut records = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        let Some(space) = rest.iter().position(|byte| *byte == b' ') else {
            break;
        };
        let Ok(len) = std::str::from_utf8(&rest[..space])
            .unwrap_or("")
            .parse::<usize>()
        else {
            break;
        };
        if len <= space + 1 || len > rest.len() {
            break;
        }
        let record = &rest[space + 1..len];
        let record = record.strip_suffix(b"\n").unwrap_or(record);
        if let Some(eq) = record.iter().position(|byte| *byte == b'=') {
            records.push((
                String::from_utf8_lossy(&record[..eq]).into_owned(),
                String::from_utf8_lossy(&record[eq + 1..]).into_owned(),
            ));
        }
        rest = &rest[len..];
    }
    records
}

fn read_block(reader: &mut impl Read) -> Result<Option<[u8; BLOCK]>> {
    let mut block = [0u8; BLOCK];
    let mut filled = 0;
    while filled < BLOCK {
        let n = reader.read(&mut block[filled..])?;
        if n == 0 {
            ensure!(filled == 0, "the archive ends in the middle of a block");
            return Ok(None);
        }
        filled += n;
    }
    Ok(Some(block))
}

fn skip(reader: &mut impl Read, mut bytes: u64) -> Result<()> {
    let mut sink = [0u8; 8192];
    while bytes > 0 {
        let want = bytes.min(sink.len() as u64) as usize;
        reader.read_exact(&mut sink[..want])?;
        bytes -= want as u64;
    }
    Ok(())
}

fn padding(size: u64) -> u64 {
    (BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64
}

fn read_small(reader: &mut impl Read, size: u64) -> Result<Vec<u8>> {
    // Names and pax records are tiny; a larger one is hostile or corrupt.
    ensure!(size <= 64 * 1024, "an oversized tar metadata record");
    let mut data = vec![0u8; size as usize];
    reader.read_exact(&mut data)?;
    skip(reader, padding(size))?;
    Ok(data)
}

/// Extract the gzip-compressed tar `bytes` into the (new, empty) directory
/// `dest`. On any error the caller deletes `dest`; nothing here ever writes
/// outside it, and no symlink is ever created, so no earlier entry can redirect
/// a later one.
pub(crate) fn unpack_gz(bytes: &[u8], dest: &Path, limits: Limits) -> Result<Stats> {
    let stream = Capped {
        inner: GzDecoder::new(bytes),
        left: limits
            .max_total_bytes
            .saturating_add(limits.max_entries as u64 * (2 * BLOCK as u64 + 1024)),
    };
    let mut reader = stream;
    let mut stats = Stats::default();
    let mut entries = 0usize;
    let mut long_name: Option<String> = None;
    let mut pax_path: Option<String> = None;
    let mut pax_size: Option<u64> = None;
    let mut zero_blocks = 0;

    while let Some(header) = read_block(&mut reader)? {
        if header.iter().all(|byte| *byte == 0) {
            zero_blocks += 1;
            if zero_blocks == 2 {
                break;
            }
            continue;
        }
        zero_blocks = 0;
        ensure!(checksum_ok(&header)?, "a tar header fails its checksum");
        let kind = header[156];
        let mut size = octal(&header[124..136])?;
        match kind {
            b'L' => {
                let data = read_small(&mut reader, size)?;
                long_name = Some(cstr(&data));
                continue;
            }
            b'x' => {
                for (key, value) in pax_records(&read_small(&mut reader, size)?) {
                    match key.as_str() {
                        "path" => pax_path = Some(value),
                        "size" => pax_size = value.parse().ok(),
                        _ => {}
                    }
                }
                continue;
            }
            b'g' => {
                read_small(&mut reader, size)?;
                continue;
            }
            b'0' | 0 | b'5' => {}
            b'1' | b'2' => bail!("the archive contains a link; refusing"),
            b'3' | b'4' | b'6' => bail!("the archive contains a device or fifo; refusing"),
            other => bail!("unsupported tar entry type {:?}", other as char),
        }
        entries += 1;
        ensure!(
            entries <= limits.max_entries,
            "the archive has too many entries"
        );
        if let Some(pax) = pax_size.take() {
            size = pax;
        }
        let name = if let Some(name) = pax_path.take().or_else(|| long_name.take()) {
            name
        } else {
            let base = cstr(&header[0..100]);
            let is_ustar = &header[257..262] == b"ustar";
            let prefix = if is_ustar {
                cstr(&header[345..500])
            } else {
                String::new()
            };
            if prefix.is_empty() {
                base
            } else {
                format!("{prefix}/{base}")
            }
        };
        long_name = None;
        let relative = safe_relative_path(&name)?;
        let target = dest.join(&relative);

        if kind == b'5' {
            ensure!(size == 0, "a directory entry with content");
            std::fs::create_dir_all(&target)
                .with_context(|| format!("could not create {}", target.display()))?;
            stats.dirs += 1;
            continue;
        }
        ensure!(
            size <= limits.max_file_bytes,
            "{name} is larger than {} bytes",
            limits.max_file_bytes
        );
        ensure!(
            stats.bytes + size <= limits.max_total_bytes,
            "the archive unpacks past {} bytes",
            limits.max_total_bytes
        );
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("could not create {}", parent.display()))?;
        }
        // create_new: a duplicate entry (or one differing only in case on a
        // case-insensitive disk) is an error, never an overwrite.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .with_context(|| format!("could not create {}", target.display()))?;
        let mut left = size;
        let mut buffer = [0u8; 16 * 1024];
        while left > 0 {
            let want = left.min(buffer.len() as u64) as usize;
            reader.read_exact(&mut buffer[..want])?;
            file.write_all(&buffer[..want])?;
            left -= want as u64;
        }
        drop(file);
        skip(&mut reader, padding(size))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Only the executable bit is kept; owner and the rest come from this
            // process, never from the archive.
            let executable = octal(&header[100..108]).unwrap_or(0) & 0o111 != 0;
            let mode = if executable { 0o755 } else { 0o644 };
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode))?;
        }
        stats.files += 1;
        stats.bytes += size;
    }
    ensure!(stats.files > 0, "the archive holds no files");
    Ok(stats)
}

#[cfg(test)]
#[path = "plugins_tar_tests.rs"]
pub(crate) mod tests;
