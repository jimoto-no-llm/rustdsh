"""Tests for scripts/pin-release-digests.py (offline, no GitHub access)."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "pin-release-digests.py"
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
WINDOWS_DIGEST = "e" * 64
ALL_DIGESTS = dict(DIGESTS, **{pin_release_digests.WINDOWS_ASSET: WINDOWS_DIGEST})
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
WINDOWS_REGISTRY = """# Trusted SHA-256 registry for the windows release archive (install.ps1).
# Regenerate each entry from the published release asset digest; do not copy .sha256 sidecars.
latest v0.3.2
v0.3.2 rdsh-windows-x64.zip {a}
v0.3.1 rdsh-windows-x64.zip {b}
""".format(a="1" * 64, b="2" * 64)


def row(version, asset, digest):
    return f"{version} {asset} {digest}"


def pin_unix(text, tag, digests=ALL_DIGESTS, **kwargs):
    return pin_release_digests.pin(text, tag, digests, **kwargs)


def pin_windows(text, tag, digests=ALL_DIGESTS, **kwargs):
    return pin_release_digests.pin(
        text, tag, digests,
        (pin_release_digests.WINDOWS_ASSET,),
        pin_release_digests.WINDOWS_HEADER,
        **kwargs,
    )


def cli_fixture(directory, windows_text=WINDOWS_REGISTRY):
    unix_path = directory / "unix.tsv"
    windows_path = directory / "windows.tsv"
    unix_path.write_text(REGISTRY, encoding="utf-8")
    windows_path.write_text(windows_text, encoding="utf-8")
    assets = [{"name": name,
               "digest": "sha256:" + hashlib.sha256(f"fixture {name}".encode()).hexdigest()}
              for name in pin_release_digests.ASSETS]
    assets_path = directory / "assets.json"
    assets_path.write_text(json.dumps({"assets": assets}), encoding="utf-8")
    command = [sys.executable, "-B", str(SCRIPT),
               "--registry", str(unix_path), "--windows-registry", str(windows_path),
               "--from-json", str(assets_path)]
    return unix_path, windows_path, assets, command


class PinReleaseDigestsTest(unittest.TestCase):
    def test_pins_new_version_and_moves_latest(self) -> None:
        updated = pin_unix(REGISTRY, "v0.3.3")
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

    def test_windows_ledger_takes_only_the_windows_archive(self) -> None:
        updated = pin_windows(WINDOWS_REGISTRY, "v0.3.3")
        lines = updated.splitlines()
        self.assertEqual(lines[2], "latest v0.3.3")
        self.assertEqual(updated.count("v0.3.3 "), 1)
        self.assertIn(row("v0.3.3", pin_release_digests.WINDOWS_ASSET, WINDOWS_DIGEST), lines)
        # The Windows ledger never carries a Unix row: install.ps1 refuses the
        # whole file for an asset outside rdsh-windows-x64.zip.
        for asset in pin_release_digests.UNIX_ASSETS:
            self.assertNotIn(asset, updated)
        self.assertLess(lines.index(row("v0.3.3", pin_release_digests.WINDOWS_ASSET, WINDOWS_DIGEST)),
                        lines.index(row("v0.3.2", pin_release_digests.WINDOWS_ASSET, "1" * 64)))

    def test_windows_ledger_refuses_a_unix_header(self) -> None:
        with self.assertRaises(SystemExit):
            pin_unix(WINDOWS_REGISTRY, "v0.3.3")

    def test_windows_ledger_requires_the_windows_asset(self) -> None:
        with self.assertRaises(SystemExit):
            pin_windows(WINDOWS_REGISTRY, "v0.3.3", DIGESTS)

    def test_pin_all_updates_both_ledgers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            unix_path = Path(tmp) / pin_release_digests.UNIX_REGISTRY
            windows_path = Path(tmp) / pin_release_digests.WINDOWS_REGISTRY
            unix_path.write_text(REGISTRY, encoding="utf-8")
            windows_path.write_text(WINDOWS_REGISTRY, encoding="utf-8")
            ledgers = ((unix_path, pin_release_digests.UNIX_HEADER, pin_release_digests.UNIX_ASSETS),
                       (windows_path, pin_release_digests.WINDOWS_HEADER,
                        (pin_release_digests.WINDOWS_ASSET,)))
            updates = pin_release_digests.pin_all("v0.3.3", ALL_DIGESTS, ledgers)
            for path, updated, _assets in updates:
                path.write_text(updated, encoding="utf-8")
            unix_text = unix_path.read_text(encoding="utf-8")
            windows_text = windows_path.read_text(encoding="utf-8")
            self.assertEqual(unix_text.count("v0.3.3 "), 4)
            self.assertNotIn(pin_release_digests.WINDOWS_ASSET, unix_text)
            self.assertEqual(windows_text.count("v0.3.3 "), 1)
            self.assertIn("latest v0.3.3", windows_text)

    def test_pin_all_reads_every_ledger_before_writing(self) -> None:
        # A ledger the script cannot read must fail the whole pin, so a partial
        # update never reaches disk.
        with tempfile.TemporaryDirectory() as tmp:
            unix_path = Path(tmp) / "unix.tsv"
            unix_path.write_text(REGISTRY, encoding="utf-8")
            missing = Path(tmp) / "missing.tsv"
            ledgers = ((unix_path, pin_release_digests.UNIX_HEADER, pin_release_digests.UNIX_ASSETS),
                       (missing, pin_release_digests.WINDOWS_HEADER,
                        (pin_release_digests.WINDOWS_ASSET,)))
            with self.assertRaises(FileNotFoundError):
                pin_release_digests.pin_all("v0.3.3", ALL_DIGESTS, ledgers)
            self.assertNotIn("v0.3.3", unix_path.read_text(encoding="utf-8"))

    def test_is_idempotent(self) -> None:
        once = pin_unix(REGISTRY, "v0.3.3")
        twice = pin_unix(once, "v0.3.3")
        self.assertEqual(once, twice)

    def test_replaces_rows_of_the_same_version(self) -> None:
        stale = REGISTRY.replace("latest v0.3.2", "latest v0.3.3").replace("v0.3.2 ", "v0.3.3 ")
        updated = pin_unix(stale, "v0.3.3")
        self.assertEqual(updated.count("v0.3.3 "), 4)
        self.assertNotIn("1" * 64, updated)
        self.assertIn("a" * 64, updated)

    def test_pinning_an_older_release_keeps_latest(self) -> None:
        # R537-LATEST01: re-pinning an older release must only backfill rows.
        pinned = pin_unix(REGISTRY, "v0.3.3")
        backfilled = pin_unix(pinned, "v0.3.2")
        lines = backfilled.splitlines()
        self.assertIn("latest v0.3.3", lines)
        self.assertNotIn("latest v0.3.2", lines)
        self.assertEqual(backfilled.count("v0.3.2 "), 4)
        self.assertIn(row("v0.3.3", "rdsh-linux-x64.tar.gz", "a" * 64), lines)

    def test_pinning_a_newer_release_advances_latest(self) -> None:
        pinned = pin_unix(REGISTRY, "v0.3.3")
        advanced = pin_unix(pinned, "v0.4.0")
        lines = advanced.splitlines()
        self.assertIn("latest v0.4.0", lines)
        self.assertNotIn("latest v0.3.3", lines)
        self.assertEqual(advanced.count("v0.4.0 "), 4)
        self.assertIn(row("v0.3.3", "rdsh-linux-x64.tar.gz", "a" * 64), lines)

    def test_windows_ledger_keeps_its_latest_when_backfilling(self) -> None:
        pinned = pin_windows(WINDOWS_REGISTRY, "v0.3.3")
        backfilled = pin_windows(pinned, "v0.3.2")
        lines = backfilled.splitlines()
        self.assertIn("latest v0.3.3", lines)
        self.assertNotIn("latest v0.3.2", lines)
        self.assertIn(row("v0.3.2", "rdsh-windows-x64.zip", "e" * 64), lines)

    def test_refuses_prerelease_tag(self) -> None:
        with self.assertRaises(ValueError):
            pin_unix(REGISTRY, "v0.3.4-rc.1")

    def test_explicit_candidates_keep_the_stable_latest_in_both_ledgers(self) -> None:
        for phase in ("alpha", "beta", "rc"):
            tag = f"v0.4.0-{phase}.1"
            for text, update, assets in (
                (REGISTRY, pin_unix, pin_release_digests.UNIX_ASSETS),
                (WINDOWS_REGISTRY, pin_windows, (pin_release_digests.WINDOWS_ASSET,)),
            ):
                with self.subTest(tag=tag, assets=assets):
                    result = update(text, tag, allow_prerelease=True)
                    self.assertIn("latest v0.3.2\n", result)
                    self.assertNotIn(f"latest {tag}", result)
                    for asset in assets:
                        self.assertIn(row(tag, asset, ALL_DIGESTS[asset]), result.splitlines())
                    self.assertEqual(result.count(f"{tag} "), len(assets))
                    self.assertEqual(update(result, tag, allow_prerelease=True), result)

    def test_later_stable_pins_preserve_candidates_in_both_ledgers(self) -> None:
        tag = "v0.4.0-rc.10"
        for text, update, assets in (
            (REGISTRY, pin_unix, pin_release_digests.UNIX_ASSETS),
            (WINDOWS_REGISTRY, pin_windows, (pin_release_digests.WINDOWS_ASSET,)),
        ):
            with self.subTest(assets=assets):
                candidate = update(text, tag, allow_prerelease=True)
                stable = update(candidate, "v0.4.0")
                self.assertIn("latest v0.4.0\n", stable)
                for asset in assets:
                    self.assertIn(row(tag, asset, ALL_DIGESTS[asset]), stable.splitlines())
                self.assertEqual(update(stable, "v0.3.2").splitlines()[2], "latest v0.4.0")

    def test_candidate_rows_follow_version_phase_and_numeric_sequence_order(self) -> None:
        updated = REGISTRY
        for tag in ("v0.4.0-rc.2", "v0.4.0-alpha.1", "v0.4.0-rc.10", "v0.4.0-beta.1"):
            updated = pin_unix(updated, tag, allow_prerelease=True)
        updated = pin_unix(updated, "v0.4.0")
        versions = list(dict.fromkeys(line.split()[0] for line in updated.splitlines()[3:]))
        self.assertEqual(versions[:5], ["v0.4.0", "v0.4.0-rc.10", "v0.4.0-rc.2",
                                       "v0.4.0-beta.1", "v0.4.0-alpha.1"])

    def test_candidate_requires_a_complete_existing_stable_latest(self) -> None:
        for text in (
            "\n".join(pin_release_digests.UNIX_HEADER) + "\n",
            REGISTRY.replace("latest v0.3.2", "latest v0.4.0-rc.1"),
            REGISTRY.replace("latest v0.3.2", "latest v0.0.1"),
            REGISTRY.replace(row("v0.3.2", "rdsh-linux-x64.tar.gz", "1" * 64) + "\n", ""),
            REGISTRY.replace("1" * 64, "short"),
        ):
            with self.subTest(text=text), self.assertRaises(SystemExit):
                pin_unix(text, "v0.4.0-rc.1", allow_prerelease=True)

    def test_candidate_tags_must_be_literal_supported_versions(self) -> None:
        for tag in ("v0.4.0-preview.1", "v0.4.0-rc", "v0.4.0-rc.1\n", "v0.4.0-rc.$N"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                pin_unix(REGISTRY, tag, allow_prerelease=True)

    def test_candidate_cli_then_stable_pin_preserves_exact_fixture_digests(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            unix_path, windows_path, assets, command = cli_fixture(Path(tmp))
            candidate = "v0.4.0-rc.1"
            for arguments in ((candidate, "--allow-prerelease"), ("v0.4.0",)):
                result = subprocess.run(command + list(arguments), capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            unix_text = unix_path.read_text(encoding="utf-8")
            windows_text = windows_path.read_text(encoding="utf-8")
            self.assertIn("latest v0.4.0\n", unix_text)
            self.assertIn("latest v0.4.0\n", windows_text)
            for asset in assets:
                text = windows_text if asset["name"] == pin_release_digests.WINDOWS_ASSET else unix_text
                for tag in (candidate, "v0.4.0"):
                    self.assertIn(row(tag, asset["name"], asset["digest"].removeprefix("sha256:")),
                                  text.splitlines())
            self.assertNotIn(pin_release_digests.WINDOWS_ASSET, unix_text)
            for asset in pin_release_digests.UNIX_ASSETS:
                self.assertNotIn(asset, windows_text)

    def test_candidate_cli_dry_run_and_invalid_second_ledger_do_not_write(self) -> None:
        for windows_text, dry_run in ((WINDOWS_REGISTRY, True),
                                     ("\n".join(pin_release_digests.WINDOWS_HEADER) + "\n", False)):
            with self.subTest(dry_run=dry_run), tempfile.TemporaryDirectory() as tmp:
                unix_path, windows_path, _assets, command = cli_fixture(Path(tmp), windows_text)
                before = (unix_path.read_bytes(), windows_path.read_bytes())
                args = ["v0.4.0-rc.1", "--allow-prerelease"] + (["--dry-run"] if dry_run else [])
                result = subprocess.run(command + args, capture_output=True, text=True)
                if dry_run:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("v0.4.0-rc.1", result.stdout)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("stable latest", result.stderr)
                self.assertEqual((unix_path.read_bytes(), windows_path.read_bytes()), before)

    def test_candidate_cli_refuses_each_missing_or_invalid_asset_without_writing(self) -> None:
        for asset_name in pin_release_digests.ASSETS:
            for invalid_digest in (False, True):
                with self.subTest(asset=asset_name, invalid_digest=invalid_digest), \
                        tempfile.TemporaryDirectory() as tmp:
                    directory = Path(tmp)
                    unix_path, windows_path, assets, command = cli_fixture(directory)
                    if invalid_digest:
                        for asset in assets:
                            if asset["name"] == asset_name:
                                asset["digest"] = "sha256:short"
                    else:
                        assets = [asset for asset in assets if asset["name"] != asset_name]
                    (directory / "assets.json").write_text(json.dumps({"assets": assets}), encoding="utf-8")
                    before = (unix_path.read_bytes(), windows_path.read_bytes())
                    result = subprocess.run(command + ["v0.4.0-rc.1", "--allow-prerelease"],
                                            capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("unusable digest" if invalid_digest else "missing required assets",
                                  result.stderr)
                    self.assertEqual((unix_path.read_bytes(), windows_path.read_bytes()), before)

    def test_refuses_missing_assets(self) -> None:
        with self.assertRaises(SystemExit):
            pin_unix(REGISTRY, "v0.3.3", {"rdsh-linux-x64.tar.gz": "a" * 64})

    def test_refuses_unusable_digest(self) -> None:
        broken = dict(ALL_DIGESTS, **{"rdsh-macos-x64.tar.gz": "short"})
        with self.assertRaises(SystemExit):
            pin_unix(REGISTRY, "v0.3.3", broken)

    def test_refuses_changed_header(self) -> None:
        with self.assertRaises(SystemExit):
            pin_unix("# someone rewrote the header\n" + REGISTRY, "v0.3.3")

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
            "rdsh-windows-x64.zip": "e" * 64,
        })


class CheckedInLedgerTest(unittest.TestCase):
    """The split the published installers depend on, asserted on the real files."""

    def test_unix_ledger_keeps_the_published_shape(self) -> None:
        text = (ROOT / pin_release_digests.UNIX_REGISTRY).read_text(encoding="utf-8")
        self.assertEqual(text.splitlines()[:2], list(pin_release_digests.UNIX_HEADER))
        for line in text.splitlines():
            if not line or line.startswith("#") or line.startswith("latest"):
                continue
            _version, asset, digest = line.split()
            self.assertIn(asset, pin_release_digests.UNIX_ASSETS)
            self.assertTrue(pin_release_digests.DIGEST_RE.match(digest))

    def test_windows_ledger_pins_the_windows_asset(self) -> None:
        text = (ROOT / pin_release_digests.WINDOWS_REGISTRY).read_text(encoding="utf-8")
        self.assertEqual(text.splitlines()[:2], list(pin_release_digests.WINDOWS_HEADER))
        rows = [line.split() for line in text.splitlines()
                if line and not line.startswith("#") and not line.startswith("latest")]
        self.assertTrue(rows)
        for _version, asset, digest in rows:
            self.assertEqual(asset, pin_release_digests.WINDOWS_ASSET)
            self.assertTrue(pin_release_digests.DIGEST_RE.match(digest))


if __name__ == "__main__":
    unittest.main()
