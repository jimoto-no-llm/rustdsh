"""Tests for scripts/pin-release-digests.py (offline, no GitHub access)."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "pin-release-digests.py"
_spec = importlib.util.spec_from_file_location("pin_release_digests", SCRIPT)
pin_release_digests = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(pin_release_digests)

DIGESTS = {
    "rdsh-linux-x64.tar.gz": "a" * 64,
    "rdsh-linux-x64-musl.tar.gz": "b" * 64,
    "rdsh-macos-arm64.tar.gz": "c" * 64,
    "rdsh-macos-x64.tar.gz": "d" * 64,
}
REGISTRY = """# Trusted SHA-256 registry for the exact release archives supported by install.sh.
# Regenerate each entry from the published release asset digest; do not copy .sha256 sidecars.
latest v0.3.2
v0.3.2 rdsh-linux-x64.tar.gz {a}
v0.3.2 rdsh-linux-x64-musl.tar.gz {b}
v0.3.2 rdsh-macos-arm64.tar.gz {c}
v0.3.2 rdsh-macos-x64.tar.gz {d}
v0.3.1 rdsh-linux-x64.tar.gz {e}
v0.3.1 rdsh-macos-arm64.tar.gz {f}
v0.3.1 rdsh-macos-x64.tar.gz {g}
""".format(a="1" * 64, b="2" * 64, c="3" * 64, d="4" * 64,
           e="5" * 64, f="6" * 64, g="7" * 64)


def row(version, asset, digest):
    return f"{version} {asset} {digest}"


class PinReleaseDigestsTest(unittest.TestCase):
    def test_pins_new_version_and_moves_latest(self) -> None:
        updated = pin_release_digests.pin(REGISTRY, "v0.3.3", DIGESTS)
        lines = updated.splitlines()
        self.assertEqual(lines[2], "latest v0.3.3")
        self.assertIn(row("v0.3.3", "rdsh-linux-x64.tar.gz", "a" * 64), lines)
        self.assertIn(row("v0.3.3", "rdsh-macos-x64.tar.gz", "d" * 64), lines)
        # Older rows are preserved for explicit --version installs.
        self.assertIn(row("v0.3.2", "rdsh-linux-x64.tar.gz", "1" * 64), lines)
        self.assertIn(row("v0.3.1", "rdsh-macos-x64.tar.gz", "7" * 64), lines)
        # Newest version first, older versions descending.
        self.assertLess(lines.index("latest v0.3.3"),
                        lines.index(row("v0.3.3", "rdsh-linux-x64.tar.gz", "a" * 64)))
        self.assertLess(lines.index(row("v0.3.3", "rdsh-macos-x64.tar.gz", "d" * 64)),
                        lines.index(row("v0.3.2", "rdsh-linux-x64.tar.gz", "1" * 64)))
        self.assertLess(lines.index(row("v0.3.2", "rdsh-macos-x64.tar.gz", "4" * 64)),
                        lines.index(row("v0.3.1", "rdsh-linux-x64.tar.gz", "5" * 64)))
        self.assertEqual(updated.count("v0.3.3 "), 4)
        self.assertTrue(updated.endswith("\n"))

    def test_is_idempotent(self) -> None:
        once = pin_release_digests.pin(REGISTRY, "v0.3.3", DIGESTS)
        twice = pin_release_digests.pin(once, "v0.3.3", DIGESTS)
        self.assertEqual(once, twice)

    def test_replaces_rows_of_the_same_version(self) -> None:
        stale = REGISTRY.replace("latest v0.3.2", "latest v0.3.3").replace("v0.3.2 ", "v0.3.3 ")
        updated = pin_release_digests.pin(stale, "v0.3.3", DIGESTS)
        self.assertEqual(updated.count("v0.3.3 "), 4)
        self.assertNotIn("1" * 64, updated)
        self.assertIn("a" * 64, updated)

    def test_pinning_an_older_release_keeps_latest(self) -> None:
        # R537-LATEST01: re-pinning an older release must only backfill rows.
        pinned = pin_release_digests.pin(REGISTRY, "v0.3.3", DIGESTS)
        backfilled = pin_release_digests.pin(pinned, "v0.3.2", {
            "rdsh-linux-x64.tar.gz": "9" * 64,
            "rdsh-linux-x64-musl.tar.gz": "8" * 64,
            "rdsh-macos-arm64.tar.gz": "7" * 64,
            "rdsh-macos-x64.tar.gz": "6" * 64,
        })
        lines = backfilled.splitlines()
        self.assertIn("latest v0.3.3", lines)
        self.assertNotIn("latest v0.3.2", lines)
        self.assertIn(row("v0.3.2", "rdsh-linux-x64.tar.gz", "9" * 64), lines)
        self.assertIn(row("v0.3.3", "rdsh-linux-x64.tar.gz", "a" * 64), lines)
        self.assertEqual(backfilled.count("v0.3.2 "), 4)

    def test_pinning_a_newer_release_advances_latest(self) -> None:
        pinned = pin_release_digests.pin(REGISTRY, "v0.3.3", DIGESTS)
        advanced = pin_release_digests.pin(pinned, "v0.4.0", DIGESTS)
        lines = advanced.splitlines()
        self.assertIn("latest v0.4.0", lines)
        self.assertNotIn("latest v0.3.3", lines)
        self.assertEqual(advanced.count("v0.4.0 "), 4)
        self.assertIn(row("v0.3.3", "rdsh-linux-x64.tar.gz", "a" * 64), lines)

    def test_refuses_prerelease_tag(self) -> None:
        with self.assertRaises(ValueError):
            pin_release_digests.pin(REGISTRY, "v0.3.4-rc.1", DIGESTS)

    def test_refuses_missing_assets(self) -> None:
        with self.assertRaises(SystemExit):
            pin_release_digests.pin(REGISTRY, "v0.3.3", {"rdsh-linux-x64.tar.gz": "a" * 64})

    def test_refuses_unusable_digest(self) -> None:
        broken = dict(DIGESTS, **{"rdsh-macos-x64.tar.gz": "short"})
        with self.assertRaises(SystemExit):
            pin_release_digests.pin(REGISTRY, "v0.3.3", broken)

    def test_refuses_changed_header(self) -> None:
        with self.assertRaises(SystemExit):
            pin_release_digests.pin("# someone rewrote the header\n" + REGISTRY, "v0.3.3", DIGESTS)

    def test_parses_gh_api_asset_lines(self) -> None:
        lines = [
            "install.sh sha256:" + "9" * 64,
            "rdsh-linux-x64.tar.gz sha256:" + "a" * 64,
            "rdsh-macos-x64.tar.gz sha256:" + "d" * 64,
            "rdsh-windows-x64.zip sha256:" + "e" * 64,
        ]
        parsed = pin_release_digests.parse_asset_lines(lines)
        self.assertEqual(parsed, {
            "rdsh-linux-x64.tar.gz": "a" * 64,
            "rdsh-macos-x64.tar.gz": "d" * 64,
        })


if __name__ == "__main__":
    unittest.main()
