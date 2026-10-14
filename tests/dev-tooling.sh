#!/bin/sh
# Regression tests for the contributor tooling: scripts/check-conflicts.sh,
# scripts/dev-setup.sh, scripts/label-conflicts.sh and .githooks/*.
# Uses throwaway repositories and a stub gh; never touches this checkout's config.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t rdsh-devtools)
trap 'rm -rf "$tmp"' EXIT INT TERM

# Isolate from the developer's global/system git config and hooks.
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL="$tmp/gitconfig"
GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid
GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
unset RDSH_SKIP_HOOKS RDSH_STRICT_PUSH 2>/dev/null || true
printf '[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n' > "$GIT_CONFIG_GLOBAL"

pass=0
ok() { pass=$((pass+1)); echo "ok: $1"; }
die() { echo "FAIL: $1" >&2; [ -f "$tmp/out" ] && cat "$tmp/out" >&2; exit 1; }
# expect_rc CODE DESC CMD...: run CMD, capture output in $tmp/out, compare exit status.
expect_rc() {
  want="$1" desc="$2"; shift 2
  rc=0; "$@" >"$tmp/out" 2>&1 || rc=$?
  [ "$rc" = "$want" ] || die "$desc (exit $rc, want $want)"
}
has() { grep -q -- "$1" "$tmp/out" || die "$2: output lacks '$1'"; }

# --- fixture: origin + clone with the tooling committed ----------------------
git init -q --bare "$tmp/origin.git"
git clone -q "$tmp/origin.git" "$tmp/work" 2>/dev/null
cd "$tmp/work"
mkdir -p scripts .githooks
cp "$root/scripts/check-conflicts.sh" "$root/scripts/dev-setup.sh" scripts/
cp "$root/.githooks/pre-commit" "$root/.githooks/pre-push" .githooks/
printf '[package]\nname = "x"\nrust-version = "1.85"\n' > Cargo.toml
printf 'one\ntwo\nthree\n' > a.txt
printf 'keep\n' > b.txt
git add -A && git commit -qm base && git push -q origin main

git switch -qc feature
printf 'one\nfeature\nthree\n' > a.txt
git commit -qam feature

git switch -q main
printf 'one\nmain\nthree\n' > a.txt
git commit -qam main-change && git push -q origin main
git switch -q feature

# --- check-conflicts.sh -------------------------------------------------------
expect_rc 1 "conflict detected" sh scripts/check-conflicts.sh
has "CONFLICT with origin/main" "conflict detected"
has "  a.txt" "conflicting file listed"
has "1 ahead / 1 behind" "ahead/behind reported"
ok "check-conflicts reports conflicting files"

git switch -qc clean main~1
printf 'other\n' > b.txt
git commit -qam clean
expect_rc 0 "clean branch" sh scripts/check-conflicts.sh --no-fetch
has "no conflicts with origin/main" "clean branch"
ok "check-conflicts passes a clean branch"

expect_rc 2 "unknown base" sh scripts/check-conflicts.sh --no-fetch --base origin/nope
expect_rc 2 "unknown argument" sh scripts/check-conflicts.sh --bogus
ok "check-conflicts rejects bad input with exit 2"

expect_rc 0 "behind warning" env RDSH_BEHIND_WARN=1 sh scripts/check-conflicts.sh --no-fetch
has "commits behind" "behind warning"
ok "check-conflicts warns when the branch is far behind"

# --- pre-commit ----------------------------------------------------------------
printf '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n' > c.txt
git add c.txt
expect_rc 1 "marker blocked" sh .githooks/pre-commit
has "c.txt: <<<<<<< HEAD" "marker reported"
expect_rc 0 "skip hooks" env RDSH_SKIP_HOOKS=1 sh .githooks/pre-commit
git rm -q --cached c.txt && rm c.txt
printf 'fine\n' > d.txt && git add d.txt
expect_rc 0 "clean staged change" sh .githooks/pre-commit
git reset -q d.txt && rm d.txt
ok "pre-commit blocks staged conflict markers only"

