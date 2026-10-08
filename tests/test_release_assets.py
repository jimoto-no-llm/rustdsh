import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import subprocess
import sys
import unittest
import zipfile


spec = importlib.util.spec_from_file_location(
    "release_assets", Path(__file__).resolve().parents[1] / "scripts/verify-release-assets.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="rdsh release test ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in release.INSTALLERS:
            (self.root / name).write_text("DUMMY_INSTALLER")
        for name in release.ARCHIVES:
            self.package(name)

    def checksum(self, name):
        digest = hashlib.sha256((self.root / name).read_bytes()).hexdigest()
        # Windows sidecars contain only the digest; Unix includes the filename.
        value = digest if name.endswith(".zip") else digest + "  " + name + "\n"
        (self.root / (name + ".sha256")).write_text(value)

    def package(self, name, member=None, symlink=False):
        content = b"DUMMY_BINARY"
        if name.endswith(".zip"):
            with zipfile.ZipFile(self.root / name, "w") as package:
                entry = zipfile.ZipInfo(member or "rdsh.exe")
                if symlink:
                    entry.create_system = 3
                    entry.external_attr = 0o120777 << 16
                package.writestr(entry, content)
        else:
            with tarfile.open(self.root / name, "w:gz") as package:
                entry = tarfile.TarInfo(member or "rdsh")
                if symlink:
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = "/DUMMY_OUTSIDE"
                    package.addfile(entry)
                else:
                    entry.size = len(content)
                    package.addfile(entry, io.BytesIO(content))
        self.checksum(name)

    def test_complete_valid_release(self):
        release.verify(self.root)

    def test_missing_platform_or_installer(self):
        for name in [release.ARCHIVES[-1], release.INSTALLERS[0]]:
            path = self.root / name
            saved = path.read_bytes()
            path.unlink()
            with self.assertRaisesRegex(ValueError, "missing or invalid"):
                release.verify(self.root)
            path.write_bytes(saved)

    def test_missing_invalid_or_wrong_checksum(self):
        path = self.root / (release.ARCHIVES[0] + ".sha256")
        for content in [None, "", "not a digest", "0" * 64,
                        "0" * 64 + "  another-archive.tar.gz"]:
            if content is None:
                path.unlink()
            else:
                path.write_text(content)
            with self.assertRaises(ValueError):
                release.verify(self.root)

    def test_archive_tampering(self):
        with (self.root / release.ARCHIVES[0]).open("ab") as stream:
            stream.write(b"DUMMY_TAMPER")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            release.verify(self.root)

    def test_unsafe_archive_members_even_with_matching_checksums(self):
        for name in [release.ARCHIVES[0], release.ARCHIVES[-1]]:
            for member, symlink in [("../rdsh", False), (None, True)]:
                self.package(name, member, symlink)
                with self.assertRaisesRegex(ValueError, "invalid binary archive"):
                    release.verify(self.root)
            self.package(name)

    def test_symlink_asset_is_refused(self):
        path = self.root / release.INSTALLERS[0]
        path.unlink()
        path.symlink_to(self.root / release.INSTALLERS[1])
        with self.assertRaisesRegex(ValueError, "missing or invalid"):
            release.verify(self.root)

    def test_draft_retry_reuses_identical_files_and_uploads_only_missing(self):
        with tempfile.TemporaryDirectory() as temporary:
            existing = Path(temporary)
            self.assertEqual(len(release.missing_assets(self.root, existing)), 12)
            for name in release.INSTALLERS:
                (existing / name).write_bytes((self.root / name).read_bytes())
            pending = release.missing_assets(self.root, existing)
            self.assertEqual(len(pending), 10)
            self.assertFalse(any(path.name in release.INSTALLERS for path in pending))
            for path in pending:
                (existing / path.name).write_bytes(path.read_bytes())
            self.assertEqual(release.missing_assets(self.root, existing), [])

    def test_draft_retry_refuses_changed_unexpected_or_linked_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            existing = Path(temporary)
            path = existing / release.INSTALLERS[0]
            path.write_text("DUMMY_ORIGINAL")
            with self.assertRaisesRegex(ValueError, "refusing overwrite"):
                release.missing_assets(self.root, existing)
            self.assertEqual(path.read_text(), "DUMMY_ORIGINAL")
            path.unlink()
            path = existing / "unexpected.txt"
            path.write_text("DUMMY_ORIGINAL")
            with self.assertRaisesRegex(ValueError, "unexpected draft asset"):
                release.missing_assets(self.root, existing)
            path.unlink()
            path = existing / release.INSTALLERS[0]
            path.symlink_to(self.root / release.INSTALLERS[0])
            with self.assertRaisesRegex(ValueError, "missing or invalid"):
                release.missing_assets(self.root, existing)

    def test_draft_retry_cli_writes_safe_paths_for_space_containing_directory(self):
        with tempfile.TemporaryDirectory(prefix="rdsh draft ") as temporary:
            existing = Path(temporary) / "existing"
            existing.mkdir()
            output = Path(temporary) / "pending.txt"
            result = subprocess.run([sys.executable, str(Path(spec.origin)), str(self.root),
                                     "--existing-directory", str(existing), "--missing-output", str(output)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(output.read_text().splitlines()), 12)


if __name__ == "__main__":
    unittest.main()
