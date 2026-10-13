#!/usr/bin/env python3
"""Report merged branches; explicit application first saves a verified Git bundle."""
import argparse
import json
from pathlib import Path
import subprocess


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True,
                                   stderr=subprocess.PIPE).strip()


def checked_out(repo):
    return {
        line.removeprefix("branch refs/heads/")
        for line in git(repo, "worktree", "list", "--porcelain").splitlines()
        if line.startswith("branch refs/heads/")
    }


def open_branches(repository):
    raw = subprocess.check_output([
        "gh", "pr", "list", "--repo", repository, "--state", "open",
        "--limit", "1000", "--json", "headRefName",
    ], text=True)
    rows = json.loads(raw)
    if len(rows) >= 1000:
        raise RuntimeError("Open PR listing may be incomplete; refusing cleanup")
    return {row["headRefName"] for row in rows}


def inventory(repo, opened, base="origin/main"):
    base_sha = git(repo, "rev-parse", "--verify", base + "^{commit}")
    protected = checked_out(repo) | opened | {"main", "master", "HEAD"}
    live = {ref.removeprefix("refs/heads/"): sha for sha, ref in
            (line.split() for line in git(repo, "ls-remote", "--heads", "origin").splitlines())}
    refs = git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)",
               "refs/heads", "refs/remotes/origin").splitlines()
    rows = []
    for line in refs:
        fields = line.split()
        ref, sha = fields[:2]
        remote = ref.startswith("refs/remotes/origin/")
        name = ref.removeprefix("refs/remotes/origin/" if remote else "refs/heads/")
        result = subprocess.run([
            "git", "-C", str(repo), "merge-base", "--is-ancestor", sha, base_sha,
        ], capture_output=True)
        if result.returncode not in (0, 1):
            raise RuntimeError("Cannot establish branch ancestry")
        reasons = []
        if len(fields) > 2 or name in protected:
            reasons.append("active_or_open_pr_or_primary")
        if name.startswith(("archive/", "release/")):
            reasons.append("retained_history")
        if result.returncode:
            reasons.append("not_merged")
        if remote and name not in live:
            reasons.append("stale_remote_tracking_ref")
        elif remote and live[name] != sha:
            reasons.append("remote_head_changed")
        rows.append({"ref": ref, "name": name, "sha": sha, "remote": remote,
                     "candidate": not reasons, "keep_reasons": reasons})
    return {"schema": 1, "base": base, "base_sha": base_sha, "refs": rows}


def apply(repo, plan, backup, opened, include_remote=False):
    candidates = [row for row in plan["refs"] if row["candidate"] and
                  (include_remote or not row["remote"])]
    if not candidates:
        return {"deleted": [], "backup": None}
    # Do not overwrite an earlier recovery point or put it inside a worktree.
    backup = Path(backup).resolve()
    trees = [Path(line.removeprefix("worktree ")).resolve() for line in
             git(repo, "worktree", "list", "--porcelain").splitlines()
             if line.startswith("worktree ")]
    if any(backup == tree or tree in backup.parents for tree in trees):
        raise RuntimeError("Backup must be outside all worktrees")
    backup.mkdir(parents=True, exist_ok=False)
    bundle = backup / "refs.bundle"
    git(repo, "bundle", "create", str(bundle), "--all")
    git(repo, "bundle", "verify", str(bundle))
    bundle.chmod(0o600)
    (backup / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    deleted = []
    # Exact SHA leases refuse changes made since the inventory. Protect live
    # worktrees again immediately before touching each local reference.
    try:
        for row in candidates:
            if row["name"] in opened | checked_out(repo):
                raise RuntimeError("Branch became active; refusing cleanup")
            if row["remote"]:
                git(repo, "push",
                    f"--force-with-lease=refs/heads/{row['name']}:{row['sha']}",
                    "origin", f":refs/heads/{row['name']}")
            else:
                git(repo, "update-ref", "-d", row["ref"], row["sha"])
            deleted.append(row["ref"])
            (backup / "result.json").write_text(json.dumps({"deleted": deleted}, indent=2) + "\n")
    finally:
        (backup / "result.json").write_text(json.dumps({"deleted": deleted}, indent=2) + "\n")
    return {"deleted": deleted, "backup": str(backup)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default="jimoto-no-llm/rustdsh")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--include-remote", action="store_true")
    parser.add_argument("--backup-dir", type=Path)
    args = parser.parse_args()
    if args.apply and not args.backup_dir:
        parser.error("--apply requires --backup-dir outside the checkout")
    repo = Path(git(Path.cwd(), "rev-parse", "--show-toplevel"))
    origin = git(repo, "remote", "get-url", "origin").removesuffix(".git")
    if origin not in {f"https://github.com/{args.repository}",
                      f"git@github.com:{args.repository}",
                      f"ssh://git@github.com/{args.repository}"}:
        parser.error("origin must match the selected GitHub repository")
    # A failed GitHub read is fatal, even for reporting. No empty fallback.
    opened = open_branches(args.repository)
    plan = inventory(repo, opened)
    if args.apply:
        result = apply(repo, plan, args.backup_dir, open_branches(args.repository), args.include_remote)
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(plan, indent=2))


if __name__ == "__main__":
    main()
