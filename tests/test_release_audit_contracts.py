"""User-facing release/documentation contracts caught by the 2026-11 audit."""
from __future__ import annotations

import importlib.util
import json
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/pin-release-digests.py"
spec = importlib.util.spec_from_file_location("audit_digest_pin", SCRIPT)
pin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pin)
VERSION = r"0\.\d+\.\d+-(?:alpha|beta|rc)\.\d+"


class DocumentationContracts(unittest.TestCase):
    def test_readmes_list_the_actual_protected_runtime_allowlist(self):
        source = (ROOT / "src/tool_security.rs").read_text()
        block = source.split("const AUDITED_ADAPTERS", 1)[1].split("];", 1)[0]
        expected = set(re.findall(r'dsh_version:\s*"([^"]+)"', block))
        self.assertTrue(expected)
        for file, heading in [("README.md", "### Protected delegated tools"),
                              ("README.ja.md", "## 保護付き起動に対応しているバージョン")]:
            text = (ROOT / file).read_text().split(heading, 1)[1].split("\n### ", 1)[0]
            with self.subTest(file=file):
                self.assertEqual(set(re.findall(VERSION, text)), expected)

    def test_acp_documentation_uses_the_dashboard_catalog_not_the_tool_allowlist(self):
        source = (ROOT / "dashboard/adapter-catalog.mjs").read_text()
        values = re.search(r"export const versions = (\[[^;]+\]);", source).group(1)
        expected = set(json.loads(values))
        row = next(line for line in (ROOT / "docs/CLI-ADAPTERS.md").read_text().splitlines()
                   if line.startswith("| DSH |"))
        self.assertEqual(set(re.findall(VERSION, row)), expected)

    def test_documented_switch_defaults_match_the_rust_catalog(self):
        source = (ROOT / "src/rdsh_config.rs").read_text()
        defaults = dict(re.findall(r'FeatureDef\s*\{\s*id:\s*"([^"]+)",\s*default:\s*(true|false)', source))
        doc = (ROOT / "docs/RDSH-SETTINGS.md").read_text()
        for feature in ["discord", "telemetry", "update_check", "update_notifications",
                        "search-web", "web_search_bridge", "release_probe"]:
            row = re.search(r"^\| " + re.escape(feature) + r" \| (on|off) \|", doc, re.M)
            with self.subTest(feature=feature):
                self.assertIsNotNone(row)
                self.assertEqual(row.group(1), "on" if defaults[feature] == "true" else "off")


class ReleasePublicationContracts(unittest.TestCase):
    def test_latest_is_complete_in_all_three_checked_in_ledgers(self):
        channels = []
        for path, _header, assets in pin.LEDGERS:
            _comments, latest, versions = pin.split_registry((ROOT / path).read_text())
            channels.append(latest)
            pin.require_assets(latest, dict(versions.get(latest, [])), assets)
        self.assertEqual(len(set(channels)), 1, "binary and plugin installers resolve different releases")

    def test_workflow_stages_every_ledger_generated_by_the_pin_script(self):
        workflow = (ROOT / ".github/workflows/pin-release-digests.yml").read_text()
        stage = next(line.strip() for line in workflow.splitlines()
                     if line.strip().startswith("git add release-digests.tsv"))
        command = shlex.split(stage)
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            assets = []
            for path, header, names in pin.LEDGERS:
                text = "\n".join(header) + "\nlatest v0.14.0\n"
                text += "".join(f"v0.14.0 {name} {'1' * 64}\n" for name in names)
                (repo / path).write_text(text)
                assets += [{"name": name, "digest": "sha256:" + "2" * 64} for name in names]
            (repo / "assets.json").write_text(json.dumps({"assets": assets}))
            subprocess.run([sys.executable, str(SCRIPT), "v0.15.0", "--from-json", "assets.json"],
                           cwd=repo, check=True, capture_output=True)
            subprocess.run(command, cwd=repo, check=True)
            staged = subprocess.check_output(["git", "diff", "--cached", "--name-only"], cwd=repo, text=True)
            self.assertEqual(set(staged.splitlines()), {str(path) for path, _h, _a in pin.LEDGERS})
            for path, _h, _a in pin.LEDGERS:
                self.assertIn("latest v0.15.0\n", (repo / path).read_text())


if __name__ == "__main__":
    unittest.main()
