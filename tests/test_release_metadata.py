import importlib.util
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "prepare_release", Path(__file__).resolve().parents[1] / "scripts" / "prepare-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "docs" / "releases").mkdir(parents=True)

    def fixture(self, version="1.2.3"):
        (self.root / "Cargo.toml").write_text(f'[package]\nname = "rdsh"\nversion = "{version}"\n', encoding="utf-8")
        (self.root / "Cargo.lock").write_text(f'[[package]]\nname = "rdsh"\nversion = "{version}"\n', encoding="utf-8")
        (self.root / "CHANGELOG.md").write_text(f"## [{version}] - 2026-10-08\n", encoding="utf-8")
        notes = (f"## {version} — Example\n\n- Fixed an issue.\n\n## 更新前に確認\n\n"
                 f"- Restart processes.\n\nInstall/update:\n\n```sh\ncurl https://github.com/org/repo/releases/download/v{version}/install.sh | bash -s -- --from-release --version=v{version}\n```\n\n"
                 f"Windows: `install.ps1 -FromRelease -Version v{version}`.\n")
        path = self.root / "docs" / "releases" / f"v{version}.md"
        path.write_text(notes, encoding="utf-8")
        return path

    def test_stable_and_prerelease(self):
        for version in ("1.2.3", "1.2.3-rc.1", "1.2.3-beta.0", "1.2.3-alpha.2"):
            self.fixture(version)
            release.validate(self.root, f"v{version}")

    def test_invalid_tags(self):
        for tag in ("1.2.3", "v01.2.3", "v1.2", "v1.2.3-rc", "v1.2.3-rc.01", "v1.2.3+build", "v1.2.3\n"):
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, "tag must"):
                release.validate(self.root, tag)

    def test_manifest_and_lock_must_match_tag(self):
        self.fixture()
        for filename in ("Cargo.toml", "Cargo.lock"):
            path = self.root / filename
            original = path.read_text(encoding="utf-8")
            path.write_text(original.replace("1.2.3", "1.2.4"), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "versions must match"):
                release.validate(self.root, "v1.2.3")
            path.write_text(original, encoding="utf-8")

    def test_missing_changelog_or_notes(self):
        notes = self.fixture()
        (self.root / "CHANGELOG.md").write_text("## [Unreleased]\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "dated entry"):
            release.validate(self.root, "v1.2.3")
        self.fixture()
        notes.unlink()
        with self.assertRaises(FileNotFoundError):
            release.validate(self.root, "v1.2.3")

    def test_missing_sections_wrong_heading_and_placeholders(self):
        for old, new in (("## 更新前に確認", "## Notes"), ("Install/update:", "Install:"),
                         ("1.2.3 — Example", "1.2.4 — Example"), ("Fixed an issue.", "<changes>"),
                         ("Fixed an issue.", "TODO"), ("install.ps1", "install.cmd")):
            notes = self.fixture()
            notes.write_text(notes.read_text(encoding="utf-8").replace(old, new), encoding="utf-8")
            with self.subTest(old=old), self.assertRaises(ValueError):
                release.validate(self.root, "v1.2.3")

    def test_generated_notes_are_replaced_without_duplicate_credits(self):
        notes = self.fixture()
        notes.write_text(notes.read_text(encoding="utf-8") + "\n## What's Changed\n\nold PR list\n", encoding="utf-8")
        authored = release.validate(self.root, "v1.2.3")
        generated = ("## What's Changed\n### What's Changed\n* Fix by @contributor in https://github.com/org/repo/pull/1\n\n"
                     "## New Contributors\n\n* @contributor\n\n"
                     "**Full Changelog**: https://github.com/org/repo/compare/v1.2.2...v1.2.3")
        rendered = release.compose(authored, generated, "org/repo")
        self.assertEqual(rendered.count("## What's Changed"), 1)
        self.assertNotIn("### What's Changed", rendered)
        self.assertIn(generated.replace("\n### What's Changed\n", "\n\n"), rendered)
        self.assertNotIn("old PR list", rendered)
        self.assertIn("https://github.com/org/repo/blob/main/CHANGELOG.md", rendered)

    def test_incomplete_generated_notes_are_refused(self):
        for generated in ("", "## What's Changed\n", "**Full Changelog**: url"):
            with self.assertRaises(ValueError):
                release.compose("notes", generated, "org/repo")

    def test_prerelease_cannot_recommend_latest_installer(self):
        notes = self.fixture("1.2.3-rc.1")
        notes.write_text(notes.read_text(encoding="utf-8").replace("https://github.com/org/repo/releases/download/v1.2.3-rc.1/install.sh",
                         "https://github.com/org/repo/releases/latest/download/install.sh"), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "exact tag URL"):
            release.validate(self.root, "v1.2.3-rc.1")

    def test_prerelease_refuses_another_candidate_or_stable_installer(self):
        for wrong in ("v1.2.3-rc.0", "v1.2.2", "v1.2.4-rc.1"):
            notes = self.fixture("1.2.3-rc.1")
            content = notes.read_text(encoding="utf-8")
            notes.write_text(content.replace("download/v1.2.3-rc.1/", f"download/{wrong}/"), encoding="utf-8")
            with self.subTest(wrong=wrong), self.assertRaisesRegex(ValueError, "exact tag URL"):
                release.validate(self.root, "v1.2.3-rc.1")
        notes = self.fixture("1.2.3-rc.1")
        notes.write_text(notes.read_text(encoding="utf-8") +
                         "https://github.com/org/repo/releases/download/v1.2.3-rc.0/install.ps1\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "exact tag URL"):
            release.validate(self.root, "v1.2.3-rc.1")

    def test_previous_tag_is_validated_and_preview_cannot_override_it(self):
        self.assertIsNone(release.previous_tag("notes"))
        self.assertEqual(release.previous_tag("<!-- previous-tag: v1.2.2 -->", "v1.2.2"), "v1.2.2")
        for notes, requested in (("notes", "v1.2.2"), ("<!-- previous-tag: v1.2.2 -->", "v1.2.1"),
                                 ("<!-- previous-tag: nope -->", None),
                                 ("<!-- previous-tag: v1.2.2 -->\n<!-- previous-tag: v1.2.1 -->", None)):
            with self.subTest(notes=notes), self.assertRaises(ValueError):
                release.previous_tag(notes, requested)
        notes = self.fixture()
        notes.write_text(notes.read_text(encoding="utf-8") + "<!-- previous-tag: v1.2.3 -->\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "must differ"):
            release.validate(self.root, "v1.2.3")

    def test_candidate_installer_download_alone_does_not_select_candidate_binaries(self):
        for option in ("--version=v1.2.3-rc.1", "-Version v1.2.3-rc.1"):
            for replacement in ("", option.replace("v1.2.3-rc.1", "latest"),
                                option.replace("v1.2.3-rc.1", "v1.2.3-rc.0"),
                                option + " " + option.replace("v1.2.3-rc.1", "v1.2.2")):
                notes = self.fixture("1.2.3-rc.1")
                notes.write_text(notes.read_text(encoding="utf-8").replace(option, replacement), encoding="utf-8")
                with self.subTest(option=option, replacement=replacement), self.assertRaisesRegex(ValueError, "matching this tag"):
                    release.validate(self.root, "v1.2.3-rc.1")

    def test_candidate_installer_versions_can_be_quoted(self):
        for quote in ("'", '"'):
            notes = self.fixture("1.2.3-rc.1")
            text = notes.read_text(encoding="utf-8")
            text = text.replace("--version=v1.2.3-rc.1", f"--version={quote}v1.2.3-rc.1{quote}")
            text = text.replace("-Version v1.2.3-rc.1", f"-Version {quote}v1.2.3-rc.1{quote}")
            notes.write_text(text, encoding="utf-8")
            release.validate(self.root, "v1.2.3-rc.1")

    def test_candidate_version_hints_in_comments_do_not_replace_instructions(self):
        notes = self.fixture("1.2.3-rc.1")
        text = notes.read_text(encoding="utf-8")
        hint = "<!-- --version=vX.Y.Z-rc.N and -Version vX.Y.Z-rc.N -->\n"
        notes.write_text(text + hint, encoding="utf-8")
        release.validate(self.root, "v1.2.3-rc.1")
        text = text.replace("--version=v1.2.3-rc.1", "")
        notes.write_text(text + "<!-- --version=v1.2.3-rc.1 -->\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "matching this tag"):
            release.validate(self.root, "v1.2.3-rc.1")

    def test_publication_reads_the_persisted_previous_tag_without_cli_override(self):
        notes = self.fixture()
        notes.write_text(notes.read_text(encoding="utf-8") + "<!-- previous-tag: v1.2.2 -->\n", encoding="utf-8")
        output = self.root / "rendered.md"
        generated = {"body": "## What's Changed\n\n- Fix by @author\n\n**Full Changelog**: comparison"}
        with patch.object(sys, "argv", ["prepare-release.py", "v1.2.3", "--root", str(self.root),
                                        "--output", str(output)]), \
                patch.object(release.subprocess, "check_output", return_value=release.json.dumps(generated)) as api:
            release.main()
        self.assertIn("previous_tag_name=v1.2.2", api.call_args.args[0])
        self.assertIn("更新前に確認", output.read_text(encoding="utf-8"))

    def test_cli_reads_japanese_notes_with_utf8_mode_disabled(self):
        self.fixture()
        result = subprocess.run(
            [sys.executable, str(release.ROOT / "scripts" / "prepare-release.py"),
             "v1.2.3", "--root", str(self.root)],
            env={**os.environ, "LC_ALL": "C", "LANG": "C", "PYTHONUTF8": "0",
                 "PYTHONCOERCECLOCALE": "0"},
            capture_output=True, text=True, encoding="utf-8", timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Validated v1.2.3", result.stdout)


if __name__ == "__main__":
    unittest.main()
