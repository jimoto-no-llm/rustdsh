"""Tests for the Homebrew, Scoop and winget manifests (offline, no GitHub access).

The schemas themselves are not vendored, so these tests cover what the
repository can prove on its own: the committed files are exactly what
scripts/update-packaging-manifests.py renders from the pinned digest registries,
and every pinned URL and SHA-256 in them agrees with release-digests.tsv and
release-digests-windows.tsv.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "update-packaging-manifests.py"
_spec = importlib.util.spec_from_file_location("update_packaging_manifests", SCRIPT)
update_packaging_manifests = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(update_packaging_manifests)

HOMEBREW = ROOT / "packaging" / "homebrew" / "rdsh.rb"
SCOOP = ROOT / "packaging" / "scoop" / "rdsh.json"
WINGET = ROOT / "packaging" / "winget"
PACKAGE_ID = update_packaging_manifests.PACKAGE_ID
MANIFESTS = (
    WINGET / f"{PACKAGE_ID}.yaml",
    WINGET / f"{PACKAGE_ID}.installer.yaml",
    WINGET / f"{PACKAGE_ID}.locale.en-US.yaml",
)
HEX64 = re.compile(r"^[0-9a-f]{64}$")
FORMULA_PAIR = re.compile(r'url "([^"]+)"\n\s*sha256 "([0-9a-f]{64})"')
SYNTHETIC_TAG = "v9.9.9"


def synthetic_registry(assets):
    rows = ["latest " + SYNTHETIC_TAG, SYNTHETIC_TAG + " " + assets[0] + " " + "1" * 64]
    for index, asset in enumerate(assets[1:], start=2):
        rows.append(SYNTHETIC_TAG + " " + asset + " " + (str(index) * 64))
    return "\n".join(rows) + "\n"


class ManifestSyncTest(unittest.TestCase):
    def test_committed_manifests_match_the_generator(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--check"],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("up to date", result.stdout)

    def test_scoop_manifest_matches_the_windows_registry(self):
        manifest = json.loads(SCOOP.read_text(encoding="utf-8"))
        tag = "v" + manifest["version"]
        _latest, windows = update_packaging_manifests.read_registry(
            ROOT, update_packaging_manifests.WINDOWS_REGISTRY
        )
        expected = windows[tag][update_packaging_manifests.WINDOWS_ASSET]
        entry = manifest["architecture"]["64bit"]
        self.assertEqual(entry["url"], update_packaging_manifests.asset_url(
            tag, update_packaging_manifests.WINDOWS_ASSET))
        self.assertEqual(entry["hash"], expected)
        self.assertRegex(entry["hash"], HEX64)
        self.assertEqual(manifest["bin"], "rdsh.exe")
        self.assertEqual(manifest["autoupdate"]["hash"]["url"],
                         "$baseurl/" + update_packaging_manifests.WINDOWS_ASSET + ".sha256")

    def test_homebrew_formula_matches_the_macos_registry(self):
        text = HOMEBREW.read_text(encoding="utf-8")
        version = re.search(r'^  version "([^"]+)"$', text, re.MULTILINE)
        self.assertIsNotNone(version)
        tag = "v" + version.group(1)
        _latest, unix = update_packaging_manifests.read_registry(
            ROOT, update_packaging_manifests.UNIX_REGISTRY
        )
        pairs = FORMULA_PAIR.findall(text)
        self.assertEqual(len(pairs), 2, "the formula must pin both macOS archives")
        for url, sha256 in pairs:
            asset = url.rsplit("/", 1)[1]
            self.assertIn(asset, update_packaging_manifests.MAC_ASSETS)
            self.assertEqual(url, update_packaging_manifests.asset_url(tag, asset))
            self.assertEqual(sha256, unix[tag][asset])
        self.assertIn('bin.install "rdsh"', text)
        self.assertIn("depends_on :macos", text)

    def test_winget_manifests_are_consistent_and_pinned(self):
        texts = {path.name: path.read_text(encoding="utf-8") for path in MANIFESTS}
        for name, text in texts.items():
            values = {}
            for line in text.splitlines():
                if not line or line.startswith("#") or line.startswith(" "):
                    continue
                key, _, value = line.partition(":")
                values[key.strip()] = value.strip().strip('"')
            self.assertEqual(values["PackageIdentifier"], PACKAGE_ID, name)
            self.assertEqual(values["ManifestVersion"], "1.6.0", name)
            schema = re.search(r"^\# yaml-language-server: \$schema=\S+\.(\d+\.\d+\.\d+)\.schema\.json$",
                               text, re.MULTILINE)
            self.assertIsNotNone(schema, name)
            self.assertEqual(schema.group(1), values["ManifestVersion"], name)

        installer = texts[f"{PACKAGE_ID}.installer.yaml"]
        versions = {
            name: re.search(r"^PackageVersion: (\S+)$", text, re.MULTILINE).group(1)
            for name, text in texts.items()
        }
        self.assertEqual(len(set(versions.values())), 1, versions)
        tag = "v" + next(iter(versions.values()))
        _latest, windows = update_packaging_manifests.read_registry(
            ROOT, update_packaging_manifests.WINDOWS_REGISTRY
        )
        self.assertEqual(
            re.search(r"^\s+InstallerUrl: (\S+)$", installer, re.MULTILINE).group(1),
            update_packaging_manifests.asset_url(tag, update_packaging_manifests.WINDOWS_ASSET),
        )
        digest = re.search(r"^\s+InstallerSha256: ([0-9A-F]{64})$", installer, re.MULTILINE)
        self.assertIsNotNone(digest, "winget requires an uppercase SHA-256")
        self.assertEqual(
            digest.group(1), windows[tag][update_packaging_manifests.WINDOWS_ASSET].upper()
        )
        self.assertIn("InstallerType: zip", installer)
        self.assertIn("NestedInstallerType: portable", installer)
        self.assertIn("RelativeFilePath: rdsh.exe", installer)
        self.assertIn("PortableCommandAlias: rdsh", installer)

    def test_generator_renders_every_manifest_from_a_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "packaging").mkdir()
            (root / "release-digests.tsv").write_text(
                synthetic_registry(list(update_packaging_manifests.MAC_ASSETS)), encoding="utf-8"
            )
            (root / "release-digests-windows.tsv").write_text(
                synthetic_registry([update_packaging_manifests.WINDOWS_ASSET]), encoding="utf-8"
            )
            (root / "CHANGELOG.md").write_text(
                "# Changelog\n\n## [Unreleased]\n\n## [9.9.9] - 2099-01-02\n", encoding="utf-8"
            )
            first = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(root), "--version", SYNTHETIC_TAG],
                capture_output=True, text=True, cwd=ROOT,
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            written = {
                relative: (root / relative).read_text(encoding="utf-8")
                for relative in update_packaging_manifests.MANIFEST_PATHS
            }
            self.assertEqual(len(written), 5)
            self.assertIn("1" * 64, written[update_packaging_manifests.SCOOP_PATH])
            self.assertIn("2" * 64, written[update_packaging_manifests.HOMEBREW_PATH])
            self.assertIn("1" * 64, written[update_packaging_manifests.HOMEBREW_PATH])
            self.assertIn("2099-01-02", written[
                update_packaging_manifests.WINGET_DIR + "/" + PACKAGE_ID + ".installer.yaml"])

            again = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(root), "--version", SYNTHETIC_TAG],
                capture_output=True, text=True, cwd=ROOT,
            )
            self.assertEqual(again.returncode, 0, again.stderr)
            for relative, text in written.items():
                self.assertEqual((root / relative).read_text(encoding="utf-8"), text)

            check = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(root), "--check",
                 "--version", SYNTHETIC_TAG],
                capture_output=True, text=True, cwd=ROOT,
            )
            self.assertEqual(check.returncode, 0, check.stderr)

    def test_check_reports_a_stale_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "packaging").mkdir()
            (root / "release-digests.tsv").write_text(
                synthetic_registry(list(update_packaging_manifests.MAC_ASSETS)), encoding="utf-8"
            )
            (root / "release-digests-windows.tsv").write_text(
                synthetic_registry([update_packaging_manifests.WINDOWS_ASSET]), encoding="utf-8"
            )
            (root / "CHANGELOG.md").write_text("# Changelog\n", encoding="utf-8")
            check = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(root), "--check",
                 "--version", SYNTHETIC_TAG],
                capture_output=True, text=True, cwd=ROOT,
            )
            self.assertEqual(check.returncode, 1)
            self.assertIn("missing", check.stderr)


if __name__ == "__main__":
    unittest.main()
