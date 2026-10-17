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
        for name in self.native_package_names:
            self.native_package(name)

    @property
    def native_package_names(self):
        return ("rdsh_0.6.0_amd64.deb", "rdsh-0.6.0-1.x86_64.rpm")

    def native_package(self, name, magic=None):
        default = b"!<arch>\n" if name.endswith(".deb") else b"\xed\xab\xee\xdb"
        (self.root / name).write_bytes((default if magic is None else magic) + b"DUMMY_PACKAGE")
        self.checksum(name)

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
            self.assertEqual(len(release.missing_assets(self.root, existing)), 16)
            for name in release.INSTALLERS:
                (existing / name).write_bytes((self.root / name).read_bytes())
            pending = release.missing_assets(self.root, existing)
            self.assertEqual(len(pending), 14)
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
            self.assertEqual(len(output.read_text().splitlines()), 16)

    def test_missing_or_duplicated_native_package(self):
        deb = self.root / "rdsh_0.6.0_amd64.deb"
        sidecar = Path(str(deb) + ".sha256")
        saved = (deb.read_bytes(), sidecar.read_bytes())
        for path in (deb, sidecar):
            path.unlink()
        with self.assertRaisesRegex(ValueError, r"expected one rdsh_\*\.deb package, found 0"):
            release.verify(self.root)
        deb.write_bytes(saved[0])
        sidecar.write_bytes(saved[1])
        (self.root / "rdsh_0.6.0_arm64.deb").write_bytes(saved[0])
        with self.assertRaisesRegex(ValueError, r"expected one rdsh_\*\.deb package, found 2"):
            release.verify(self.root)

    def test_native_package_checksum_and_magic(self):
        deb = self.root / "rdsh_0.6.0_amd64.deb"
        saved = deb.read_bytes()
        deb.write_bytes(b"DUMMY_TAMPER" + saved)
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            release.verify(self.root)
        sidecar = Path(str(deb) + ".sha256")
        saved_sidecar = sidecar.read_bytes()
        sidecar.write_text("0" * 64)
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            release.verify(self.root)
        sidecar.write_bytes(saved_sidecar)
        self.native_package(deb.name, magic=b"NOTADEB!")
        with self.assertRaisesRegex(ValueError, "invalid native package"):
            release.verify(self.root)
        deb.write_bytes(saved)
        sidecar.write_bytes(saved_sidecar)
        release.verify(self.root)

    def test_draft_retry_refuses_a_different_package_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            existing = Path(temporary)
            (existing / "rdsh_0.5.2_amd64.deb").write_bytes(b"DUMMY_OLD")
            with self.assertRaisesRegex(ValueError, "unexpected draft asset"):
                release.missing_assets(self.root, existing)

if __name__ == "__main__":
    unittest.main()
