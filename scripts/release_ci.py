#!/usr/bin/env python3
"""Fail-closed release checks bound to exact-SHA workflow runs and attempts."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

REQUIRED_WORKFLOWS = {
    "ci.yml": (
        "Rust lint",
        "test (ubuntu-latest, true)",
        "test (macos-latest, true)",
        "test (windows-latest, false)",
        "browser-e2e",
        "security-boundaries",
        "release-policy",
        "crate-package",
        "plugin-security",
        "msrv",
        "update-banner-windows",
        # A broken installer is a broken launch: require the isolated install test.
        "Isolated install",
    ),
    "codeql.yml": ("Analyze (rust)", "Analyze (javascript)"),
}
REQUIRED_CHECKS = tuple(name for names in REQUIRED_WORKFLOWS.values() for name in names)


def require_ancestor(tag_sha: str, main_ref: str, cwd: str | Path | None = None) -> None:
    """Reject a tag commit that is not reachable from the fetched main ref."""
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", tag_sha, main_ref],
        cwd=cwd, capture_output=True, text=True, check=False,
    )
    if result.returncode == 0:
        return
    if result.returncode == 1:
        raise ValueError(f"tag commit {tag_sha} is not an ancestor of {main_ref}")
    detail = result.stderr.strip() or result.stdout.strip() or "git merge-base failed"
    raise RuntimeError(detail)


def positive_integer(value: Any) -> bool:
    return type(value) is int and value > 0


def collection(payload: Any, field: str) -> list[dict[str, Any]]:
    """Require a complete, stable paginated API response, never a partial list."""
    pages = payload if isinstance(payload, list) else [payload]
    if not pages or any(
        not isinstance(page, dict)
        or not isinstance(page.get(field), list)
        or type(page.get("total_count")) is not int
        or page["total_count"] < 0
        for page in pages
    ):
        raise ValueError(f"GitHub did not return a valid {field} list")
    entries = [entry for page in pages for entry in page[field]]
    counts = {page["total_count"] for page in pages}
    if len(counts) != 1 or next(iter(counts)) != len(entries):
        raise ValueError(f"GitHub truncated or changed the {field} response")
    if any(not isinstance(entry, dict) or not positive_integer(entry.get("id"))
           for entry in entries):
        raise ValueError(f"GitHub returned invalid {field} entries")
    if len({entry["id"] for entry in entries}) != len(entries):
        raise ValueError(f"GitHub duplicated {field} entries during pagination")
    return entries


def run_identity(run: dict[str, Any]) -> tuple[int, int, int, int]:
    keys = ("workflow_id", "id", "run_number", "run_attempt")
    if any(not positive_integer(run.get(key)) for key in keys):
        raise ValueError("workflow run has invalid identity or attempt")
    return tuple(run[key] for key in keys)


def require_success(run: dict[str, Any]) -> None:
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise ValueError(
            f"latest workflow run {run['id']} attempt {run['run_attempt']} is "
            f"{run.get('status')}/{run.get('conclusion') or 'no conclusion'}"
        )


def select_run(payload: Any, workflow: str, sha: str, tag: str) -> dict[str, Any]:
    """Select by GitHub's per-workflow run number, not nullable start times."""
    eligible = []
    for run in collection(payload, "workflow_runs"):
        # REST path can include an @ref suffix. Workflow display names are not IDs.
        path = run.get("path")
        if not isinstance(path, str) or path.split("@", 1)[0] != f".github/workflows/{workflow}":
            raise ValueError(f"unexpected workflow path in {workflow} response")
        run_identity(run)
        if run.get("head_sha") != sha or run.get("event") != "push":
            raise ValueError(f"unexpected SHA or trigger in {workflow} response")
        branch = run.get("head_branch")
        if not isinstance(branch, str) or not branch:
            raise ValueError(f"{workflow}: missing or invalid branch identity")
        if branch in {"main", tag}:
            eligible.append(run)
    if not eligible:
        raise ValueError(f"{workflow}: missing main/tag push run for {sha}")
    if len({run["workflow_id"] for run in eligible}) != 1:
        raise ValueError(f"{workflow}: ambiguous workflow identity")
    if len({run["run_number"] for run in eligible}) != len(eligible):
        raise ValueError(f"{workflow}: ambiguous workflow run order")
    # GITHUB_RUN_NUMBER increments for each new run; reruns retain that number.
    return max(eligible, key=lambda run: run["run_number"])


