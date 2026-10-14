#!/usr/bin/env python3
"""Wait for the exact tag-push CI run to succeed before building a release."""
import argparse
import json
import re
import subprocess
import sys
import time


CI_WORKFLOW = "ci.yml"
RUN_FIELDS = "headSha,headBranch,event,status,conclusion,createdAt,attempt,databaseId"
ACTIVE_STATUSES = {"queued", "in_progress", "requested", "waiting", "pending"}
SHA_PATTERN = re.compile(r"[0-9a-fA-F]{40}")


def latest_tag_run(runs, sha, tag):
    """Select the newest push run for this exact tag and commit."""
    matching = [
        run for run in runs
        if run.get("headSha", "").lower() == sha.lower()
        and run.get("headBranch") == tag
        and run.get("event") == "push"
    ]
    if not matching:
        return None

    def sort_key(run):
        return (
            run.get("createdAt", ""),
            int(run.get("attempt") or 1),
            int(run.get("databaseId") or 0),
        )

    return max(matching, key=sort_key)


def classify_runs(runs, sha, tag):
    """Return waiting/success/failed and a concise reason for the latest run."""
    run = latest_tag_run(runs, sha, tag)
    if run is None:
        return "waiting", f"waiting for {CI_WORKFLOW} push run for {tag} at {sha}"

    status = run.get("status")
    if status in ACTIVE_STATUSES:
        return "waiting", f"{CI_WORKFLOW} for {tag} at {sha} is {status}"
    if status == "completed" and run.get("conclusion") == "success":
        return "success", f"{CI_WORKFLOW} succeeded for {tag} at {sha}"
    return "failed", (
        f"{CI_WORKFLOW} for {tag} at {sha} did not succeed "
        f"(status={status!r}, conclusion={run.get('conclusion')!r})"
    )


def list_ci_runs(repo, sha, runner=subprocess.run):
    command = [
        "gh", "run", "list", "--repo", repo, "--workflow", CI_WORKFLOW,
        "--commit", sha, "--limit", "100", "--json", RUN_FIELDS,
    ]
    result = runner(command, check=True, capture_output=True, text=True)
    runs = json.loads(result.stdout)
    if not isinstance(runs, list):
        raise ValueError("gh run list returned an unexpected JSON value")
    return runs


def wait_for_ci(repo, sha, tag, timeout_seconds=900, poll_seconds=15,
                run_reader=list_ci_runs, clock=time.monotonic, sleeper=time.sleep):
    deadline = clock() + timeout_seconds
    while True:
        state, message = classify_runs(run_reader(repo, sha), sha, tag)
        print(message, flush=True)
        if state == "success":
            return message
        if state == "failed":
            raise RuntimeError(message)
        remaining = deadline - clock()
        if remaining <= 0:
            raise TimeoutError(
                f"timed out after {timeout_seconds}s: {message}; refusing release"
            )
        sleeper(min(poll_seconds, remaining))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sha", help="exact commit SHA recorded by the tag push")
    parser.add_argument("tag", help="version tag whose push-triggered CI must pass")
    parser.add_argument("--repo", default=None, help="GitHub owner/repository")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--poll-seconds", type=int, default=15)
    args = parser.parse_args(argv)
    if not SHA_PATTERN.fullmatch(args.sha):
        parser.error("sha must be a full 40-character commit ID")
    if not args.tag.startswith("v") or args.tag in {"v", "v/", "v.."}:
        parser.error("tag must be a version tag beginning with 'v'")
    if args.timeout_seconds <= 0 or args.poll_seconds <= 0:
        parser.error("timeout and poll intervals must be positive")

    repo = args.repo
    if repo is None:
        repo = subprocess.run(
            ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    try:
        wait_for_ci(repo, args.sha.lower(), args.tag,
                    args.timeout_seconds, args.poll_seconds)
    except (RuntimeError, TimeoutError, subprocess.CalledProcessError, ValueError) as error:
        print(f"release gate failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
