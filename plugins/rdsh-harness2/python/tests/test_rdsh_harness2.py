import copy
import json
from pathlib import Path
import tempfile
import unittest
import sys

from rdsh_harness2 import (JsonRunner, RdshBenchmarkAdapter, compare,
                          load_suite, private_json, read_harness, validate_response,
                          validate_tree)


def suite():
    return {"version": 1, "name": "unit-fixtures", "tasks": [
        {"id": "train", "split": "train", "domain": "tables",
         "prompt": "Read data.json and return its value as JSON.",
         "files": {"data.json": '{"value":7}'}, "expected": {"value": 7}},
        {"id": "unseen", "split": "holdout", "domain": "tables",
         "prompt": "Read data.json and return its value as JSON.",
         "files": {"data.json": '{"value":13}'}, "expected": {"value": 13}},
    ]}


class FakeRunner:
    """Explicit test double only. No fake provider is exposed by the production CLI."""
    provider = "test"
    model = "unit"

    def __init__(self, invalid=False, invalid_json=False, failed_probe=False):
        self.records = []
        self.requests = []
        self.invalid = invalid
        self.invalid_json = invalid_json
        self.failed_probe = failed_probe

    def invoke(self, role, workspace, prompt, harness, audit, label):
        audit.mkdir(parents=True)
        self.requests.append((role, workspace, prompt, harness))
        if role == "solver":
            answer = json.loads((workspace / "data.json").read_text())
            # Baseline intentionally fails in this unit test so propagation can be checked.
            text = json.dumps(answer if "check source" in harness["tool-guidance.md"] else {})
        else:
            text = json.dumps({"version": 1, "harness": {
                "../escape" if self.invalid else "tool-guidance.md": "check source"},
                "notes": "base1 returned no source value; require reading data.json first."})
            if self.invalid_json and label.endswith(".a1"):
                text = '{"version":'
        response = {"version": 1, "ok": True, "text": text,
                    "usage": {"inputTokens": 20, "outputTokens": 10, "cacheReadTokens": 0,
                              "cacheWriteTokens": 0},
                    "wallMs": 5, "trace": [{"type": "answer", "text": text}],
                    "model": self.model, "provider": self.provider}
        if self.failed_probe and label.endswith("-inv1"):
            response.update({"ok": False, "text": "", "error": {"code": "TestProbeFailure"},
                             "trace": [{"type": "error", "text": "test probe failed"}]})
        private_json(audit / "response.json", response)
        self.records.append({"label": label, "role": role, "ok": response["ok"], "wallMs": 5,
                             "providerWallMs": 5, "usage": response["usage"], "costUsd": None,
                             "audit": str(audit)})
        return response


