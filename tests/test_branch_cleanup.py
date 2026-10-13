import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/prune-merged-branches.py"
spec = importlib.util.spec_from_file_location("branch_cleanup", SCRIPT)
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class BranchCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="rdsh-branch-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "--initial-branch=main")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Branch fixture")
        (self.repo / "code.txt").write_text("base\n")
        self.git("add", "code.txt")
        self.git("commit", "-m", "base")
        self.base = self.git("rev-parse", "HEAD")
        self.remote_path = self.root / "remote.git"
        subprocess.check_output(["git", "init", "--bare", "--initial-branch=main", str(self.remote_path)])
        self.git("remote", "add", "origin", str(self.remote_path))
        self.git("push", "origin", "main")
        self.git("update-ref", "refs/remotes/origin/main", self.base)
        for name in ["merged", "open-pr", "archive/kept", "release/kept", "active"]:
            self.git("branch", name)
        self.git("worktree", "add", str(self.root / "active"), "active")
        self.git("switch", "-c", "unmerged")
        (self.repo / "code.txt").write_text("unmerged\n")
        self.git("commit", "-am", "unmerged")
        self.git("switch", "main")

    def git(self, *args):
        return cleanup.git(self.repo, *args)

    def plan(self):
        return cleanup.inventory(self.repo, {"open-pr"})

    def test_inventory_preserves_primary_active_open_and_unmerged_refs(self):
        before = self.git("show-ref")
        plan = self.plan()
        self.assertEqual([r["name"] for r in plan["refs"] if r["candidate"]], ["merged"])
        self.assertEqual(self.git("show-ref"), before)

    def test_apply_backs_up_then_removes_only_merged_branch_and_can_restore_it(self):
        backup = self.root / "backup"
        result = cleanup.apply(self.repo, self.plan(), backup, {"open-pr"})
        self.assertEqual(result["deleted"], ["refs/heads/merged"])
        self.assertTrue((backup / "refs.bundle").is_file())
        self.assertEqual(json.loads((backup / "result.json").read_text())["deleted"], result["deleted"])
        self.git("fetch", str(backup / "refs.bundle"), "refs/heads/merged:refs/heads/merged")
        self.assertEqual(self.git("rev-parse", "merged"), self.base)

    def test_changed_or_newly_active_branch_is_not_deleted(self):
        plan = self.plan()
        self.git("update-ref", "refs/heads/merged", self.git("rev-parse", "unmerged"))
        with self.assertRaises(subprocess.CalledProcessError):
            cleanup.apply(self.repo, plan, self.root / "changed-backup", {"open-pr"})
        self.assertEqual(self.git("rev-parse", "merged"), self.git("rev-parse", "unmerged"))
        self.git("update-ref", "refs/heads/merged", self.base)
        with self.assertRaises(RuntimeError):
            cleanup.apply(self.repo, self.plan(), self.root / "open-backup", {"open-pr", "merged"})
        self.assertEqual(self.git("rev-parse", "merged"), self.base)

    def test_backup_cannot_replace_existing_recovery_point_or_use_a_worktree(self):
        with self.assertRaises(RuntimeError):
            cleanup.apply(self.repo, self.plan(), self.repo / "backup", set())
        backup = self.root / "already-there"
        backup.mkdir()
        with self.assertRaises(FileExistsError):
            cleanup.apply(self.repo, self.plan(), backup, set())
        self.assertEqual(self.git("rev-parse", "merged"), self.base)

    def remote(self):
        self.git("push", "origin", "main", "merged", "unmerged")
        return self.remote_path

    def test_deleted_or_changed_live_branches_are_excluded_from_plan(self):
        remote = self.remote()
        cleanup.git(remote, "update-ref", "-d", "refs/heads/merged")
        row = next(r for r in self.plan()["refs"] if r["ref"] == "refs/remotes/origin/merged")
        self.assertFalse(row["candidate"])
        self.assertIn("stale_remote_tracking_ref", row["keep_reasons"])
        cleanup.git(remote, "update-ref", "refs/heads/merged", self.git("rev-parse", "unmerged"))
        row = next(r for r in self.plan()["refs"] if r["ref"] == "refs/remotes/origin/merged")
        self.assertFalse(row["candidate"])
        self.assertIn("remote_head_changed", row["keep_reasons"])

    def test_remote_cleanup_keeps_main_and_unmerged_history(self):
        remote = self.remote()
        plan = self.plan()
        cleanup.apply(self.repo, plan, self.root / "remote-backup", {"open-pr"}, include_remote=True)
        refs = cleanup.git(remote, "for-each-ref", "--format=%(refname)")
        self.assertNotIn("refs/heads/merged", refs.splitlines())
        self.assertIn("refs/heads/main", refs.splitlines())
        self.assertIn("refs/heads/unmerged", refs.splitlines())

    def test_remote_head_change_rejects_the_deletion_lease(self):
        remote = self.remote()
        plan = self.plan()
        changed = self.git("rev-parse", "unmerged")
        cleanup.git(remote, "update-ref", "refs/heads/merged", changed)
        with self.assertRaises(subprocess.CalledProcessError):
            cleanup.apply(self.repo, plan, self.root / "lease-backup", {"open-pr"}, include_remote=True)
        self.assertEqual(cleanup.git(remote, "rev-parse", "merged"), changed)


if __name__ == "__main__":
    unittest.main()