if command -v rustfmt >/dev/null 2>&1; then
  mkdir -p src && printf 'fn main() {}\n' > src/main.rs
  git add Cargo.toml src/main.rs && git commit -qm crate --no-verify
  printf 'fn main(){let x=1;}\n' > src/main.rs        # unformatted but unstaged
  printf 'fine\n' > e.txt && printf 'pub fn ok() {}\n' > src/ok.rs
  git add e.txt src/ok.rs
  expect_rc 0 "unstaged rust ignored" sh .githooks/pre-commit
  git add src/main.rs
  expect_rc 1 "staged unformatted rust" sh .githooks/pre-commit
  has "not formatted: src/main.rs" "staged unformatted rust"
  printf 'fn main() {}\n' > src/main.rs                # index unformatted, worktree formatted
  expect_rc 1 "index snapshot is checked" sh .githooks/pre-commit
  git add src/main.rs
  printf 'fn main(){}\n' > src/main.rs                 # index formatted, worktree not
  expect_rc 0 "formatted index passes" sh .githooks/pre-commit
  printf 'fn broken( {\n' > src/bad.rs && git add src/bad.rs
  expect_rc 1 "rustfmt error blocks" sh .githooks/pre-commit
  has "rustfmt failed" "rustfmt error blocks"
  git reset -q --hard HEAD~1
  ok "pre-commit checks the staged Rust snapshot and fails closed on rustfmt errors"
fi

# --- pre-push ------------------------------------------------------------------
zero=0000000000000000000000000000000000000000
# push_line BRANCH: the stdin line git gives pre-push for `git push origin BRANCH`.
push_line() { printf 'refs/heads/%s %s refs/heads/%s %s\n' "$1" "$(git rev-parse "$1")" "$1" "$zero"; }
prepush() { sh .githooks/pre-push origin "$tmp/origin.git" < "$tmp/stdin"; }
strict_prepush() { env RDSH_STRICT_PUSH=1 sh .githooks/pre-push origin "$tmp/origin.git" < "$tmp/stdin"; }
git switch -q feature
push_line feature > "$tmp/stdin"
expect_rc 0 "advisory push" prepush
has "advisory" "advisory push"
expect_rc 1 "strict push" strict_prepush
push_line clean > "$tmp/stdin"
expect_rc 0 "strict clean push" strict_prepush
ok "pre-push warns by default and blocks only with RDSH_STRICT_PUSH=1"

git switch -q main
push_line feature > "$tmp/stdin"
expect_rc 1 "pushed ref, not HEAD" strict_prepush
has "checking refs/heads/feature" "pushed ref, not HEAD"
{ push_line clean; push_line feature; } > "$tmp/stdin"
expect_rc 1 "any pushed ref conflicting" strict_prepush
printf 'refs/heads/feature %s refs/heads/main %s\n' "$(git rev-parse main)" "$zero" > "$tmp/stdin"
expect_rc 0 "push to main skipped" prepush
printf '(delete) %s refs/heads/feature %s\n' "$zero" "$(git rev-parse feature)" > "$tmp/stdin"
expect_rc 0 "deletion skipped" prepush
git switch -q clean
ok "pre-push checks every pushed ref from stdin, not the checked-out branch"

push_line clean > "$tmp/stdin"
git remote set-url origin "$tmp/missing.git"
expect_rc 0 "advisory without fetch" prepush
expect_rc 1 "strict without fetch" strict_prepush
has "could not be fetched" "strict without fetch"
git remote set-url origin "$tmp/origin.git"
ok "strict pre-push also blocks when origin/main cannot be fetched"

