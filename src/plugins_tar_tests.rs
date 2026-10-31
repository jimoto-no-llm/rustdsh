use super::*;
use flate2::write::GzEncoder;
use flate2::Compression;

/// One 512-byte ustar header.
fn header(name: &str, kind: u8, size: u64, mode: u32) -> [u8; BLOCK] {
    let mut block = [0u8; BLOCK];
    let name_bytes = name.as_bytes();
    let n = name_bytes.len().min(100);
    block[..n].copy_from_slice(&name_bytes[..n]);
    block[100..108].copy_from_slice(format!("{mode:07o}\0").as_bytes());
    block[108..116].copy_from_slice(b"0000000\0");
    block[116..124].copy_from_slice(b"0000000\0");
    block[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
    block[136..148].copy_from_slice(b"00000000000\0");
    block[148..156].copy_from_slice(b"        ");
    block[156] = kind;
    block[257..263].copy_from_slice(b"ustar\0");
    block[263..265].copy_from_slice(b"00");
    let sum: u32 = block.iter().map(|byte| u32::from(*byte)).sum();
    block[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    block
}

/// Builds a gzip-compressed tar in memory (shared with the release tests).
#[derive(Default)]
pub(crate) struct Builder(Vec<u8>);

impl Builder {
    pub(crate) fn entry(mut self, name: &str, kind: u8, data: &[u8], mode: u32) -> Self {
        self.0
            .extend_from_slice(&header(name, kind, data.len() as u64, mode));
        self.0.extend_from_slice(data);
        let pad = (BLOCK - data.len() % BLOCK) % BLOCK;
        self.0.extend(std::iter::repeat_n(0u8, pad));
        self
    }
    pub(crate) fn file(self, name: &str, data: &[u8]) -> Self {
        self.entry(name, b'0', data, 0o644)
    }
    pub(crate) fn dir(self, name: &str) -> Self {
        self.entry(name, b'5', b"", 0o755)
    }
    pub(crate) fn finish(mut self) -> Vec<u8> {
        self.0.extend(std::iter::repeat_n(0u8, BLOCK * 2));
        let mut gz = GzEncoder::new(Vec::new(), Compression::fast());
        gz.write_all(&self.0).unwrap();
        gz.finish().unwrap()
    }
}

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("rdsh-tar-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn limits() -> Limits {
    Limits {
        max_entries: 100,
        max_file_bytes: 1024,
        max_total_bytes: 4096,
    }
}

fn refused(archive: Vec<u8>, label: &str) -> String {
    let dest = scratch(label);
    let error = unpack_gz(&archive, &dest, limits()).unwrap_err();
    let _ = std::fs::remove_dir_all(&dest);
    format!("{error:#}")
}

#[test]
fn a_plain_plugins_tree_is_extracted() {
    let dest = scratch("ok");
    let archive = Builder::default()
        .dir("plugins/")
        .dir("plugins/rdsh-settings/")
        .file(
            "plugins/rdsh-settings/package.json",
            b"{\"name\":\"rdsh-settings\"}",
        )
        .entry("plugins/install.sh", b'0', b"#!/bin/sh\n", 0o755)
        .finish();
    let stats = unpack_gz(&archive, &dest, limits()).unwrap();
    assert_eq!((stats.files, stats.dirs), (2, 2));
    assert_eq!(
        std::fs::read_to_string(dest.join("plugins/rdsh-settings/package.json")).unwrap(),
        "{\"name\":\"rdsh-settings\"}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &str| {
            std::fs::metadata(dest.join(p))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode("plugins/install.sh"), 0o755);
        assert_eq!(mode("plugins/rdsh-settings/package.json"), 0o644);
    }
    let _ = std::fs::remove_dir_all(&dest);
}

#[test]
fn a_gnu_long_name_and_a_ustar_prefix_are_honoured() {
    let dest = scratch("long");
    let long = format!("plugins/{}/file.txt", "d".repeat(120));
    let mut data = long.clone().into_bytes();
    data.push(0);
    let archive = Builder::default()
        .entry("././@LongLink", b'L', &data, 0o644)
        .file("truncated-by-the-100-byte-field", b"x")
        .finish();
    unpack_gz(&archive, &dest, limits()).unwrap();
    assert!(dest.join(&long).is_file());
    let _ = std::fs::remove_dir_all(&dest);
}

#[test]
fn parent_directory_and_absolute_names_are_refused() {
    for (label, name) in [
        ("dotdot", "plugins/../evil"),
        ("dotdot-first", "../plugins/evil"),
        ("absolute", "/etc/passwd"),
        ("outside", "other/file"),
        ("backslash", "plugins\\evil"),
        ("drive", "plugins/C:/evil"),
        ("empty-root", "evil"),
    ] {
        let message = refused(Builder::default().file(name, b"x").finish(), label);
        assert!(!message.is_empty(), "{name} was accepted");
    }
}

#[test]
fn links_devices_and_fifos_are_refused() {
    for (label, kind) in [
        ("hard", b'1'),
        ("sym", b'2'),
        ("chr", b'3'),
        ("blk", b'4'),
        ("fifo", b'6'),
    ] {
        let message = refused(
            Builder::default()
                .entry("plugins/x", kind, b"", 0o777)
                .finish(),
            label,
        );
        assert!(
            message.contains("link") || message.contains("device"),
            "{label}: {message}"
        );
    }
}

#[test]
fn nothing_is_written_when_a_symlink_precedes_a_file_through_it() {
    // The classic attack: a symlink entry, then a file below it. The symlink is
    // refused before any later entry is looked at.
    let dest = scratch("symlink-chain");
    let outside = scratch("symlink-outside");
    let archive = Builder::default()
        .entry("plugins/link", b'2', b"", 0o777)
        .file("plugins/link/pwned", b"x")
        .finish();
    assert!(unpack_gz(&archive, &dest, limits()).is_err());
    assert!(!outside.join("pwned").exists());
    assert!(!dest.join("plugins/link").exists());
    let _ = std::fs::remove_dir_all(&dest);
    let _ = std::fs::remove_dir_all(&outside);
}

#[test]
fn oversized_and_overflowing_archives_are_refused() {
    let big = vec![b'a'; 2048];
    let message = refused(Builder::default().file("plugins/big", &big).finish(), "big");
    assert!(message.contains("larger than"), "{message}");

    let chunk = vec![b'a'; 1000];
    let mut builder = Builder::default();
    for index in 0..6 {
        builder = builder.file(&format!("plugins/f{index}"), &chunk);
    }
    let message = refused(builder.finish(), "total");
    assert!(message.contains("unpacks past"), "{message}");
}

#[test]
fn the_decompressed_stream_is_capped() {
    // 40 MB of zeros compress to a few KB; the cap fails the read instead of
    // letting it end quietly.
    let mut gz = GzEncoder::new(Vec::new(), Compression::fast());
    gz.write_all(&vec![0u8; 40 * 1024 * 1024]).unwrap();
    let archive = gz.finish().unwrap();
    assert!(archive.len() < 1024 * 1024);
    let mut capped = Capped {
        inner: GzDecoder::new(&archive[..]),
        left: 1024 * 1024,
    };
    let mut sink = Vec::new();
    let error = capped.read_to_end(&mut sink).unwrap_err();
    assert!(error.to_string().contains("size limit"), "{error}");
}

#[test]
fn duplicate_entries_and_too_many_entries_are_refused() {
    let message = refused(
        Builder::default()
            .file("plugins/a", b"1")
            .file("plugins/a", b"2")
            .finish(),
        "dup",
    );
    assert!(message.contains("could not create"), "{message}");

    let mut builder = Builder::default();
    for index in 0..101 {
        builder = builder.file(&format!("plugins/f{index}"), b"x");
    }
    let message = refused(builder.finish(), "many");
    assert!(message.contains("too many"), "{message}");
}

#[test]
fn corrupt_headers_and_truncated_archives_are_refused() {
    let mut raw = Builder::default().file("plugins/a", b"hello").0;
    raw[10] ^= 0xff; // break the name; the checksum no longer matches
    let mut gz = GzEncoder::new(Vec::new(), Compression::fast());
    gz.write_all(&raw).unwrap();
    let message = refused(gz.finish().unwrap(), "checksum");
    assert!(message.contains("checksum"), "{message}");

    let good = Builder::default().file("plugins/a", &[b'z'; 900]).finish();
    let cut = good[..good.len() / 2].to_vec();
    assert!(!refused(cut, "truncated").is_empty());

    assert!(!refused(b"not a gzip".to_vec(), "garbage").is_empty());
    assert!(!refused(Builder::default().finish(), "empty").is_empty());
}

#[test]
fn safe_relative_path_normalises_harmless_names() {
    assert_eq!(
        safe_relative_path("plugins//a/./b/").unwrap(),
        PathBuf::from("plugins").join("a").join("b")
    );
    assert!(safe_relative_path("plugins").is_ok());
    assert!(safe_relative_path("").is_err());
    assert!(safe_relative_path("plugins/a\0b").is_err());
}
