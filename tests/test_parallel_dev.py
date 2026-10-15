"""Offline regression tests: python3 -m unittest discover -s tests -p test_parallel_dev.py.

RDSH_PARALLEL_SCRIPT / RDSH_CONFLICT_SCRIPT select a before-version copy.
RDSH_PARALLEL_TEST_TMPDIR keeps every disposable repository in a chosen directory.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
SCRIPT = Path(os.environ.get("RDSH_PARALLEL_SCRIPT", REPO / "scripts/parallel-dev.sh")).resolve()
CHECK = Path(os.environ.get("RDSH_CONFLICT_SCRIPT", REPO / "scripts/check-pr-conflicts.sh")).resolve()
GIT = Path(shutil.which("git")).resolve()
BASH = str(GIT.parent.parent / "bin/bash.exe") if os.name == "nt" else shutil.which("bash")


class ParallelDevTests(unittest.TestCase):
    def setUp(self):
        parent = Path(os.environ.get("RDSH_PARALLEL_TEST_TMPDIR", tempfile.gettempdir())).resolve()
        parent.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix="parallel-dev-", dir=parent)).resolve()
        self.assertEqual(self.root.parent, parent)
        self.repo = self.root / "repo"
        self.remote = self.root / "remote.git"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env = dict(os.environ)
        for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
                     "RDSH_PARALLEL_REMOTE", "RDSH_PARALLEL_BASE_REF", "RDSH_PARALLEL_PORT_BASE"):
            self.env.pop(name, None)
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_TERMINAL_PROMPT="0", TMPDIR=self.root.as_posix(),
                        RDSH_TEST_BIN=self.bin.as_posix(),
                        PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.shim("python3", '#!/usr/bin/env bash\nexec "' + Path(sys.executable).as_posix() + '" "$@"\n')
        self.shim("gh", """#!/usr/bin/env bash
case "$1 $2" in
  'auth status') exit 0 ;;
  'pr list') printf '%s\\n' '[{"number":1,"title":"ok","headRefName":"topic","baseRefName":"main","mergeable":"MERGEABLE"},{"number":2,"title":"conflict","headRefName":"topic","baseRefName":"main","mergeable":"CONFLICTING"}]' ;;
  *) exit 99 ;;
