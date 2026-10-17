"""Tests for scripts/prepare-cadence-release.py (offline, no network)."""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


cadence = load("prepare_cadence_release", ROOT / "scripts" / "prepare-cadence-release.py")
release = load("prepare_release", ROOT / "scripts" / "prepare-release.py")

# [Unreleased] に ### Added（利用者に見える追加）がある changelog。minor 判定になる。
MINOR_CHANGELOG = """# Changelog

## [Unreleased]

### Added

- A user-visible feature.

## [1.2.3] - 2026-10-01

### Fixed

- An older change.
"""

# [Unreleased] が修正だけの changelog。patch 判定になる。
PATCH_CHANGELOG = """# Changelog

## [Unreleased]

### Fixed

- A bug fix only.

## [1.2.3] - 2026-10-01

### Fixed

- An older change.
"""

EMPTY_CHANGELOG = ("# Changelog" + chr(10) * 2 + "## [Unreleased]" + chr(10) * 2
                   + "## [1.2.3] - 2026-10-01" + chr(10))


class CadenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "docs" / "releases").mkdir(parents=True)
        (self.root / "Cargo.toml").write_text(
            '[package]' + chr(10) + 'name = "rdsh"' + chr(10) + 'version = "1.2.3"' + chr(10),
            encoding="utf-8")
        (self.root / "Cargo.lock").write_text(
            '[[package]]' + chr(10) + 'name = "rdsh"' + chr(10) + 'version = "1.2.3"' + chr(10),
            encoding="utf-8")
        self.write_changelog(MINOR_CHANGELOG)

    def write_changelog(self, text):
        (self.root / "CHANGELOG.md").write_text(text, encoding="utf-8")

    def init_git_tag(self, tag="v1.2.3"):
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)
        subprocess.run(["git", "-c", "user.name=test", "-c", "user.email=test@example.com",
                        "commit", "-qm", "init"], cwd=self.root, check=True)
        subprocess.run(["git", "tag", tag], cwd=self.root, check=True)

    def test_stable_tags_are_compared_numerically(self):
        tags = ["v0.6.0", "v0.9.0", "v0.10.0", "v0.10.0-rc.1", "v0.2.0", "junk"]
        self.assertEqual(cadence.latest_stable(tags), "v0.10.0")
        self.assertEqual(cadence.next_patch("v0.10.0"), "v0.10.1")
        self.assertEqual(cadence.next_minor("v0.10.0"), "v0.11.0")
        self.assertEqual(cadence.next_major("v0.10.0"), "v1.0.0")
        self.assertEqual(cadence.next_version("v0.6.1", "minor"), "v0.7.0")
        self.assertEqual(cadence.release_branch("v0.10.1"), "release/v0.10.1-prep")
        with self.assertRaises(ValueError):
            cadence.latest_stable(["v0.6.0-rc.1"])
        with self.assertRaises(ValueError):
            cadence.next_version("v0.10.0", "junk")

    def test_unreleased_emptiness(self):
        self.assertFalse(cadence.has_release_content(EMPTY_CHANGELOG))
        self.assertTrue(cadence.has_release_content(MINOR_CHANGELOG))

    def test_added_section_is_detected(self):
        self.assertTrue(cadence.has_added_section(MINOR_CHANGELOG))
        self.assertFalse(cadence.has_added_section(PATCH_CHANGELOG))
        self.assertFalse(cadence.has_added_section(EMPTY_CHANGELOG))

    def test_bump_decision_is_minor_for_added_entries(self):
        bump, reason = cadence.bump_decision(True, ())
        self.assertEqual(bump, "minor")
        self.assertIn("### Added", reason)

    def test_bump_decision_is_patch_for_fix_only(self):
        bump, reason = cadence.bump_decision(False, ())
        self.assertEqual(bump, "patch")
        self.assertIn("feature 系ラベル付きの PR も無いため", reason)

    def test_bump_decision_is_minor_for_feature_labels(self):
        for label in ("feature", "enhancement"):
            self.assertEqual(cadence.bump_decision(False, [label])[0], "minor")
        self.assertEqual(cadence.bump_decision(False, ["docs"])[0], "patch")

    def test_bump_decision_keeps_breaking_minor_while_0_x(self):
        self.assertEqual(cadence.bump_decision(False, ["breaking"], major=0)[0], "minor")
        self.assertEqual(cadence.bump_decision(False, ["breaking"], major=1)[0], "major")

    def test_promote_bumps_every_metadata_file_to_the_minor(self):
        notes = cadence.promote(self.root, "v1.3.0", day="2026-10-17")
        self.assertEqual(notes.name, "v1.3.0.md")
        self.assertIn('version = "1.3.0"', (self.root / "Cargo.toml").read_text(encoding="utf-8"))
        self.assertIn('version = "1.3.0"', (self.root / "Cargo.lock").read_text(encoding="utf-8"))
        changelog = (self.root / "CHANGELOG.md").read_text(encoding="utf-8")
        self.assertIn("## [Unreleased]" + chr(10) * 2 + "## [1.3.0] - 2026-10-17", changelog)
        self.assertIn("## [1.2.3] - 2026-10-01", changelog)
        self.assertNotIn("## [Unreleased]" + chr(10) * 2 + "### Added", changelog)
        self.assertEqual(cadence.changelog_entries(cadence.unreleased_section(MINOR_CHANGELOG)),
                         ["A user-visible feature."])
        body = notes.read_text(encoding="utf-8")
        self.assertIn("<!-- previous-tag: v1.2.3 -->", body)
        self.assertIn("- A user-visible feature.", body)

    def test_promote_records_the_decided_bump_in_the_notes(self):
        body = cadence.promote(self.root, "v1.3.0", day="2026-10-17").read_text(encoding="utf-8")
        self.assertIn("版の判定: minor（[Unreleased] に ### Added", body)
        self.assertIn("<!-- cadence-bump: minor -->", body)

    def test_promote_uses_the_bump_decided_by_plan(self):
        body = cadence.promote(self.root, "v1.2.4", day="2026-10-17", bump="patch",
                               reason="利用者に見える追加が無いため").read_text(encoding="utf-8")
        self.assertIn("版の判定: patch（利用者に見える追加が無いため）", body)
        self.assertIn("<!-- cadence-bump: patch -->", body)

    def test_promoted_tree_passes_release_validation(self):
        cadence.promote(self.root, "v1.3.0", day="2026-10-17")
        release.validate(self.root, "v1.3.0")

    def test_promote_refuses_an_empty_unreleased(self):
        self.write_changelog(EMPTY_CHANGELOG)
        with self.assertRaises(ValueError):
            cadence.promote(self.root, "v1.3.0", day="2026-10-17")

    def test_promote_refuses_a_mismatched_previous_tag(self):
        with self.assertRaises(ValueError):
            cadence.promote(self.root, "v1.3.0", previous="v1.1.0", day="2026-10-17")

    @unittest.skipUnless(shutil.which("git"), "git is required")
    def test_plan_uses_the_minor_bump_for_added_entries(self):
        self.init_git_tag()
        output = self.root / "github-output.txt"
        values = cadence.plan(self.root, output)
        self.assertEqual(values["latest"], "v1.2.3")
        self.assertEqual(values["next"], "v1.3.0")
        self.assertEqual(values["bump"], "minor")
        self.assertEqual(values["branch"], "release/v1.3.0-prep")
        self.assertEqual(values["unreleased"], "pending")
        self.assertEqual(values["labels"], "unavailable")
        self.assertIn("### Added", values["reason"])
        self.assertIn("PR ラベルは未取得", values["reason"])
        written = output.read_text(encoding="utf-8")
        self.assertIn("next=v1.3.0", written)
        self.assertIn("bump=minor", written)

    @unittest.skipUnless(shutil.which("git"), "git is required")
    def test_plan_uses_the_patch_bump_without_added_entries(self):
        self.write_changelog(PATCH_CHANGELOG)
        self.init_git_tag()
        values = cadence.plan(self.root)
        self.assertEqual(values["next"], "v1.2.4")
        self.assertEqual(values["bump"], "patch")
        self.assertEqual(values["branch"], "release/v1.2.4-prep")
        self.assertIn("### Added（利用者に見える追加）が無いため", values["reason"])

    @unittest.skipUnless(shutil.which("git"), "git is required")
    def test_plan_raises_a_fix_only_release_to_minor_for_merged_labels(self):
        self.write_changelog(PATCH_CHANGELOG)
        self.init_git_tag()
        values = cadence.plan(self.root, labels={"enhancement"})
        self.assertEqual(values["next"], "v1.3.0")
        self.assertEqual(values["bump"], "minor")
        self.assertEqual(values["labels"], "ok")
        self.assertIn("enhancement", values["reason"])


if __name__ == "__main__":
    unittest.main()
