//! SHA-256 helpers shared by the ports that hash bytes, text or JSON.
//!
//! Several CLI paths compare digests: the updater verifies release assets, the
//! tool audit pins delegated entry files, the answer and instruction ports
//! derive ids and fingerprints, and the Web UI asset cache names its products
//! by digest. They all want the same lowercase hex spelling.

use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256 of a byte slice.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// The leading `hex_chars` hexadecimal digits of the SHA-256 of `bytes`.
///
/// `hex_chars` is rounded down to whole bytes, so an odd request yields one
/// digit fewer than asked, exactly like truncating the hex digest.
pub(crate) fn hex_prefix(bytes: &[u8], hex_chars: usize) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(hex_chars / 2)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_the_known_vectors() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn hex_prefix_is_the_truncated_digest() {
        let full = sha256_hex(b"abc");
        assert_eq!(hex_prefix(b"abc", 16), full[..16]);
        assert_eq!(hex_prefix(b"abc", 64), full);
        // Whole bytes only: an odd request stops one digit earlier.
        assert_eq!(hex_prefix(b"abc", 5), full[..4]);
        assert_eq!(hex_prefix(b"abc", 0), "");
    }
}
