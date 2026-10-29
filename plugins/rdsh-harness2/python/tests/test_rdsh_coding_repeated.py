import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

from rdsh_coding import CodingBenchmarkAdapter, compare_coding
from rdsh_coding_repeated import (
    BoundedRunner, atomic_json, binomial_p, evaluate, prepare, read_json,
    run_arm, summarize, train_round, training_record,
    validate_training_manifest, file_sha,
)
from rdsh_harness2 import fingerprint
from test_rdsh_coding import CodingRunner, FakeGrader, suite


class RepeatedTests(unittest.TestCase):
    def external_training(self, root, value=None, runner=None):
        value = value or suite()
        train = dict(value, name="external-independent-training", tasks=[value["tasks"][0]])
        compare_coding(train, root, runner or CodingRunner(), grader=FakeGrader())
        return root / "report.json"

    def test_three_actual_upstream_training_rounds_frozen_pairs_and_no_duplicate_resume(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            value = suite()
            value["tasks"].append({**copy.deepcopy(value["tasks"][1]), "id": "other-unseen"})
            supplied = [self.external_training(root / f"external-{i}", value) for i in range(3)]
            output = prepare(root / "experiment", {"suite": value}, False)
            runners = []
            lock = threading.Lock()

            def factory():
                runner = CodingRunner()
                with lock:
                    runners.append(runner)
                return runner

            report = evaluate(value, output, factory, FakeGrader, rounds=3,
                              workers=2, supplied_reports=supplied)
            self.assertTrue(report["complete"])
            self.assertEqual(report["summary"]["pairs"], 6)
            self.assertEqual(report["summary"]["improved"]["passed"], 6)
            self.assertEqual(report["summary"]["timing"]["trainingNativeWallMs"], 105)
            self.assertEqual(sum(len(r.records) for r in runners), 12)
            self.assertTrue(all(record["role"] == "solver" for r in runners for record in r.records))
            before = sum(len(r.records) for r in runners)
            evaluate(value, output, factory, FakeGrader, rounds=3, workers=2, supplied_reports=supplied)
            self.assertEqual(sum(len(r.records) for r in runners), before)
            self.assertEqual({tuple(r["order"]) for r in report["rows"]},
                             {("baseline", "improved"), ("improved", "baseline")})

    def test_training_validation_rejects_changed_fixture_route_or_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            report = self.external_training(Path(temp) / "external")
            self.assertEqual(training_record(report, suite(), "test", "unit")["state"], "available")
            changed = suite()
            changed["tasks"][0]["prompt"] += " changed"
            with self.assertRaises(ValueError):
                training_record(report, changed, "test", "unit")
            with self.assertRaises(ValueError):
                training_record(report, suite(), "other", "unit")
            (report.parent / "frozen-harness" / "tool-guidance.md").write_text("changed")
            with self.assertRaises(ValueError):
                training_record(report, suite(), "test", "unit")

    def test_external_training_code_changes_require_explicit_narrow_exception(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "manifest.json"
            suite_path = Path(temp) / "suite.json"
            atomic_json(suite_path, suite())
            atomic_json(path, {"provider": "test", "model": "unit", "rounds": 3,
                "timeoutMs": 600000, "maxSteps": 24, "suiteSha256": file_sha(suite_path),
                "codeSha256": {"coding-tools.mjs": "old", "runner.mjs": "stable"}})
            kwargs = dict(provider="test", model="unit", rounds=3, timeout_ms=600000, max_steps=24)
            current = {"coding-tools.mjs": "new", "runner.mjs": "stable"}
            reports = [{"suiteSha256": fingerprint(suite())}]
            with self.assertRaises(ValueError):
                validate_training_manifest(path, current, reports, **kwargs)
            permitted = validate_training_manifest(path, current, reports,
                allowed_changes=["coding-tools.mjs"], **kwargs)
            self.assertEqual(set(permitted["explicitlyAllowedCodeChanges"]), {"coding-tools.mjs"})
            self.assertEqual(permitted["manifestSuiteHashKind"], "raw-bytes")
            self.assertNotEqual(permitted["suiteRawBytesSha256"], permitted["suiteCanonicalJsonSha256"])
            current["runner.mjs"] = "changed"
            with self.assertRaises(ValueError):
                validate_training_manifest(path, current, reports,
                    allowed_changes=["coding-tools.mjs"], **kwargs)

    def test_unavailable_aggregate_still_executes_baseline_and_never_substitutes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = self.external_training(root / "external", runner=CodingRunner(unchanged=True))
            self.assertEqual(training_record(path, suite(), "test", "unit")["state"], "unavailable")
            output = prepare(root / "experiment", {"suite": suite()}, False)
            runner = CodingRunner()
            report = evaluate(suite(), output, lambda: runner, FakeGrader, rounds=1,
                              workers=1, supplied_reports=[path])
            self.assertFalse(report["complete"])
            self.assertEqual(len(runner.records), 1)
            self.assertEqual(report["rows"][0]["improved"]["state"], "unavailable")
            self.assertTrue(report["rows"][0]["baseline"]["score"]["passed"])
            self.assertEqual(report["summary"]["improved"]["successRate"], 0)

    def test_incomplete_training_is_not_retried(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            atomic_json(root / "round-01" / "training-started.json", {})
            runner = CodingRunner()
            result = train_round(1, root, suite(), lambda: runner)
            self.assertEqual(result["state"], "interrupted")
            self.assertEqual(runner.records, [])

    def test_interrupted_solver_does_not_retry_and_finished_artifact_can_be_graded(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runner = CodingRunner()
            task = suite()["tasks"][1]
            atomic_json(root / "missing" / "run-started.json", {})
            result = run_arm(root / "missing", suite(), task, "baseline", None,
                             lambda: runner, FakeGrader)
            self.assertEqual(result["state"], "interrupted")
            self.assertEqual(runner.records, [])
            completed = root / "finished"
            atomic_json(completed / "run-started.json", {})
            adapter = CodingBenchmarkAdapter(dict(suite(), tasks=[task]), completed / "adapter",
                                              runner, grader=FakeGrader())
            adapter.execute(task["id"], None, "solver")
            result = run_arm(completed, suite(), task, "baseline", None, lambda: runner, FakeGrader)
            self.assertTrue(result["score"]["passed"])
            self.assertTrue(result["resumedCompletedArtifact"])
            self.assertEqual(len(runner.records), 1)

    def test_manifest_mismatch_preserves_existing_and_atomic_private_files(self):
        with tempfile.TemporaryDirectory() as temp:
            manifest = {"suite": suite(), "hash": "frozen"}
            root = prepare(Path(temp) / "experiment", manifest, False)
            self.assertEqual(prepare(root, manifest, True), root)
            with self.assertRaises(ValueError):
                prepare(root, dict(manifest, hash="new"), True)
            with self.assertRaises(ValueError):
                prepare(root, manifest, False)
            self.assertEqual(read_json(root / "manifest.json"), manifest)
            self.assertEqual((root / "manifest.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(root.glob("*.tmp-*")), [])

    def test_native_semaphore_bounds_independent_callers(self):
        counters = {"active": 0, "max": 0}
        lock = threading.Lock()
        class Probe:
            def invoke(self):
                with lock:
                    counters["active"] += 1
                    counters["max"] = max(counters["max"], counters["active"])
                time.sleep(0.01)
                with lock:
                    counters["active"] -= 1
        limited = BoundedRunner(Probe(), threading.BoundedSemaphore(2))
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: limited.invoke(), range(16)))
        self.assertEqual(counters["max"], 2)

    def test_paired_statistics_cost_and_negative_effect_have_no_infinite_ratios(self):
        def arm(ok):
            return {"state": "completed", "wallMs": 100,
                    "score": {"passed": ok, "modelWallMs": 100, "nativeCompleted": True,
                              "gradingWallMs": 2, "hidden": {"passed": 8 if ok else 7, "tests": 8}}}
        rows = [{"round": r, "taskId": t, "baseline": arm(False), "improved": arm(True)}
                for r in range(1, 4) for t in ("a", "b")]
        training = [{"state": "available", "wallMs": 1000, "nativeWallMs": 1000,
                     "additionalNativeOverTrainingBaselineMs": 800} for _ in range(3)]
        summary = summarize(rows, training, seed=3, total_wall_ms=1234)
        self.assertEqual(summary["netAdditionalSuccesses"], 6)
        self.assertAlmostEqual(summary["timing"]["additionalSecondsPerNetSuccess"], 0.4)
        self.assertEqual(summary["timing"]["fullPipelineAdditionalSecondsPerNetSuccess"], 0.5)
        self.assertEqual(summary["taskClusterBootstrap"]["rateDifference95Percentile"], [1, 1])
        self.assertEqual(summary["oracleAnySuccessAcrossRounds"]["improved"], 2)
        self.assertEqual(binomial_p(6, 0), 0.03125)
        for row in rows:
            row["baseline"], row["improved"] = row["improved"], row["baseline"]
        summary = summarize(rows, training, seed=3, total_wall_ms=1234)
        self.assertIsNone(summary["timing"]["additionalSecondsPerNetSuccess"])
        self.assertIsNone(summary["amortization"][0]["breakEvenRepairSeconds"])
        json.dumps(summary, allow_nan=False)

    def test_incomplete_timing_never_yields_definite_cost_or_break_even(self):
        arm = {"state": "completed", "score": {"passed": True, "nativeCompleted": True,
               "modelWallMs": 100, "hidden": {"passed": 1, "tests": 1}}, "wallMs": 100}
        row = {"round": 1, "taskId": "a", "baseline": {"state": "interrupted", "score": None}, "improved": arm}
        training = [{"state": "interrupted", "nativeWallMs": None, "wallMs": None}]
        result = summarize([row], training, seed=1, total_wall_ms=100)
        self.assertFalse(result["timing"]["nativeCostTimingComplete"])
        self.assertIsNone(result["timing"]["fullPipelineAdditionalNativeMs"])
        self.assertIsNone(result["timing"]["additionalSecondsPerNetSuccess"])
        self.assertIsNone(result["repairTimeScenarios"][0]["fromScratchNetSecondsSaved"])
        self.assertIsNone(result["amortization"][0]["breakEvenRepairSeconds"])
        self.assertEqual(result["timing"]["missingTrainingTimings"], 1)
        self.assertFalse(result["timing"]["transportCostTimingComplete"])
        self.assertIsNone(result["timing"]["additionalTransportSecondsPerNetSuccess"])

    def test_host_transport_costs_remain_available_when_native_failure_time_is_unknown(self):
        baseline = {"state": "completed", "nativeTransportWallMs": 100,
                    "score": {"passed": False, "nativeCompleted": False, "modelWallMs": 0}}
        improved = {"state": "completed", "nativeTransportWallMs": 200,
                    "score": {"passed": True, "nativeCompleted": True, "modelWallMs": 150}}
        training = [{"state": "available", "nativeWallMs": None,
                     "additionalNativeOverTrainingBaselineMs": None, "transportWallMs": 1000,
                     "additionalOverTrainingBaselineMs": 800, "wallMs": 1100}]
        result = summarize([{"round": 1, "taskId": "a", "baseline": baseline, "improved": improved}],
                           training, seed=1, total_wall_ms=100)
        self.assertFalse(result["timing"]["nativeCostTimingComplete"])
        self.assertIsNone(result["timing"]["additionalSecondsPerNetSuccess"])
        self.assertTrue(result["timing"]["transportCostTimingComplete"])
        self.assertEqual(result["timing"]["plannedIncrementalAdditionalTransportMs"], 900)
        self.assertEqual(result["timing"]["fullPipelineAdditionalTransportMs"], 1100)
        self.assertEqual(result["timing"]["additionalTransportSecondsPerNetSuccess"], 0.9)
        self.assertEqual(result["timing"]["fullPipelineAdditionalTransportSecondsPerNetSuccess"], 1.1)
        self.assertEqual(result["repairTimeScenarios"][0]["plannedIncrementalTransportNetSecondsSaved"], 59.1)
        self.assertEqual(result["repairTimeScenarios"][0]["fromScratchTransportNetSecondsSaved"], 58.9)
        self.assertAlmostEqual(result["amortization"][0]["additionalTransportSecondsPerTask"], 0.2)
        self.assertAlmostEqual(result["amortization"][0]["fromScratchAdditionalTransportSecondsPerTask"], 0.225)
        self.assertAlmostEqual(result["amortization"][0]["breakEvenTransportRepairSeconds"], 0.2)
        training[0]["transportWallMs"] = None
        result = summarize([{"round": 1, "taskId": "a", "baseline": baseline, "improved": improved}],
                           training, seed=1, total_wall_ms=100)
        self.assertFalse(result["timing"]["transportCostTimingComplete"])
        self.assertIsNone(result["timing"]["fullPipelineAdditionalTransportSecondsPerNetSuccess"])
        self.assertIsNone(result["amortization"][0]["fromScratchBreakEvenTransportRepairSeconds"])

    def test_semantic_analysis_excludes_native_failures_but_keeps_legitimate_test_failures(self):
        def arm(native, ok, count=8):
            return {"state": "completed", "score": {"passed": ok, "nativeCompleted": native,
                    "modelWallMs": 100, "hidden": {"passed": count if ok else count - 1, "tests": count}}}
        rows = [{"round": 1, "taskId": "a", "expectedHiddenTests": 8,
                 "baseline": arm(True, False), "improved": arm(True, True)},
                {"round": 1, "taskId": "b", "expectedHiddenTests": 8,
                 "baseline": arm(False, False), "improved": arm(True, True)},
                {"round": 1, "taskId": "c", "expectedHiddenTests": 8,
                 "baseline": arm(True, False, count=7), "improved": arm(True, True)}]
        result = summarize(rows, [], seed=1, total_wall_ms=0)
        self.assertEqual(result["completedPairs"], 3)
        self.assertEqual(result["semanticEligiblePairs"]["pairs"], 1)
        self.assertEqual(result["semanticEligiblePairs"]["wins"], 1)
        self.assertEqual(result["improvementPairs"], 3)


if __name__ == "__main__":
    unittest.main()
