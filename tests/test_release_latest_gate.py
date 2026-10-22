"""Workflow guards for the release ordering and action pinning (#890, #892).

These read the workflow files as text: the failure they prevent is a
configuration edit, not runtime behavior, so a static assertion is the
cheapest gate before CI reaches GitHub.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"
PINNED = re.compile(r"uses:\s+[\w.-]+/[\w.-]+(?:/[\w.-]+)?@[0-9a-f]{40}\b")
LEDGER_LATEST = '$1 == "latest"'


class ActionPinningTest(unittest.TestCase):
    def test_cd_pins_every_action_to_a_commit(self):
        text = (WORKFLOWS / "cd.yml").read_text(encoding="utf-8")
        uses = [
            line.strip()
            for line in text.splitlines()
            if line.strip().startswith("- uses:") or line.strip().startswith("uses:")
        ]
        self.assertTrue(uses)
        for line in uses:
            self.assertRegex(line, PINNED, f"unpinned action in cd.yml: {line}")

    def test_a_pinned_toolchain_still_names_the_toolchain(self):
        text = (WORKFLOWS / "cd.yml").read_text(encoding="utf-8")
        for block in re.finditer(
            r"- uses: dtolnay/rust-toolchain@[0-9a-f]{40}[^\n]*\n((?:\s+.*\n)*?)(?=\s*- |\Z)",
            text,
        ):
            self.assertIn(
                "toolchain:",
                block.group(1),
                "a pinned rust-toolchain step must set toolchain explicitly",
            )


class LatestGateTest(unittest.TestCase):
    def test_cd_never_marks_a_fresh_release_latest(self):
        text = (WORKFLOWS / "cd.yml").read_text(encoding="utf-8")
        for line in text.splitlines():
            if "gh release edit" in line and "--prerelease=false" in line:
                self.assertIn(
                    "--latest=false",
                    line,
                    "publishing must not mark latest before the ledgers pin it",
                )

    def test_mark_latest_follows_the_ledger(self):
        path = WORKFLOWS / "mark-release-latest.yml"
        self.assertTrue(path.exists(), "the ledger needs a workflow that marks the release latest")
        text = path.read_text(encoding="utf-8")
        self.assertIn("release-digests.tsv", text)
        self.assertIn(LEDGER_LATEST, text)
        self.assertIn("gh release edit", text)
        self.assertIn("--latest", text)


if __name__ == "__main__":
    unittest.main()
