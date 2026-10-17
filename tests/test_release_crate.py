"""Contract tests for scripts/crate-release.py.

The cargo commands stay out of these tests: the release-policy CI job runs them
without a Rust toolchain, so only the pure decision helpers are covered here.
"""

import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "scripts" / "crate-release.py"
spec = importlib.util.spec_from_file_location("crate_release", SCRIPT)
crate_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crate_release)


def members_with(*extra):
    return ["Cargo.toml", "build.rs", "install.sh", "LICENSE", "README.md",
            "assets/icon.ico", "security/preload.mjs", "src/main.rs", *extra]


class ValidateMembersTest(unittest.TestCase):
    def test_complete_package_passes(self):
        self.assertEqual(crate_release.validate_members(members_with()), [])

    def test_missing_build_input_is_reported(self):
        members = [name for name in members_with() if not name.startswith("security/")]
        errors = crate_release.validate_members(members)
        self.assertEqual(errors, ["missing from the crate: security/"])

    def test_missing_embedded_install_script_is_reported(self):
        members = [name for name in members_with() if name != "install.sh"]
        self.assertIn("missing from the crate: install.sh", crate_release.validate_members(members))

    def test_release_only_tree_is_reported(self):
        errors = crate_release.validate_members(members_with("docs/PROJECT-SETUP.md"))
        self.assertEqual(errors, ["release-only path inside the crate: docs/ (1 file(s))"])

    def test_github_tree_is_reported(self):
        errors = crate_release.validate_members(members_with(".github/workflows/ci.yml"))
        self.assertTrue(errors[0].startswith("release-only path inside the crate: .github/"))

    def test_media_tree_is_reported(self):
        errors = crate_release.validate_members(members_with("media/rdsh-intro/a.mp4"))
        self.assertTrue(errors[0].startswith("release-only path inside the crate: media/"))


class CheckTagTest(unittest.TestCase):
    def test_matching_tag_passes(self):
        self.assertEqual(crate_release.check_tag("v0.4.1", "0.4.1"), [])

    def test_mismatched_tag_is_reported(self):
        self.assertEqual(
            crate_release.check_tag("v0.4.2", "0.4.1"),
            ["tag v0.4.2 does not match the Cargo.toml version 0.4.1"],
        )

    def test_wrong_prefix_is_reported(self):
        self.assertEqual(len(crate_release.check_tag("0.4.1", "0.4.1")), 1)

    def test_absent_tag_skips_the_check(self):
        self.assertEqual(crate_release.check_tag(None, "0.4.1"), [])


class RegistryLimitTest(unittest.TestCase):
    def test_limit_matches_the_documented_crates_io_ceiling(self):
        self.assertEqual(crate_release.MAX_CRATE_BYTES, 10_000_000)


if __name__ == "__main__":
    unittest.main()
