import copy
import json
from pathlib import Path
import tempfile
import unittest

from rdsh_coding import CodingBenchmarkAdapter, CodingGrader, compare_coding, load_suite
from rdsh_harness2 import private_json
from test_rdsh_harness2 import FakeRunner

SECRET = "PRIVATE_HIDDEN_ASSERTION_4817"


def suite():
    task = {"id": "train-code", "split": "train", "domain": "parsing",
        "prompt": "Fix src/value.mjs, preserve tests, and use harness2_test to run visible tests.",
        "files": {"src/value.mjs": "export const value = () => 0;\n",
                  "test/value.test.mjs": "// visible tests\n"},
        "editableFiles": ["src/value.mjs"], "testFiles": ["test/value.test.mjs"],
        "hiddenTests": {"private.test.mjs": "// " + SECRET}, "hiddenTestCount": 8}
    holdout = {**copy.deepcopy(task), "id": "unseen-code", "split": "holdout"}
    return {"version": 1, "name": "coding-unit", "tasks": [task, holdout]}


class CodingRunner(FakeRunner):
    def __init__(self, *, unchanged=False, tamper=False, no_test=False, failed_probe=False):
        super().__init__()
        self.unchanged, self.tamper, self.no_test, self.failed_probe = unchanged, tamper, no_test, failed_probe
        self.solver_requests = []

    def invoke(self, role, workspace, prompt, harness, audit, label, *, coding=None):
        if role != "solver":
            self.assert_private(workspace, prompt)
            return super().invoke(role, workspace, prompt, harness, audit, label)
        audit.mkdir(parents=True)
        self.solver_requests.append(coding)
        self.requests.append((role, workspace, prompt, harness))
        self.assert_private(workspace, prompt)
        if not self.unchanged:
            (workspace / "src/value.mjs").write_text("export const value = () => 7;\n")
        if self.tamper:
            (workspace / "test/value.test.mjs").write_text("// erased assertions")
        actions = [{"type": "action", "name": "harness2_edit", "text": "src/value.mjs"}]
        if not self.no_test:
            actions.append({"type": "action", "name": "harness2_test", "text": "{}"})
        ok = not (self.failed_probe and label.endswith("-inv1"))
        response = {"version": 1, "ok": ok, "text": "Fixed and tested.",
            "usage": {"inputTokens": 20, "outputTokens": 10, "cacheReadTokens": 0, "cacheWriteTokens": 0},
            "wallMs": 5, "trace": actions, "model": self.model, "provider": self.provider}
        if not ok:
            response["error"] = {"code": "NativeProbeFailure"}
        private_json(audit / "response.json", response)
        self.records.append({"label": label, "role": role, "ok": ok, "wallMs": 5,
            "providerWallMs": 5, "usage": response["usage"], "costUsd": None, "audit": str(audit)})
        return response

    @staticmethod
    def assert_private(workspace, prompt):
        assert SECRET not in prompt
        for path in workspace.rglob("*"):
            if path.is_file():
                assert SECRET not in path.read_text(), path
                assert path.name not in ("private-score.json", "suite.json", "report.json", "private.test.mjs")


class FakeGrader:
    def __init__(self, fail=False, no_tests=False):
        self.fail, self.no_tests, self.calls = fail, no_tests, []

    def invoke(self, workspace, test_root, test_files, audit, timeout_ms=15000, *, source_files):
        self.calls.append((workspace, test_root, test_files, source_files))
        count = 0 if self.no_tests else (8 if test_root != workspace else 2)
        return {"version": 1, "ok": not self.fail and bool(count), "passed": 0 if self.fail else count,
            "failed": count if self.fail else 0, "tests": count, "exitCode": 1 if self.fail else 0,
            "sandbox": "test", "timedOut": False, "outputLimited": False, "wallMs": 3}