def require_successful_jobs(payload: Any, run: dict[str, Any], names: tuple[str, ...]) -> None:
    """Use the latest execution of each required job within one workflow run."""
    jobs = collection(payload, "jobs")
    for job in jobs:
        if (job.get("run_id") != run["id"] or job.get("head_sha") != run["head_sha"]
                or not positive_integer(job.get("run_attempt"))
                or job["run_attempt"] > run["run_attempt"]):
            raise ValueError("job does not belong to the selected workflow run/attempt")
    for name in names:
        candidates = [job for job in jobs if job.get("name") == name]
        if not candidates:
            raise ValueError(f"{name}: missing from workflow run {run['id']}")
        # A failed-jobs-only rerun legitimately retains earlier successful jobs.
        attempt = max(job["run_attempt"] for job in candidates)
        latest = [job for job in candidates if job["run_attempt"] == attempt]
        if len(latest) != 1:
            raise ValueError(f"{name}: ambiguous jobs in attempt {attempt}")
        job = latest[0]
        if job.get("status") != "completed" or job.get("conclusion") != "success":
            raise ValueError(
                f"{name}: attempt {attempt} is "
                f"{job.get('status')}/{job.get('conclusion') or 'no conclusion'}"
            )


def github_api(endpoint: str, *, paginate: bool = False) -> Any:
    command = ["gh", "api", "--method", "GET", endpoint]
    if paginate:
        command.extend(["--paginate", "--slurp"])
    result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
    return json.loads(result.stdout)


def verify_workflows(repo: str, sha: str, tag: str, api=github_api) -> dict[str, dict[str, Any]]:
    """Validate a read-only snapshot; reject runs/attempts changing during reads."""
    selected = {}
    endpoints = {}
    query = urlencode({"head_sha": sha, "event": "push", "per_page": 100})
    for workflow, names in REQUIRED_WORKFLOWS.items():
        endpoint = f"repos/{repo}/actions/workflows/{workflow}/runs?{query}"
        endpoints[workflow] = endpoint
        run = select_run(api(endpoint, paginate=True), workflow, sha, tag)
        require_success(run)
        selected[workflow] = run
        jobs = api(f"repos/{repo}/actions/runs/{run['id']}/jobs?filter=all&per_page=100",
                   paginate=True)
        require_successful_jobs(jobs, run, names)

    # Re-list after ALL job reads: re-reading only the original run would miss a
    # newer queued run. Re-get also detects an attempt starting during pagination.
    for workflow, previous in selected.items():
        current = select_run(api(endpoints[workflow], paginate=True), workflow, sha, tag)
        if run_identity(current) != run_identity(previous):
            raise ValueError(f"{workflow}: latest run/attempt changed during verification; retry")
        require_success(current)
        fresh = api(f"repos/{repo}/actions/runs/{previous['id']}")
        if (not isinstance(fresh, dict) or run_identity(fresh) != run_identity(previous)
                or fresh.get("head_sha") != sha
                or fresh.get("event") != "push"
                or fresh.get("head_branch") != previous.get("head_branch")
                or fresh.get("path") != previous.get("path")):
            raise ValueError(f"{workflow}: workflow run changed during verification; retry")
        require_success(fresh)
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag_sha")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--main-ref", default="FETCH_HEAD")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.tag_sha):
        parser.error("tag_sha must be a full lowercase commit SHA")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        parser.error("repo must be owner/repository")
    if not re.fullmatch(r"v[0-9][A-Za-z0-9.+-]*", args.tag):
        parser.error("tag must be a version tag")
    try:
        require_ancestor(args.tag_sha, args.main_ref)
        runs = verify_workflows(args.repo, args.tag_sha, args.tag)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"release validation failed: {exc}", file=sys.stderr)
        return 1
    for workflow, run in runs.items():
        print(f"{workflow}: run {run['id']} number {run['run_number']} "
              f"attempt {run['run_attempt']} succeeded for {args.tag_sha}")
    print(f"release validation passed: all {len(REQUIRED_CHECKS)} required jobs succeeded")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
