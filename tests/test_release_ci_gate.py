import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock


spec = importlib.util.spec_from_file_location(
    "release_ci_gate", Path(__file__).resolve().parents[1] / "scripts/verify-release-ci.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


SHA = "a" * 40
TAG = "v1.2.3-rc.1"


def run(**overrides):
    value = {
        "headSha": SHA,
        "headBranch": TAG,
        "event": "push",
        "status": "completed",
        "conclusion": "success",
        "createdAt": "2026-01-01T00:00:00Z",
        "attempt": 1,
        "databaseId": 1,
    }
    value.update(overrides)
    return value


class ReleaseCiGateTests(unittest.TestCase):
    def test_accepts_success_for_exact_sha_and_tag_push(self):
        self.assertEqual(gate.classify_runs([run()], SHA, TAG)[0], "success")

    def test_ignores_other_sha_branch_and_event(self):
        runs = [
            run(headSha="b" * 40),
            run(headBranch="main"),
            run(event="pull_request"),
        ]
        state, reason = gate.classify_runs(runs, SHA, TAG)
        self.assertEqual(state, "waiting")
        self.assertIn("waiting for ci.yml push run", reason)

    def test_missing_or_in_progress_ci_does_not_release(self):
        for runs in ([], [run(status="in_progress", conclusion=None)]):
            with self.subTest(runs=runs):
                self.assertEqual(gate.classify_runs(runs, SHA, TAG)[0], "waiting")

    def test_failed_and_cancelled_runs_are_rejected(self):
        for status, conclusion in (("completed", "failure"), ("completed", "cancelled"),
                                   ("completed", None), ("action_required", None)):
            with self.subTest(status=status, conclusion=conclusion):
                state, reason = gate.classify_runs(
                    [run(status=status, conclusion=conclusion)], SHA, TAG)
                self.assertEqual(state, "failed")
                self.assertIn("did not succeed", reason)

    def test_newest_matching_run_controls_the_gate(self):
        older_success = run(createdAt="2026-01-01T00:00:00Z")
        newer_pending = run(createdAt="2026-01-02T00:00:00Z", status="in_progress",
                            conclusion=None, databaseId=2)
        self.assertEqual(gate.classify_runs([older_success, newer_pending], SHA, TAG)[0], "waiting")

    def test_later_rerun_attempt_supersedes_failed_attempt(self):
        failed = run(status="completed", conclusion="failure", attempt=1)
        successful_retry = run(status="completed", conclusion="success", attempt=2)
        self.assertEqual(gate.classify_runs([failed, successful_retry], SHA, TAG)[0], "success")

    def test_wait_polls_until_success(self):
        reader = Mock(side_effect=[[], [run()]])
        sleeper = Mock()
        clock = Mock(side_effect=[0, 0, 1, 1])
        gate.wait_for_ci("owner/repo", SHA, TAG, timeout_seconds=10,
                         run_reader=reader, clock=clock, sleeper=sleeper)
        self.assertEqual(reader.call_count, 2)
        sleeper.assert_called_once_with(10)

    def test_wait_times_out_while_ci_is_missing(self):
        reader = Mock(return_value=[])
        sleeper = Mock()
        clock = Mock(side_effect=[0, 0, 11])
        with self.assertRaisesRegex(TimeoutError, "refusing release"):
            gate.wait_for_ci("owner/repo", SHA, TAG, timeout_seconds=10,
                             run_reader=reader, clock=clock, sleeper=sleeper)
        sleeper.assert_called_once_with(10)

    def test_queries_only_ci_runs_for_the_exact_commit(self):
        runner = Mock(return_value=subprocess.CompletedProcess(
            args=[], returncode=0, stdout="[]", stderr=""))
        self.assertEqual(gate.list_ci_runs("owner/repo", SHA, runner), [])
        command = runner.call_args.args[0]
        self.assertIn("--workflow", command)
        self.assertIn("ci.yml", command)
        self.assertIn("--commit", command)
        self.assertIn(SHA, command)


if __name__ == "__main__":
    unittest.main()