# --- dev-setup.sh --------------------------------------------------------------
git config --local rerere.enabled false
sh scripts/dev-setup.sh --check >"$tmp/out" 2>&1 || true
[ -z "$(git config --local --get core.hooksPath || true)" ] || die "--check must not write config"
sh scripts/dev-setup.sh >"$tmp/out" 2>&1 || true
[ "$(git config --local --get core.hooksPath)" = .githooks ] || die "hooksPath not set"
[ "$(git config --local --get rerere.enabled)" = false ] || die "existing rerere.enabled overwritten"
[ "$(git config --local --get fetch.prune)" = true ] || die "fetch.prune not set"
has "rerere.enabled=false (kept" "kept value reported"
ok "dev-setup sets only unset local git config; --check writes nothing"

git config --local --unset core.hooksPath
git config --local --unset fetch.prune
printf '[core]\n\thooksPath = %s/own-hooks\n[fetch]\n\tprune = false\n' "$tmp" >> "$GIT_CONFIG_GLOBAL"
sh scripts/dev-setup.sh >"$tmp/out" 2>&1 || true
[ -z "$(git config --local --get core.hooksPath || true)" ] || die "global hooksPath overridden locally"
[ -z "$(git config --local --get fetch.prune || true)" ] || die "global fetch.prune overridden locally"
has "repository hooks inactive" "inactive hooks reported"
has "kept from global" "global scope reported"
printf '[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"
ok "dev-setup keeps settings from any scope and reports inactive repository hooks"

# --- label-conflicts.sh with a stub gh ------------------------------------------
mkdir -p "$tmp/bin" "$tmp/gh"
cat > "$tmp/bin/gh" <<'STUB'
#!/bin/sh
# Stub gh: PR 1 conflicts, PR 2 was fixed (still labeled), PR 3 is UNKNOWN once.
d="$GH_STUB_DIR"
echo "$*" >> "$d/calls"
case "$1 $2" in
  "pr list") printf '1\n2\n3\n' ;;
  "api repos/o/r/labels/needs-rebase") exit 0 ;;
  "pr view")
    case "$3" in
      1) printf 'CONFLICTING\tfalse\tmain\n' ;;
      2) printf 'MERGEABLE\ttrue\tmain\n' ;;
      3) if [ -f "$d/seen3" ]; then printf 'MERGEABLE\tfalse\tmain\n'; else : > "$d/seen3"; printf 'UNKNOWN\tfalse\tmain\n'; fi ;;
    esac ;;
  "pr edit"|"pr comment") [ -f "$d/fail-comment" ] && exit 1; : ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$tmp/bin/gh"
expect_rc 0 "label run" env PATH="$tmp/bin:$PATH" GH_STUB_DIR="$tmp/gh" REPO=o/r WAIT=0 \
  sh "$root/scripts/label-conflicts.sh"
calls="$tmp/gh/calls"
grep -q '^pr edit 1 --repo o/r --add-label needs-rebase$' "$calls" || die "PR 1 not labeled"
grep -q '^pr comment 1 --repo o/r --body' "$calls" || die "PR 1 not commented"
[ "$(grep -n '^pr \(comment\|edit\) 1 ' "$calls" | head -n 1 | grep -c comment)" = 1 ] || die "PR 1 labeled before commenting"
grep -q '^pr edit 2 --repo o/r --remove-label needs-rebase$' "$calls" || die "PR 2 not unlabeled"
[ "$(grep -c '^pr view 3 ' "$calls")" = 2 ] || die "PR 3 not retried after UNKNOWN"
if grep -q '^pr \(edit\|comment\) 3 ' "$calls"; then die "PR 3 must stay untouched"; fi
if grep -q '^label create' "$calls"; then die "existing label must not be recreated"; fi
ok "label-conflicts labels, unlabels and retries unknown mergeability"

: > "$calls"; rm -f "$tmp/gh/seen3"; : > "$tmp/gh/fail-comment"
expect_rc 1 "comment failure" env PATH="$tmp/bin:$PATH" GH_STUB_DIR="$tmp/gh" REPO=o/r WAIT=0 \
  sh "$root/scripts/label-conflicts.sh" 1
