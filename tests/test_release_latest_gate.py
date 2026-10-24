"""Workflow guards for the release ordering and action pinning (#890, #892).

These read the workflow files as text: the failure they prevent is a
configuration edit, not runtime behavior, so a static assertion is the
cheapest gate before CI reaches GitHub.
"""

import pathlib
import re
import yaml
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


class CdRetryTest(unittest.TestCase):
    """A release that fails inside CD must be retryable without moving the tag."""

    def test_cd_accepts_a_tag_input_for_a_manual_retry(self):
        text = (WORKFLOWS / "cd.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", text)
        self.assertRegex(text, r"\n      tag:\n(?:.*\n)*?        required: true")

    def test_both_triggers_resolve_the_release_tag_the_same_way(self):
        text = (WORKFLOWS / "cd.yml").read_text(encoding="utf-8")
        # A tag push arrives with the tag in the ref; a manual run names it.
        self.assertIn(
            "  RELEASE_TAG: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}",
            text,
        )

    def test_every_cd_checkout_builds_the_tagged_commit(self):
        text = (WORKFLOWS / "cd.yml").read_text(encoding="utf-8")
        checkouts = [
            line for line in text.splitlines() if line.strip().startswith("- uses: actions/checkout@")
        ]
        self.assertTrue(checkouts)
        self.assertEqual(
            text.count("          ref: ${{ env.RELEASE_TAG }}"),
            len(checkouts),
            "a manual run must check out the tag, not the dispatched branch",
        )


class WorkflowShapeTest(unittest.TestCase):
    """GitHub refuses a workflow when a key it expects to be a mapping is empty."""

    def test_every_env_block_is_a_mapping(self):
        # `env:` with no children parses as YAML null and is allowed by yaml.safe_load,
        # but GitHub rejects the whole workflow: 'Unexpected value' with no run at all.
        for path in sorted(WORKFLOWS.glob("*.yml")):
            document = yaml.safe_load(path.read_text(encoding="utf-8"))

            def walk(node, where):
                if isinstance(node, dict):
                    for key, value in node.items():
                        if key == "env" and not isinstance(value, dict):
                            self.fail(f"{path.name}: {where}/env is {value!r}, not a mapping")
                        walk(value, f"{where}/{key}")
                elif isinstance(node, list):
                    for index, value in enumerate(node):
                        walk(value, f"{where}[{index}]")

            walk(document, "")

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
