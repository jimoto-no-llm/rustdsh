import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.release_ci import (
    REQUIRED_CHECKS, REQUIRED_WORKFLOWS, collection, github_api,
    require_ancestor, require_successful_jobs, select_run, verify_workflows,
)

SHA = "a" * 40
TAG = "v1.2.3"
REPO = "owner/repo"


def run(workflow="ci.yml", **changes):
    codeql = workflow == "codeql.yml"
    value = {
        "id": 20 if codeql else 10,
        "workflow_id": 2 if codeql else 1,
        "path": f".github/workflows/{workflow}",
        "head_sha": SHA, "event": "push", "head_branch": "main",
        "run_number": 3, "run_attempt": 1,
        "status": "completed", "conclusion": "success",
        "created_at": "2026-10-10T00:00:00Z", "run_started_at": None,
    }
    value.update(changes)
    return value


def payload(field, entries):
    return {"total_count": len(entries), field: entries}


def jobs(current, workflow="ci.yml"):
    return [
        {"id": current["id"] * 100 + index, "run_id": current["id"],
         "head_sha": SHA, "run_attempt": current["run_attempt"], "name": name,
         "status": "completed", "conclusion": "success", "started_at": None}
        for index, name in enumerate(REQUIRED_WORKFLOWS[workflow], 1)
    ]


class FakeApi:
    def __init__(self):
        self.runs = {workflow: [run(workflow)] for workflow in REQUIRED_WORKFLOWS}
        self.after = {}
        self.job_overrides = {}
        self.fresh_overrides = {}
        self.list_calls = {}
        self.calls = []

    def __call__(self, endpoint, *, paginate=False):
        self.calls.append((endpoint, paginate))
        if "/actions/workflows/" in endpoint:
            workflow = endpoint.split("/workflows/", 1)[1].split("/", 1)[0]
            count = self.list_calls.get(workflow, 0)
            self.list_calls[workflow] = count + 1
            entries = self.after.get(workflow, self.runs[workflow]) if count else self.runs[workflow]
            return copy.deepcopy(payload("workflow_runs", entries))
        run_id = int(endpoint.split("/runs/", 1)[1].split("/", 1)[0])
        workflow, current = next(
            (workflow, candidate) for workflow, entries in self.runs.items()
            for candidate in entries if candidate["id"] == run_id
        )
        if "/jobs?" in endpoint:
            return copy.deepcopy(payload("jobs", self.job_overrides.get(run_id, jobs(current, workflow))))
        return copy.deepcopy(self.fresh_overrides.get(run_id, current))