if grep -q '^pr edit 1 .*--add-label' "$calls"; then die "label added although the comment failed"; fi
rm -f "$tmp/gh/fail-comment"
ok "label-conflicts leaves no label when the comment fails, so the next run retries"

: > "$calls"
expect_rc 0 "dry run" env PATH="$tmp/bin:$PATH" GH_STUB_DIR="$tmp/gh" REPO=o/r WAIT=0 DRY_RUN=1 \
  sh "$root/scripts/label-conflicts.sh" 1
has "dry-run: gh pr edit 1" "dry run prints actions"
if grep -q '^pr edit' "$calls"; then die "DRY_RUN must not edit"; fi
ok "label-conflicts DRY_RUN changes nothing"

cat > "$tmp/bin/gh" <<'STUB'
#!/bin/sh
echo "HTTP 502" >&2; exit 1
STUB
expect_rc 1 "gh failure" env PATH="$tmp/bin:$PATH" REPO=o/r WAIT=0 sh "$root/scripts/label-conflicts.sh"
if grep -q "no open PRs" "$tmp/out"; then die "gh failure reported as no PRs"; fi
ok "label-conflicts fails when gh pr list fails"

# --- check-conflicts.sh --open-prs with a stub gh --------------------------------
cd "$tmp/work"
git switch -q clean
mkdir -p docs && printf 'x\n' > "docs/日本語.md" && git add docs && git commit -qm ja
cat > "$tmp/bin/gh" <<'STUB'
#!/bin/sh
# #7 is this branch's PR, #8 shares the Japanese path, #9 has >100 files (truncated).
case "$1 $2" in
  "pr view") echo 7 ;;
  "pr list") printf 'F\t7\tself\tdocs/日本語.md\nF\t8\tother\tdocs/日本語.md\nF\t8\tother\tz.txt\nT\t9\tbig\n' ;;
  "api --paginate")
    [ -f "$GH_STUB_DIR/fail-api" ] && exit 1
    i=0; while [ $i -lt 150 ]; do echo "gen/$i.txt"; i=$((i+1)); done; echo "docs/日本語.md" ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
STUB
expect_rc 0 "open PR overlap" env PATH="$tmp/bin:$PATH" GH_STUB_DIR="$tmp/gh" \
  sh scripts/check-conflicts.sh --no-fetch --open-prs
has "#8 other" "UTF-8 path matched"
has "#9 big" "file past the first 100 matched"
if grep -q "#7 " "$tmp/out"; then die "own PR must be excluded"; fi
if grep -q "z.txt" "$tmp/out"; then die "unrelated file listed"; fi
: > "$tmp/gh/fail-api"
expect_rc 2 "incomplete file list" env PATH="$tmp/bin:$PATH" GH_STUB_DIR="$tmp/gh" \
  sh scripts/check-conflicts.sh --no-fetch --open-prs
has "overlap with them is unknown" "incomplete file list"
rm -f "$tmp/gh/fail-api"
ok "check-conflicts --open-prs matches UTF-8 paths, paginates large PRs and skips its own PR"

# --- check.sh selection ----------------------------------------------------------
cd "$root"
expect_rc 0 "quick list" sh scripts/check.sh quick --list
has "cargo clippy --all-targets -D warnings" "quick list"
if grep -q "regress" "$tmp/out"; then die "quick mode must not run regress"; fi
expect_rc 0 "full list" sh scripts/check.sh full --list
has "tests/regress.sh" "full list"
has "release policy unittest" "full list"
has "(not run) tests/security-boundaries.test.mjs" "CI-only suites reported"
has "(not run) tests/install-isolated.sh" "installer isolation reported"
ok "check.sh selects checks per mode"

echo "dev-tooling: $pass passed"
