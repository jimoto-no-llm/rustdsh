import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.release_ci import REQUIRED_CHECKS, require_ancestor, require_successful_checks


SHA = "a" * 40


def passing_payload(sha=SHA):
    return {
        "total_count": len(REQUIRED_CHECKS),
        "check_runs": [
            {
                "id": index,
                "name": name,
                "head_sha": sha,
                "status": "completed",
                "conclusion": "success",
                "started_at": "2026-10-10T00:00:00Z",
                "app": {"slug": "github-actions"},
            }
            for index, name in enumerate(REQUIRED_CHECKS, start=1)
        ],
    }


class ReleaseCiTests(unittest.TestCase):
    def test_all_latest_checks_for_exact_sha_must_be_successful(self):
        require_successful_checks(passing_payload(), SHA)

    def test_paginated_check_runs_are_combined_before_validation(self):
        payload = passing_payload()
        runs = payload["check_runs"]
        pages = [
            {"total_count": len(runs), "check_runs": runs[:5]},
            {"total_count": len(runs), "check_runs": runs[5:]},
        ]

        require_successful_checks(pages, SHA)

    def test_missing_check_fails_closed(self):
        payload = passing_payload()
        payload["check_runs"].pop()
        payload["total_count"] -= 1

        with self.assertRaisesRegex(ValueError, "missing for"):
            require_successful_checks(payload, SHA)

    def test_in_progress_or_failed_check_fails_closed(self):
        for status, conclusion in (("in_progress", None), ("completed", "failure")):
            with self.subTest(status=status, conclusion=conclusion):
                payload = passing_payload()
                payload["check_runs"][0]["status"] = status
                payload["check_runs"][0]["conclusion"] = conclusion

                with self.assertRaisesRegex(ValueError, "latest run"):
                    require_successful_checks(payload, SHA)

    def test_check_for_another_sha_does_not_satisfy_requirement(self):
        payload = passing_payload(sha="b" * 40)

        with self.assertRaisesRegex(ValueError, "missing for"):
            require_successful_checks(payload, SHA)

    def test_same_named_check_from_another_app_is_not_trusted(self):
        payload = passing_payload()
        payload["check_runs"][0]["app"]["slug"] = "untrusted-app"

        with self.assertRaisesRegex(ValueError, "missing for"):
            require_successful_checks(payload, SHA)

    def test_newer_pending_run_overrides_older_success(self):
        payload = passing_payload()
        newer = dict(payload["check_runs"][0])
        newer.update(
            id=999,
            status="in_progress",
            conclusion=None,
            started_at="2026-10-11T00:00:00Z",
        )
        payload["check_runs"].append(newer)
        payload["total_count"] += 1

        with self.assertRaisesRegex(ValueError, "latest run is in_progress"):
            require_successful_checks(payload, SHA)

    def test_truncated_api_response_fails_closed(self):
        payload = passing_payload()
        payload["total_count"] += 1

        with self.assertRaisesRegex(ValueError, "truncated"):
            require_successful_checks(payload, SHA)

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
