#!/usr/bin/env python3
"""Fail-closed checks for a release tag's main ancestry and CI status."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

REQUIRED_CHECKS = (
    "Analyze (rust)",
    "Analyze (javascript)",
    "Rust lint",
    "test (ubuntu-latest, true)",
    "test (macos-latest, true)",
    "test (windows-latest, false)",
    "browser-e2e",
    "security-boundaries",
    "release-policy",
    "plugin-security",
    "msrv",
    "update-banner-windows",
)


def require_ancestor(tag_sha: str, main_ref: str, cwd: str | Path | None = None) -> None:
    """Reject a tag commit that is not reachable from the fetched main ref."""
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", tag_sha, main_ref],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return
    if result.returncode == 1:
        raise ValueError(f"tag commit {tag_sha} is not an ancestor of {main_ref}")
    detail = result.stderr.strip() or result.stdout.strip() or "git merge-base failed"
    raise RuntimeError(detail)


def _latest_run(runs: list[dict[str, Any]]) -> dict[str, Any]:
    return max(
        runs,
        key=lambda run: (
            run.get("started_at") or run.get("created_at") or "",
            int(run.get("id") or 0),
        ),
    )


def require_successful_checks(payload: Any, expected_sha: str) -> None:
    """Require the latest GitHub Actions run for every release check on this SHA."""
    pages = payload if isinstance(payload, list) else [payload]
    if not pages or any(
        not isinstance(page, dict) or not isinstance(page.get("check_runs"), list)
        for page in pages
    ):
        raise ValueError("GitHub did not return a check_runs list")
    runs = [run for page in pages for run in page["check_runs"]]
    total_counts = {
        page["total_count"] for page in pages if page.get("total_count") is not None
    }
    if len(total_counts) > 1 or (
        total_counts and next(iter(total_counts)) != len(runs)
    ):
        raise ValueError("GitHub truncated the check-runs response")

    problems: list[str] = []
    for required in REQUIRED_CHECKS:
        matches = [
            run
            for run in runs
            if run.get("name") == required
            and run.get("head_sha") == expected_sha
            and (run.get("app") or {}).get("slug") == "github-actions"
        ]
        if not matches:
            problems.append(f"{required}: missing for {expected_sha}")
            continue

        latest = _latest_run(matches)
        if latest.get("status") != "completed" or latest.get("conclusion") != "success":
            problems.append(
                f"{required}: latest run is {latest.get('status')}/"
                f"{latest.get('conclusion') or 'no conclusion'}"
            )

    if problems:
        raise ValueError("release CI is not green: " + "; ".join(problems))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag_sha")
    parser.add_argument("check_runs", type=Path)
    parser.add_argument("--main-ref", default="FETCH_HEAD")
    args = parser.parse_args()

    try:
        require_ancestor(args.tag_sha, args.main_ref)
        payload = json.loads(args.check_runs.read_text(encoding="utf-8"))
        require_successful_checks(payload, args.tag_sha)
    except (OSError, json.JSONDecodeError, ValueError, RuntimeError) as exc:
        print(f"release validation failed: {exc}", file=sys.stderr)
        return 1

    print(
        f"release validation passed: {args.tag_sha} is on {args.main_ref} "
        f"and all {len(REQUIRED_CHECKS)} required checks succeeded"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