class ReleaseCiTests(unittest.TestCase):
    def test_all_latest_workflow_jobs_succeed(self):
        api = FakeApi()
        self.assertEqual(len(REQUIRED_CHECKS), 13)
        result = verify_workflows(REPO, SHA, TAG, api)
        self.assertEqual(result["ci.yml"]["id"], 10)
        self.assertEqual(api.list_calls, {"ci.yml": 2, "codeql.yml": 2})

    def test_isolated_install_must_be_present_and_successful(self):
        self.assertIn("Isolated install", REQUIRED_WORKFLOWS["ci.yml"])
        for conclusion in (None, "skipped", "failure"):
            with self.subTest(conclusion=conclusion):
                api = FakeApi()
                entries = jobs(run())
                installer = next(job for job in entries if job["name"] == "Isolated install")
                if conclusion is None:
                    entries.remove(installer)
                else:
                    installer["conclusion"] = conclusion
                api.job_overrides[10] = entries
                with self.assertRaisesRegex(ValueError, "Isolated install"):
                    verify_workflows(REPO, SHA, TAG, api)

    def test_new_queued_run_overrides_old_success_without_start_timestamp(self):
        api = FakeApi()
        api.runs["ci.yml"].append(run(id=11, run_number=4, head_branch=TAG,
                                     status="queued", conclusion=None))
        with self.assertRaisesRegex(ValueError, "queued"):
            verify_workflows(REPO, SHA, TAG, api)

    def test_old_cancelled_run_does_not_block_new_success(self):
        api = FakeApi()
        api.runs["ci.yml"].insert(0, run(id=9, run_number=2, status="completed", conclusion="cancelled"))
        verify_workflows(REPO, SHA, TAG, api)

    def test_run_order_ignores_start_time_and_numeric_id(self):
        old = run(id=9999, run_number=2, run_started_at="2099-01-01T00:00:00Z")
        new = run(id=3, run_number=3)
        self.assertEqual(select_run(payload("workflow_runs", [old, new]), "ci.yml", SHA, TAG)["id"], 3)

    def test_documented_path_ref_suffix_is_accepted(self):
        api = FakeApi()
        api.runs["ci.yml"][0]["path"] += "@main"
        verify_workflows(REPO, SHA, TAG, api)

    def test_unrelated_branch_is_not_release_evidence(self):
        api = FakeApi()
        api.runs["ci.yml"].append(run(id=11, run_number=4, head_branch="feature", status="queued", conclusion=None))
        verify_workflows(REPO, SHA, TAG, api)
        api.runs["ci.yml"] = [api.runs["ci.yml"][-1]]
        with self.assertRaisesRegex(ValueError, "missing main/tag"):
            verify_workflows(REPO, SHA, TAG, api)

    def test_unknown_branch_cannot_hide_a_newer_run(self):
        for branch in (None, "", 3, [], {}):
            with self.subTest(branch=branch):
                api = FakeApi()
                api.runs["ci.yml"].append(run(id=11, run_number=4, head_branch=branch,
                                             status="queued", conclusion=None))
                with self.assertRaisesRegex(ValueError, "branch identity"):
                    verify_workflows(REPO, SHA, TAG, api)

    def test_wrong_sha_event_and_workflow_cannot_satisfy_gate(self):
        for key, value in (("head_sha", "b" * 40), ("event", "pull_request"),
                           ("path", ".github/workflows/untrusted.yml")):
            with self.subTest(key=key):
                api = FakeApi()
                api.runs["ci.yml"][0][key] = value
                with self.assertRaisesRegex(ValueError, "unexpected"):
                    verify_workflows(REPO, SHA, TAG, api)

    def test_missing_or_ambiguous_workflow_runs_fail_closed(self):
        for entries in ([], [run(), run(id=11)], [run(), run(id=11, run_number=4, workflow_id=2)]):
            with self.subTest(entries=entries):
                api = FakeApi()
                api.runs["ci.yml"] = entries
                with self.assertRaises(ValueError):
                    verify_workflows(REPO, SHA, TAG, api)

    def test_malformed_run_identity_fails_closed(self):
        for key in ("id", "workflow_id", "run_number", "run_attempt"):
            for value in (None, True, 0, -1, "1"):
                with self.subTest(key=key, value=value):
                    api = FakeApi()
                    api.runs["ci.yml"][0][key] = value
                    with self.assertRaises(ValueError):
                        verify_workflows(REPO, SHA, TAG, api)

    def test_latest_workflow_must_complete_successfully(self):
        for status, conclusion in (("queued", None), ("in_progress", None), ("waiting", None),
                                   ("completed", "failure"), ("completed", "cancelled"),
                                   ("completed", "neutral"), ("completed", "skipped")):
            with self.subTest(status=status, conclusion=conclusion):
                api = FakeApi()
                api.runs["ci.yml"][0].update(status=status, conclusion=conclusion)
                with self.assertRaisesRegex(ValueError, "latest workflow"):
                    verify_workflows(REPO, SHA, TAG, api)

    def test_partial_rerun_keeps_earlier_successful_jobs(self):
        api = FakeApi()
        api.runs["ci.yml"][0]["run_attempt"] = 2
        previous = jobs(run())
        previous[0]["conclusion"] = "failure"
        replacement = dict(previous[0], id=5000, run_attempt=2, conclusion="success")
        api.job_overrides[10] = previous + [replacement]
        verify_workflows(REPO, SHA, TAG, api)

    def test_queued_job_on_new_attempt_cannot_use_old_success(self):
        api = FakeApi()
        api.runs["ci.yml"][0]["run_attempt"] = 2
        previous = jobs(run())
        replacement = dict(previous[0], id=5000, run_attempt=2, status="queued", conclusion=None)
        api.job_overrides[10] = previous + [replacement]
        with self.assertRaisesRegex(ValueError, "attempt 2 is queued"):
            verify_workflows(REPO, SHA, TAG, api)

    def test_old_cancelled_job_does_not_block_successful_retry(self):
        api = FakeApi()
        api.runs["ci.yml"][0]["run_attempt"] = 2
        previous = jobs(run())
        previous[0]["conclusion"] = "cancelled"
        api.job_overrides[10] = previous + [dict(previous[0], id=5000, run_attempt=2, conclusion="success")]
        verify_workflows(REPO, SHA, TAG, api)

    def test_missing_duplicate_and_unsuccessful_jobs_fail(self):
        initial = jobs(run())
        for entries in (initial[1:], initial + [dict(initial[0], id=5000)],
                        [dict(initial[0], conclusion="skipped")] + initial[1:],
                        [dict(initial[0], conclusion="neutral")] + initial[1:]):
            with self.subTest(entries=entries):
                with self.assertRaises(ValueError):
                    require_successful_jobs(payload("jobs", entries), run(), REQUIRED_WORKFLOWS["ci.yml"])

    def test_wrong_job_run_sha_or_attempt_fails(self):
        for key, value in (("run_id", 99), ("head_sha", "b" * 40), ("run_attempt", 2),
                           ("run_attempt", None), ("run_attempt", True), ("run_attempt", 0)):
            with self.subTest(key=key, value=value):
                entries = jobs(run())
                entries[0][key] = value
                with self.assertRaisesRegex(ValueError, "does not belong"):
                    require_successful_jobs(payload("jobs", entries), run(), REQUIRED_WORKFLOWS["ci.yml"])

    def test_complete_paginated_collections_are_accepted(self):
        entries = jobs(run())
        pages = [{"total_count": len(entries), "jobs": entries[:3]},
                 {"total_count": len(entries), "jobs": entries[3:]}]
        require_successful_jobs(pages, run(), REQUIRED_WORKFLOWS["ci.yml"])

    def test_truncated_duplicated_and_malformed_collections_fail(self):
        for data in ({"total_count": 2, "jobs": jobs(run())[:1]},
                     payload("jobs", [jobs(run())[0]] * 2),
                     {"jobs": []}, {"total_count": True, "jobs": []},
                     [], {"total_count": 1, "jobs": [None]}):
            with self.subTest(data=data):
                with self.assertRaises(ValueError):
                    collection(data, "jobs")

    def test_new_run_appearing_during_job_collection_fails(self):
        api = FakeApi()
        api.after["ci.yml"] = api.runs["ci.yml"] + [run(id=11, run_number=4, status="queued", conclusion=None)]
        with self.assertRaisesRegex(ValueError, "changed during verification"):
            verify_workflows(REPO, SHA, TAG, api)

    def test_attempt_starting_during_job_collection_fails(self):
        api = FakeApi()
        api.after["ci.yml"] = [run(run_attempt=2, status="queued", conclusion=None)]
        with self.assertRaisesRegex(ValueError, "changed during verification"):
            verify_workflows(REPO, SHA, TAG, api)

    def test_rerun_starting_after_final_list_fails(self):
        api = FakeApi()
        api.fresh_overrides[10] = run(run_attempt=2, status="queued", conclusion=None)
        with self.assertRaisesRegex(ValueError, "changed during verification"):
            verify_workflows(REPO, SHA, TAG, api)

    def test_status_change_without_attempt_bump_fails(self):
        api = FakeApi()
        api.fresh_overrides[10] = run(status="queued", conclusion=None)
        with self.assertRaisesRegex(ValueError, "latest workflow"):
            verify_workflows(REPO, SHA, TAG, api)

    def test_api_failures_propagate_without_accepting_partial_evidence(self):
        with self.assertRaises(subprocess.CalledProcessError):
            verify_workflows(REPO, SHA, TAG, lambda *a, **k: (_ for _ in ()).throw(subprocess.CalledProcessError(1, "gh")))

    def test_api_is_get_only_paginated_and_bounded(self):
        with patch("scripts.release_ci.subprocess.run") as runner:
            runner.return_value.stdout = json.dumps([])
            self.assertEqual(github_api("repos/owner/repo/actions/runs", paginate=True), [])
            command = runner.call_args.args[0]
            self.assertEqual(command[:4], ["gh", "api", "--method", "GET"])
            self.assertIn("--paginate", command)
            self.assertIn("--slurp", command)
            self.assertEqual(runner.call_args.kwargs["timeout"], 60)

    def test_tag_commit_must_be_an_ancestor_of_main(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.name", "Release CI test"], cwd=repo, check=True)
            subprocess.run(
                ["git", "config", "user.email", "release-ci@example.invalid"],
                cwd=repo,
                check=True,
            )
            (repo / "main.txt").write_text("main\n", encoding="utf-8")
            subprocess.run(["git", "add", "main.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-m", "main"], cwd=repo, check=True, capture_output=True)
            main_sha = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip()
            require_ancestor(main_sha, "main", cwd=repo)

            subprocess.run(["git", "switch", "-c", "outside-main"], cwd=repo, check=True, capture_output=True)
            (repo / "outside.txt").write_text("outside\n", encoding="utf-8")
            subprocess.run(["git", "add", "outside.txt"], cwd=repo, check=True)
            subprocess.run(
                ["git", "commit", "-m", "outside"], cwd=repo, check=True, capture_output=True
            )
            outside_sha = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip()

            with self.assertRaisesRegex(ValueError, "not an ancestor"):
                require_ancestor(outside_sha, main_sha, cwd=repo)


if __name__ == "__main__":
    unittest.main()