class AdapterTests(unittest.TestCase):
    def test_actual_upstream_recursion_and_frozen_holdout(self):
        with tempfile.TemporaryDirectory() as temp:
            runner = FakeRunner()
            root = Path(temp) / "run"
            report = compare(suite(), root, runner)
            self.assertTrue(report["complete"])
            self.assertEqual([r["role"] for r in runner.records].count("improver"), 3)
            self.assertEqual(report["training"]["sessions"], 7)
            self.assertEqual(report["trainingAdditionalOverBaseline"]["sessions"], 6)
            self.assertEqual(report["holdout"]["sessions"], 2)
            self.assertEqual(report["total"]["usage"]["inputTokens"], 180)
            self.assertIsNone(report["costUsd"])
            self.assertFalse(report["rows"][0]["baseline"]["passed"])
            self.assertTrue(report["rows"][1]["improved"]["passed"])
            self.assertEqual(report["methods"][0]["method"]["finals"], ["agg1"])
            self.assertEqual(report["methods"][0]["selection"]["chosen_label"], "agg1")
            for role, workspace, prompt, harness in runner.requests:
                self.assertFalse(any(p.name in ("expected.json", "suite.json", "report.json")
                                     for p in workspace.rglob("*")))
                self.assertNotIn('"expected"', prompt)
                if role == "improver":
                    self.assertTrue((workspace / "context" / "task.md").is_file())
            self.assertEqual((root / "report.json").stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                compare(suite(), root, runner)

    def test_invalid_proposals_retry_then_incomplete_no_holdout(self):
        with tempfile.TemporaryDirectory() as temp:
            runner = FakeRunner(invalid=True)
            report = compare(suite(), Path(temp) / "run", runner)
            self.assertFalse(report["complete"])
            self.assertIsNone(report["frozenHarnessSha256"])
            self.assertEqual(report["rows"][1]["mode"], "not-run")
            self.assertEqual(report["holdout"]["sessions"], 0)
            self.assertEqual(len(report["methods"][0]["method"]["fell_back"]), 3)
            self.assertEqual(sum(r["role"] == "improver" for r in runner.records), 6)
            errors = report["methods"][0]["proposalValidationErrors"]
            self.assertEqual(len(errors), 6)
            self.assertEqual(errors[0]["message"], "path must be canonical and inside workspace")
            improver_prompts = [prompt for role, _, prompt, _ in runner.requests if role == "improver"]
            self.assertIn("PREVIOUS PATCH VALIDATION FAILURE", improver_prompts[1])
            self.assertIn(errors[0]["message"], improver_prompts[1])

    def test_multiple_training_tasks_have_distinct_audit_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            data = suite()
            extra = copy.deepcopy(data["tasks"][0])
            extra["id"] = "train-second"
            data["tasks"].insert(1, extra)
            report = compare(data, Path(temp) / "run", FakeRunner())
            self.assertTrue(report["complete"])
            self.assertEqual(report["training"]["sessions"], 14)

    def test_malformed_json_is_repaired_with_precise_upstream_retry_feedback(self):
        with tempfile.TemporaryDirectory() as temp:
            runner = FakeRunner(invalid_json=True)
            report = compare(suite(), Path(temp) / "run", runner)
            self.assertTrue(report["complete"])
            self.assertEqual(report["training"]["sessions"], 10)
            errors = report["methods"][0]["proposalValidationErrors"]
            self.assertEqual(len(errors), 3)
            self.assertEqual(errors[0]["code"], "JSONDecodeError")
            prompts = [prompt for role, _, prompt, _ in runner.requests if role == "improver"]
            self.assertIn(errors[0]["message"], prompts[1])

    def test_explicit_frozen_only_evaluates_holdouts_without_improver(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            frozen = root / "previous-successful-aggregate"
            frozen.mkdir()
            (frozen / "systemprompt.md").write_text("")
            (frozen / "tool-guidance.md").write_text("check source")
            runner = FakeRunner()
            output = root / "run"
            report = compare(suite(), output, runner, frozen_harness=frozen)
            self.assertTrue(report["complete"])
            self.assertEqual(report["method"], "frozen-only")
            self.assertIsNone(report["adaptationComplete"])
            self.assertEqual(report["methods"], [])
            self.assertEqual(report["training"]["sessions"], 0)
            self.assertEqual(report["trainingAdditionalOverBaseline"]["sessions"], 0)
            self.assertEqual(report["holdout"]["sessions"], 2)
            self.assertEqual(len(report["rows"]), 1)
            self.assertEqual(report["rows"][0]["taskId"], "unseen")
            self.assertEqual(report["rows"][0]["mode"], "supplied-frozen-harness")
            self.assertTrue(report["rows"][0]["improved"]["passed"])
            self.assertEqual(report["frozenHarnessSource"]["sha256"], report["frozenHarnessSha256"])
            self.assertTrue(all(role == "solver" for role, _, _, _ in runner.requests))
            with self.assertRaises(FileExistsError):
                compare(suite(), output, runner, frozen_harness=frozen)
            linked = root / "linked-harness"
            linked.symlink_to(frozen, target_is_directory=True)
            with self.assertRaises(ValueError):
                compare(suite(), root / "bad-run", runner, frozen_harness=linked)
            (frozen / "hooks.json").write_text("{}")
            with self.assertRaises(ValueError):
                compare(suite(), root / "bad-run", runner, frozen_harness=frozen)

    def test_failed_probe_does_not_hide_failure_but_valid_aggregate_runs_holdout(self):
        with tempfile.TemporaryDirectory() as temp:
            runner = FakeRunner(failed_probe=True)
            report = compare(suite(), Path(temp) / "run", runner)
            self.assertFalse(report["complete"])
            self.assertFalse(report["adaptationComplete"])
            self.assertFalse(report["rows"][0]["complete"])
            self.assertTrue(report["methods"][0]["aggregateAdoptionEligible"])
            self.assertFalse(report["frozenHarnessOrigin"]["aggregateFellBack"])
            self.assertFalse(report["frozenHarnessOrigin"]["adaptationComplete"])
            self.assertEqual(report["holdout"]["sessions"], 2)
            self.assertTrue(report["rows"][1]["complete"])
            self.assertTrue(report["rows"][1]["improved"]["passed"])
            self.assertEqual(report["fallbackWarnings"][0]["stage"], "inv1")

    def test_path_and_byte_boundary(self):
        for name in ("../bad", "/bad", "./systemprompt.md", "scripts/a.py",
                     "hooks.json", "skills/x/scripts/a.py", "tool\\guidance.md"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_tree({name: "bad"})
        with self.assertRaises(ValueError):
            validate_tree({"systemprompt.md": "あ" * 16001})
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "systemprompt.md").symlink_to(root / "other")
            with self.assertRaises(ValueError):
                read_harness(root)

    def test_suite_strict_and_answer_not_materialized(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "input.json"
            path.write_text(json.dumps(suite()))
            parsed = load_suite(path)
            adapter_root = Path(temp) / "adapter"
            adapter = RdshBenchmarkAdapter(parsed, adapter_root, FakeRunner())
            self.assertEqual(adapter.tasks("holdout"), ["unseen"])
            self.assertEqual(adapter.substrate.materialise(
                adapter.base_harness(), adapter.spec, {}).fingerprint.__len__(), 64)
            self.assertFalse(any(p.name == "input.json" for p in adapter_root.rglob("*")))
            data = suite()
            data["tasks"][0]["files"]["../expected.json"] = "bad"
            path.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                load_suite(path)

    def test_schema_rejects_unknown_fields_and_nonfinite(self):
        response = {"version": 1, "ok": True, "text": "{}",
                    "usage": {"inputTokens": None, "outputTokens": 0, "cacheReadTokens": 0,
                              "cacheWriteTokens": 0},
                    "wallMs": 1, "trace": [], "model": "unit", "provider": "test"}
        validate_response(response)
        for key, value in (("secret", "bad"), ("wallMs", float("nan"))):
            changed = {**response, key: value}
            with self.assertRaises(ValueError):
                validate_response(changed)

    def test_json_scoring_is_exact_and_boolean_is_not_integer(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = suite()
            data["tasks"][0]["expected"] = True
            adapter = RdshBenchmarkAdapter(data, root / "adapter", FakeRunner())
            run = root / "rollout"
            run.mkdir()
            (run / "result.json").write_text(json.dumps({"ok": True, "text": "1"}))
            self.assertFalse(adapter.score(run, "train")["passed"])
            (run / "result.json").write_text(json.dumps({"ok": True, "text": '{"a":1,"a":2}'}))
            self.assertFalse(adapter.score(run, "train")["validJson"])

    def test_production_transport_schema_and_private_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            helper = root / "helper.py"
            helper.write_text('''import argparse, json
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('--request'); p.add_argument('--response')
a = p.parse_args()
r = json.loads(Path(a.request).read_text())
Path(a.response).write_text(json.dumps({
    "version":1,"ok":True,"text":"{}","usage":{"inputTokens":3,"outputTokens":2,
    "cacheReadTokens":0,"cacheWriteTokens":0},"wallMs":1,"trace":[],
    "model":r["model"],"provider":r["provider"]}))
''')
            runner = JsonRunner(helper, "test", "unit", 1000, 2, node=sys.executable)
            workspace = root / "workspace"
            workspace.mkdir()
            response = runner.invoke("solver", workspace, "Return JSON.", {}, root / "audit", "test")
            self.assertTrue(response["ok"])
            self.assertEqual((root / "audit" / "request.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual((root / "audit" / "response.json").stat().st_mode & 0o777, 0o600)
            helper.write_text(helper.read_text().replace('"model":r["model"]', '"model":"wrong"'))
            response = runner.invoke("solver", workspace, "Return JSON.", {}, root / "bad", "bad")
            self.assertFalse(response["ok"])
            self.assertIsNone(runner.records[-1]["usage"]["inputTokens"])


if __name__ == "__main__":
    unittest.main()