esac
""")
        self.git("init", "--initial-branch=main", str(self.repo), cwd=self.root)
        self.commit(self.repo, "initial")
        self.git("clone", "--bare", str(self.repo), str(self.remote), cwd=self.root)
        self.git("remote", "add", "origin", str(self.remote))
        self.git("fetch", "origin", "+refs/heads/*:refs/remotes/origin/*")

    def tearDown(self):
        # Only our resolved, freshly allocated fixture is recursively removed.
        expected = Path(os.environ.get("RDSH_PARALLEL_TEST_TMPDIR", tempfile.gettempdir())).resolve()
        self.assertEqual(self.root.parent, expected)
        self.assertTrue(self.root.name.startswith("parallel-dev-"))
        def make_writable(function, path, _error):
            self.safe(path)
            os.chmod(path, 0o700)
            function(path)
        shutil.rmtree(self.root, onerror=make_writable)

    def safe(self, path):
        resolved = Path(path).resolve()
        self.assertTrue(resolved.is_relative_to(self.root), str(resolved))
        self.assertNotEqual(resolved, self.root)
        return resolved

    def shim(self, name, text):
        path = self.safe(self.bin / name)
        path.write_text(text, encoding="utf-8", newline="\n")
        path.chmod(0o755)

    def git(self, *args, cwd=None, check=True):
        result = subprocess.run([str(GIT), *args], cwd=cwd or self.repo, env=self.env,
                                text=True, encoding="utf-8", capture_output=True, timeout=30)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result

    def commit(self, directory, text):
        self.safe(directory / "fixture.txt").write_text(text, encoding="utf-8")
        self.git("add", ".", cwd=directory)
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-m", text, cwd=directory)

    def worktree(self, slug="topic"):
        return self.safe(self.root / ".worktrees" / ("rustdsh-" + slug))

    def command(self, *args, cwd=None, env=None, script=SCRIPT, check=True):
        if args and args[0] == "remove":
            slug = next(arg for arg in args[1:] if not arg.startswith("-"))
            self.safe(self.worktree(slug))
        result = subprocess.run(self.shell_command(script, args),
                                cwd=cwd or self.repo, env=env or self.env,
                                text=True, encoding="utf-8", capture_output=True, timeout=45)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result

    def shell_command(self, script, args):
        # Git Bash prepends its own Git to PATH at startup. Restore the fixture
        # shims after startup so error injection cannot silently call real Git.
        return [BASH, "--noprofile", "--norc", "-c",
                'export PATH="$(cd "$RDSH_TEST_BIN" && pwd -P):$PATH"; exec bash "$@"',
                "parallel-dev-test", script.as_posix(), *args]

    def new(self, slug="topic"):
        self.command("new", slug)
        return self.worktree(slug)

    def git_shim(self):
        # Pause only synthetic fixture Git calls. No GitHub/real remote is used.
        self.shim("git", '''#!/usr/bin/env bash
if [ "${1:-}" = -C ]; then
  dir="$2"; shift 2
  if [ "${1:-}" = status ] && [ "${RDSH_TEST_STATUS_FAIL:-}" = 1 ]; then
    printf 'fixture status unavailable\\n' >&2; exit 42
  fi
  if [ "${1:-}" = rev-list ] && [ "${RDSH_TEST_HISTORY_FAIL:-}" = 1 ]; then
    printf 'fixture history unavailable\\n' >&2; exit 42
  fi
  if [ "${1:-}" = worktree ] && [ "${2:-}" = remove ] && [ "${RDSH_TEST_REMOVE_FAIL:-}" = 1 ]; then
    exit 42
  fi
  if [ "${1:-}" = read-tree ] && [ -n "${RDSH_TEST_GATE:-}" ]; then
    touch "$RDSH_TEST_GATE/$RDSH_TEST_SLUG"
    tries=0
    while [ ! -e "$RDSH_TEST_GATE/topic-2" ] || [ ! -e "$RDSH_TEST_GATE/topic-42" ]; do
      tries=$((tries + 1)); [ "$tries" -lt 500 ] || exit 98; sleep .02
    done
  fi
  if [ "${1:-}" = rev-parse ] && [ "${2:-}" = --absolute-git-dir ] &&
     [ -n "${RDSH_TEST_GATE:-}" ] && [ "${dir##*/}" = "rustdsh-$RDSH_TEST_SLUG" ]; then
    sleep 1
  fi
  exec "''' + GIT.as_posix() + '''" -C "$dir" "$@"
fi
exec "''' + GIT.as_posix() + '''" "$@"
''')

    def test_root_from_managed_worktree(self):
        directory = self.new()
        self.assertIn("rustdsh-topic", self.command("list", cwd=directory).stdout)

    def test_plain_directory_is_preserved(self):
        self.new("other")
        directory = self.worktree()
        directory.mkdir()
        sentinel = directory / "sentinel"
        sentinel.write_text("keep", encoding="utf-8")
        for options in ((), ("--force",)):
            result = self.command("remove", "topic", *options, check=False)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertEqual(sentinel.read_text(), "keep")

    def test_status_error_keeps_worktree(self):
        directory = self.new()
        self.git_shim()
        env = dict(self.env, RDSH_TEST_STATUS_FAIL="1")
        result = self.command("remove", "topic", env=env, check=False)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertTrue(directory.exists())

    def test_force_can_remove_owned_worktree_after_status_error(self):
        directory = self.new()
        self.git_shim()
        env = dict(self.env, RDSH_TEST_STATUS_FAIL="1", RDSH_TEST_REMOVE_FAIL="1")
        self.command("remove", "topic", "--force", env=env)
        self.assertFalse(directory.exists())

    def test_history_error_keeps_worktree(self):
        directory = self.new()
        self.git_shim()
        result = self.command("remove", "topic", env=dict(self.env, RDSH_TEST_HISTORY_FAIL="1"), check=False)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("history unavailable", result.stderr)
        self.assertTrue(directory.exists())

    def test_foreign_repository_is_preserved_even_with_force(self):
        self.new("other")
        directory = self.worktree()
        self.git("init", str(directory))
        self.commit(directory, "foreign")
        for options in ((), ("--force",)):
            result = self.command("remove", "topic", *options, check=False)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertEqual((directory / "fixture.txt").read_text(), "foreign")

    def test_copied_git_pointer_does_not_prove_ownership(self):
        original = self.new("original")
        copied = self.worktree("copied")
        copied.mkdir()
        shutil.copyfile(original / ".git", self.safe(copied / ".git"))
        sentinel = self.safe(copied / "sentinel")
        sentinel.write_text("keep", encoding="utf-8")
        mirror = self.root / ".worktrees/.git"
        registered = self.git("worktree", "list", "--porcelain", cwd=mirror).stdout
        self.assertNotIn("rustdsh-copied", registered)
        result = self.command("remove", "copied", "--force", check=False)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(sentinel.read_text(), "keep")
        self.assertTrue(original.exists())
        self.assertEqual(self.git("worktree", "list", "--porcelain", cwd=mirror).stdout, registered)

    def test_broken_owned_worktree_needs_force(self):
        directory = self.new()
        admin = Path(self.git("rev-parse", "--absolute-git-dir", cwd=directory).stdout.strip())
        self.safe(admin / "HEAD").unlink()
        refused = self.command("remove", "topic", check=False)
        self.assertNotEqual(refused.returncode, 0, refused.stdout)
        self.assertTrue(directory.exists())
        self.command("remove", "topic", "--force")
        self.assertFalse(directory.exists())

    def test_canonical_namesake_branch_is_preserved(self):
        self.new()
        self.git("branch", "parallel/topic")
        before = self.git("rev-parse", "parallel/topic").stdout
        self.command("remove", "topic")
        self.assertEqual(self.git("rev-parse", "parallel/topic").stdout, before)
        mirror = self.root / ".worktrees/.git"
        self.assertNotEqual(self.git("show-ref", "--verify", "refs/heads/parallel/topic",
                                     cwd=mirror, check=False).returncode, 0)

    def test_unpublished_commit_is_preserved(self):
        directory = self.new()
        self.commit(directory, "unpublished")
        head = self.git("rev-parse", "HEAD", cwd=directory).stdout
        result = self.command("remove", "topic", check=False)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=directory).stdout, head)

    def test_detached_unpublished_commit_is_preserved(self):
        directory = self.new()
        self.git("checkout", "--detach", cwd=directory)
        self.commit(directory, "detached")
        result = self.command("remove", "topic", check=False)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertTrue(directory.exists())

    def test_force_discards_unpublished_commit(self):
        directory = self.new()
        self.commit(directory, "discard explicitly")
        self.command("remove", "topic", "--force")
        self.assertFalse(directory.exists())

    def test_clean_remote_commit_can_be_removed(self):
        directory = self.new()
        self.command("remove", "topic")
        self.assertFalse(directory.exists())

    def test_dirty_worktree_is_preserved(self):
        directory = self.new()
        (directory / "dirty.txt").write_text("keep", encoding="utf-8")
        result = self.command("remove", "topic", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((directory / "dirty.txt").exists())

    def test_configured_remote_selects_base(self):
        self.git("remote", "rename", "origin", "upstream")
        self.command("new", "topic", env=dict(self.env, RDSH_PARALLEL_REMOTE="upstream"))

    def test_port_base_rejects_invalid_values(self):
        for base in ("65000", "banana", "1023", "64537"):
            result = self.command("port", "dashboard-fix",
                                  env=dict(self.env, RDSH_PARALLEL_PORT_BASE=base), check=False)
            self.assertNotEqual(result.returncode, 0, (base, result.stdout))
        result = self.command("port", "dashboard-fix", env=dict(self.env, RDSH_PARALLEL_PORT_BASE="64536"))
        self.assertLessEqual(int(result.stdout), 65535)

    def test_port_base_leading_zeros_are_decimal(self):
        plain = self.command("port", "port-2", env=dict(self.env, RDSH_PARALLEL_PORT_BASE="1024"))
        for base in ("01024", "00001024", "000000000000000000001024"):
            with self.subTest(base=base):
                padded = self.command("port", "port-2", env=dict(self.env, RDSH_PARALLEL_PORT_BASE=base))
                self.assertEqual(padded.stdout, plain.stdout)

    def test_port_base_rejects_huge_integers_before_arithmetic(self):
        for base in ("18446744073709600616", "999999999999999999999999999999999"):
            with self.subTest(base=base):
                result = self.command("port", "port-2",
                                      env=dict(self.env, RDSH_PARALLEL_PORT_BASE=base), check=False)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("integer expression expected", result.stderr)

    def test_colliding_ports_are_saved_and_reported(self):
        self.new("topic-2")
        self.new("topic-42")
        ports = [self.command("port", slug).stdout.strip() for slug in ("topic-2", "topic-42")]
        self.assertEqual(len(set(ports)), 2, ports)
        listing = self.command("list").stdout
        for port in ports:
            self.assertIn(port, listing)

    def test_concurrent_colliding_ports_are_unique(self):
        # Bootstrap the shared mirror before racing new topic creation.
        self.new("bootstrap")
        self.git_shim()
        gate = self.safe(self.root / "gate")
        gate.mkdir()
        processes = []
        for slug in ("topic-2", "topic-42"):
            env = dict(self.env, RDSH_TEST_GATE=gate.as_posix(), RDSH_TEST_SLUG=slug)
            processes.append(subprocess.Popen(self.shell_command(SCRIPT, ("new", slug)),
                                              cwd=self.repo, env=env, text=True, encoding="utf-8",
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE))
        for process in processes:
            try:
                stdout, stderr = process.communicate(timeout=45)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                self.fail("concurrent fixture did not finish")
            self.assertEqual(process.returncode, 0, stdout + stderr)
        ports = [self.command("port", slug).stdout.strip() for slug in ("topic-2", "topic-42")]
        self.assertEqual(len(set(ports)), 2, ports)

    def test_alternates_use_common_object_directory(self):
        directory = self.new()
        alternates = Path(self.git("rev-parse", "--git-path", "objects/info/alternates", cwd=directory).stdout.strip())
        if not alternates.is_absolute():
            alternates = directory / alternates
        self.safe(alternates)
        self.assertTrue(alternates.exists(), str(alternates))
        self.assertTrue(alternates.read_text().strip().endswith("/.worktrees.git/objects"))

    def test_status_fetches_remote_and_no_fetch_warns(self):
        self.new()
        self.commit(self.repo, "remote advances")
        self.git("fetch", str(self.repo), "main:refs/heads/main", cwd=self.remote)
        stale = self.command("status", "--no-fetch")
        self.assertIn("stale", stale.stderr)
        fresh = self.command("status")
        self.assertIn("+0/-1", fresh.stdout)

    def test_status_read_failure_is_unknown_and_nonzero(self):
        directory = self.new()
        sentinel = self.safe(directory / "dirty.txt")
        sentinel.write_text("keep", encoding="utf-8")
        normal = self.command("status", "--no-fetch")
        self.assertEqual(normal.stdout.splitlines()[1].split()[4], "dirty")
        self.git_shim()
        result = self.command("status", "--no-fetch",
                              env=dict(self.env, RDSH_TEST_STATUS_FAIL="1"), check=False)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(result.stdout.splitlines()[1].split()[4], "unknown")
        self.assertIn("cannot read Git status", result.stderr)
        self.assertIn("fixture status unavailable", result.stderr)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_status_warning_does_not_mark_clean_worktree_dirty(self):
        directory = self.new()
        missing_hook = self.safe(self.root / "missing-fsmonitor").as_posix()
        self.git("config", "core.fsmonitor", missing_hook, cwd=directory)
        direct = self.git("status", "--porcelain", cwd=directory)
        self.assertEqual(direct.stdout, "")
        self.assertIn("missing-fsmonitor", direct.stderr)
        result = self.command("status", "--no-fetch")
        self.assertEqual(result.stdout.splitlines()[1].split()[4], "clean")
        self.assertIn("missing-fsmonitor", result.stderr)

    def test_filtered_exit_status_follows_selection(self):
        for options in (("--mergeable-only",), ("--mergeable-only", "--json")):
            self.command(*options, script=CHECK)
        self.assertEqual(self.command("--conflicting-only", script=CHECK, check=False).returncode, 3)

    def test_other_repository_has_no_local_counts(self):
        self.git("update-ref", "refs/remotes/origin/topic", "HEAD")
        self.git("remote", "set-url", "origin", "https://github.com/example/one.git")
        other = self.command("--repo", "example/two", "--mergeable-only", "--json", script=CHECK, check=False)
        self.assertEqual(json.loads(other.stdout)["prs"][0]["ahead_behind"], "-")
        same = self.command("--repo", "example/one", "--mergeable-only", "--json", script=CHECK, check=False)
        self.assertEqual(json.loads(same.stdout)["prs"][0]["ahead_behind"], "+0/-0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