class CodingTests(unittest.TestCase):
    def run_compare(self, root, runner=None, grader=None):
        return compare_coding(suite(), root, runner or CodingRunner(), grader=grader or FakeGrader())

    def test_real_upstream_loop_code_artifacts_hidden_isolation_and_holdout(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "run"
            runner, grader = CodingRunner(), FakeGrader()
            report = self.run_compare(root, runner, grader)
            self.assertTrue(report["complete"])
            self.assertTrue(all(row["improved"]["passed"] for row in report["rows"]))
            self.assertEqual(report["training"]["sessions"], 7)
            self.assertEqual(report["holdout"]["sessions"], 2)
            self.assertEqual(report["gradingWallMs"], 24)
            self.assertEqual(len(grader.calls), 8)
            self.assertTrue(all(call[3] == ["src/value.mjs"] for call in grader.calls))
            self.assertTrue(all(request == {"editableFiles": ["src/value.mjs"],
                "testFiles": ["test/value.test.mjs"], "testTimeoutMs": 15000} for request in runner.solver_requests))
            self.assertTrue((root / "rollouts/train-code-base/changes.patch").is_file())
            self.assertNotIn(SECRET, (root / "report.json").read_text())
            for row in report["rows"]:
                self.assertEqual(row["baseline"]["nativeActions"], {"edit": 1, "test": 1, "read": 0})
                self.assertEqual(row["improved"]["hidden"]["tests"], 8)

    def test_tampered_visible_tests_never_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            report = self.run_compare(Path(temp) / "run", CodingRunner(tamper=True))
            self.assertFalse(report["rows"][0]["baseline"]["passed"])
            self.assertFalse(report["rows"][0]["baseline"]["visibleTestsUnchanged"])
            self.assertFalse(report["rows"][0]["baseline"]["allowedChanges"])

    def test_no_source_change_is_not_delivery_or_semantic_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            report = self.run_compare(Path(temp) / "run", CodingRunner(unchanged=True))
            self.assertFalse(report["complete"])
            self.assertFalse(report["rows"][0]["baseline"]["passed"])
            self.assertFalse(report["rows"][0]["baseline"]["sourceChanged"])
            self.assertEqual(report["rows"][1]["mode"], "not-run")

    def test_failed_tests_and_no_test_calls_cannot_be_swallowed(self):
        for runner, grader in ((CodingRunner(), FakeGrader(fail=True)),
                               (CodingRunner(), FakeGrader(no_tests=True)),
                               (CodingRunner(no_test=True), FakeGrader())):
            with self.subTest(runner=runner, grader=grader), tempfile.TemporaryDirectory() as temp:
                report = self.run_compare(Path(temp) / "run", runner, grader)
                self.assertFalse(report["rows"][0]["baseline"]["passed"])
                self.assertFalse(report["rows"][1]["improved"]["passed"])

    def test_exact_hidden_test_count_required(self):
        class TooFew(FakeGrader):
            def invoke(self, *args, **kwargs):
                response = super().invoke(*args, **kwargs)
                response.update(tests=1, passed=1)
                return response
        with tempfile.TemporaryDirectory() as temp:
            report = self.run_compare(Path(temp) / "run", grader=TooFew())
            self.assertFalse(report["rows"][0]["baseline"]["hiddenTestsComplete"])

    def test_native_failure_recorded_but_valid_aggregate_can_run_holdout(self):
        with tempfile.TemporaryDirectory() as temp:
            report = self.run_compare(Path(temp) / "run", CodingRunner(failed_probe=True))
            self.assertFalse(report["complete"])
            self.assertTrue(report["methods"][0]["aggregateAdoptionEligible"])
            self.assertTrue(report["rows"][1]["improved"]["passed"])
            self.assertEqual(report["fallbackWarnings"][0]["stage"], "inv1")

    def test_suite_strict_no_expected_answers_paths_or_mutable_tests(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "suite.json"
            path.write_text(json.dumps(suite()))
            self.assertEqual(load_suite(path)["name"], "coding-unit")
            for mutation in (lambda t: t.update(expected="answer"),
                             lambda t: t["editableFiles"].append("test/value.test.mjs"),
                             lambda t: t["hiddenTests"].update({"../escape": "bad"}),
                             lambda t: t.update(hiddenTestCount=0)):
                data = suite()
                mutation(data["tasks"][0])
                path.write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    load_suite(path)


if __name__ == "__main__":
    unittest.main()
