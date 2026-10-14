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

if command -v cargo >/dev/null 2>&1 && cargo fmt --version >/dev/null 2>&1; then
  mkdir -p src && printf 'fn main() {}\n' > src/main.rs
  git add Cargo.toml src/main.rs && git commit -qm crate --no-verify
  printf 'fn main(){let x=1;}\n' > src/main.rs        # unformatted but unstaged
  printf 'fine\n' > e.txt && printf 'pub fn ok() {}\n' > src/ok.rs
  git add e.txt src/ok.rs
  expect_rc 0 "unstaged rust ignored" sh .githooks/pre-commit
  git add src/main.rs
  expect_rc 1 "staged unformatted rust" sh .githooks/pre-commit
  has "not formatted: src/main.rs" "staged unformatted rust"
  git reset -q --hard HEAD~1
  ok "pre-commit checks formatting of staged Rust files only"
fi

# --- pre-push ------------------------------------------------------------------
git switch -q feature
expect_rc 0 "advisory push" sh .githooks/pre-push origin "$tmp/origin.git"
has "advisory" "advisory push"
expect_rc 1 "strict push" env RDSH_STRICT_PUSH=1 sh .githooks/pre-push origin "$tmp/origin.git"
git switch -q clean
expect_rc 0 "strict clean push" env RDSH_STRICT_PUSH=1 sh .githooks/pre-push origin "$tmp/origin.git"
ok "pre-push warns by default and blocks only with RDSH_STRICT_PUSH=1"

git remote set-url origin "$tmp/missing.git"
expect_rc 0 "advisory without fetch" sh .githooks/pre-push
expect_rc 1 "strict without fetch" env RDSH_STRICT_PUSH=1 sh .githooks/pre-push
has "could not be fetched" "strict without fetch"
git remote set-url origin "$tmp/origin.git"
git switch -q --detach feature
expect_rc 1 "strict detached" env RDSH_STRICT_PUSH=1 sh .githooks/pre-push
has "CONFLICT with origin/main" "detached HEAD is checked"
git switch -q clean
ok "strict pre-push also blocks when origin/main cannot be fetched or HEAD is detached"

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
  "pr edit"|"pr comment") ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$tmp/bin/gh"
expect_rc 0 "label run" env PATH="$tmp/bin:$PATH" GH_STUB_DIR="$tmp/gh" REPO=o/r WAIT=0 \
  sh "$root/scripts/label-conflicts.sh"
calls="$tmp/gh/calls"
grep -q '^pr edit 1 --repo o/r --add-label needs-rebase$' "$calls" || die "PR 1 not labeled"
grep -q '^pr comment 1 --repo o/r --body' "$calls" || die "PR 1 not commented"
grep -q '^pr edit 2 --repo o/r --remove-label needs-rebase$' "$calls" || die "PR 2 not unlabeled"
[ "$(grep -c '^pr view 3 ' "$calls")" = 2 ] || die "PR 3 not retried after UNKNOWN"
if grep -q '^pr \(edit\|comment\) 3 ' "$calls"; then die "PR 3 must stay untouched"; fi
if grep -q '^label create' "$calls"; then die "existing label must not be recreated"; fi
ok "label-conflicts labels, unlabels and retries unknown mergeability"

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

# --- check.sh selection ----------------------------------------------------------
cd "$root"
expect_rc 0 "quick list" sh scripts/check.sh quick --list
has "cargo clippy --all-targets -D warnings" "quick list"
if grep -q "regress" "$tmp/out"; then die "quick mode must not run regress"; fi
expect_rc 0 "full list" sh scripts/check.sh full --list
has "tests/regress.sh" "full list"
has "release policy unittest" "full list"
ok "check.sh selects checks per mode"

echo "dev-tooling: $pass passed"
