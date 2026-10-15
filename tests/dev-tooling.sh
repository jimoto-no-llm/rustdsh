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
  git rm -q --cached src/bad.rs && rm src/bad.rs
  printf 'pub fn c(){}\n' > src/child.rs               # unformatted, committed, not staged
  git add src/child.rs && git commit -qm child --no-verify
  printf 'mod child;\npub fn a() {}\n' > src/a.rs
  printf 'mod missing;\npub fn z() {}\n' > src/z.rs
  git add src/a.rs src/z.rs
  expect_rc 1 "rustfmt Error with child diff blocks" sh .githooks/pre-commit
  has "failed to resolve mod" "rustfmt Error with child diff blocks"
  git reset -q --hard HEAD~1
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
has "rerere.enabled='false' (kept" "kept value reported"
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

git config --local --unset rerere.enabled
printf '[rerere]\n\tenabled =\n' >> "$GIT_CONFIG_GLOBAL"   # explicit empty value = false
sh scripts/dev-setup.sh >"$tmp/out" 2>&1 || true
[ -z "$(git config --local --get rerere.enabled || true)" ] || die "empty global value overridden locally"
has "rerere.enabled='' (kept from global" "empty value reported as set"
printf '[broken\n' > "$GIT_CONFIG_GLOBAL"
expect_rc 2 "unreadable config" sh scripts/dev-setup.sh
has "git config cannot be read" "unreadable config"
has "bad config line" "git's own diagnostic shown"
printf '[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"
ok "dev-setup treats empty values as set and fails on unreadable config"

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
  "api --paginate")
    case "$3" in
      "repos/o/r/pulls?state=open&per_page=100") printf '1\n2\n3\n' ;;
      repos/o/r/issues/*/comments) [ ! -f "$d/notified" ] || echo 42 ;;
      *) echo "unexpected paginated API $3" >&2; exit 9 ;;
    esac ;;
  "pr view")
    case "$3" in
      1) if [ -f "$d/labeled" ]; then printf 'CONFLICTING\ttrue\tmain\n'; else printf 'CONFLICTING\tfalse\tmain\n'; fi ;;
      2) printf 'MERGEABLE\ttrue\tmain\n' ;;
      3) if [ -f "$d/seen3" ]; then printf 'MERGEABLE\tfalse\tmain\n'; else : > "$d/seen3"; printf 'UNKNOWN\tfalse\tmain\n'; fi ;;
    esac ;;
  "pr comment") [ ! -f "$d/fail-comment" ] || exit 1; : > "$d/notified" ;;
  "pr edit")
    if [ "$3" = 1 ]; then
      if [ -f "$d/fail-label" ]; then rm "$d/fail-label"; exit 1; fi
      : > "$d/labeled"
    fi ;;
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

: > "$calls"; rm -f "$tmp/gh/seen3" "$tmp/gh/notified" "$tmp/gh/labeled"; : > "$tmp/gh/fail-comment"
expect_rc 1 "comment failure" env PATH="$tmp/bin:$PATH" GH_STUB_DIR="$tmp/gh" REPO=o/r WAIT=0 \
  sh "$root/scripts/label-conflicts.sh" 1
if grep -q '^pr edit 1 .*--add-label' "$calls"; then die "label added although the comment failed"; fi
rm -f "$tmp/gh/fail-comment"
ok "label-conflicts leaves no label when the comment fails, so the next run retries"

: > "$calls"; : > "$tmp/gh/fail-label"
expect_rc 1 "label fails after comment" env PATH="$tmp/bin:$PATH" GH_STUB_DIR="$tmp/gh" REPO=o/r WAIT=0 \
  sh "$root/scripts/label-conflicts.sh" 1
expect_rc 0 "retry label without duplicate comment" env PATH="$tmp/bin:$PATH" GH_STUB_DIR="$tmp/gh" REPO=o/r WAIT=0 \
  sh "$root/scripts/label-conflicts.sh" 1
[ "$(grep -c '^pr comment 1 ' "$calls")" = 1 ] || die "label retry duplicated the comment"
ok "label-conflicts retries a failed label without duplicating its comment"

: > "$calls"; rm -f "$tmp/gh/notified"; : > "$tmp/gh/labeled"
expect_rc 0 "label exists without comment" env PATH="$tmp/bin:$PATH" GH_STUB_DIR="$tmp/gh" REPO=o/r WAIT=0 \
  sh "$root/scripts/label-conflicts.sh" 1
grep -q '^pr comment 1 ' "$calls" || die "existing label suppressed the missing comment"
if grep -q '^pr edit 1 ' "$calls"; then die "existing label must not be added again"; fi
ok "label-conflicts tracks its comment separately from the label"

: > "$calls"; rm -f "$tmp/gh/notified" "$tmp/gh/labeled"
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
ok "label-conflicts fails when the open PR listing fails"

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

# --- check.sh changed-mode selection against a fixture ci.yml -------------------
git init -q --bare "$tmp/sel-origin.git"
git clone -q "$tmp/sel-origin.git" "$tmp/sel" 2>/dev/null
cd "$tmp/sel"
mkdir -p scripts .github/workflows tests plugins/rdsh-session-cleanup plugins/nopkg misc
cp "$root/scripts/check.sh" "$root/scripts/check-conflicts.sh" scripts/
cat > .github/workflows/ci.yml <<'YML'
      - run: node --test tests/plugin-security.test.mjs tests/new-suite.test.mjs
          RDSH_CANDIDATE="$RUNNER_TEMP/c" node --test scripts/headless-runtime/test/*.test.mjs plugins/rdsh-session-cleanup/test/*.test.mjs
      - run: node --test tests/special.test.mjs
      - run: node --test tests/runtime-compatibility.test.mjs
YML
printf 'x\n' > misc/keep.txt
git add -A && git commit -qm base && git push -q origin main
git switch -qc topic
for f in tests/new-suite.test.mjs tests/special.test.mjs tests/adhoc.test.mjs \
         plugins/rdsh-session-cleanup/cleanup.mjs plugins/nopkg/x.js misc/other.txt .github/workflows/extra.yml; do
  printf 'x\n' > "$f"
done
git add -A && git commit -qm topic
expect_rc 0 "changed selection" sh scripts/check.sh --list
has "node tests (CI plugin-security set)" "CI-derived suite selected"
if grep -q "new-suite" "$tmp/out"; then die "test already in a CI suite must not be listed separately"; fi
has "(not run) tests/special.test.mjs (CI job with its own setup" "CI-only test reported"
has "changed node tests" "test outside CI runs directly"
has "headless runtime tests" "headless suite selected from ci.yml"
has "(not run) plugins/nopkg (no package.json" "plugin without package.json reported"
has "(not run) misc/other.txt (no local check mapped" "unmapped file reported"
has "(not run) .github/workflows/extra.yml (CI configuration" "CI config reported"
printf 'name: ci\n' > .github/workflows/ci.yml && git commit -qam "drop suites"
expect_rc 2 "missing CI suites" sh scripts/check.sh --list
has "cannot read the CI node suites" "missing CI suites"
cd "$root"
ok "check.sh derives node suites from ci.yml and never drops an unmapped change silently"

# --- check.sh headless candidate cleanup ------------------------------------------
git init -q --bare "$tmp/hl-origin.git"
git clone -q "$tmp/hl-origin.git" "$tmp/hl" 2>/dev/null
cd "$tmp/hl"
mkdir -p scripts/headless-runtime/test scripts/headless-runtime/runtime/node_modules .github/workflows tests "$tmp/hlbin"
cp "$root/scripts/check.sh" "$root/scripts/check-conflicts.sh" scripts/
cat > .github/workflows/ci.yml <<'YML'
      - run: node --test tests/plugin-security.test.mjs
          RDSH_CANDIDATE="$RUNNER_TEMP/c" node --test scripts/headless-runtime/test/*.test.mjs
      - run: node --test tests/runtime-compatibility.test.mjs
YML
for t in tests/plugin-security.test.mjs tests/runtime-compatibility.test.mjs; do
  printf "import test from 'node:test';\ntest('ok', () => {});\n" > "$t"
done
# Builder stand-in: a read-only tree like the real candidate (dirs 0500, files 0400).
cat > scripts/headless-runtime/build-candidate.mjs <<'JS'
import { mkdirSync, writeFileSync, chmodSync, appendFileSync } from 'node:fs';
const out = process.argv[process.argv.indexOf('--out') + 1];
mkdirSync(`${out}/lib`, { recursive: true });
writeFileSync(`${out}/lib/a.js`, 'x');
chmodSync(`${out}/lib/a.js`, 0o400); chmodSync(`${out}/lib`, 0o500); chmodSync(out, 0o500);
appendFileSync(process.env.HL_RECORD, `${out}\n`);
JS
printf "import test from 'node:test';\nimport assert from 'node:assert';\nimport { existsSync } from 'node:fs';\ntest('candidate', () => assert.ok(existsSync(process.env.RDSH_CANDIDATE)));\n" \
  > scripts/headless-runtime/test/a.test.mjs
printf '#!/bin/sh\nexit 0\n' > "$tmp/hlbin/cargo" && chmod +x "$tmp/hlbin/cargo"   # no Rust crate here
git add -A && git commit -qm base && git push -q origin main
git switch -qc topic
printf '// change\n' >> scripts/headless-runtime/test/a.test.mjs
git commit -qam topic
expect_rc 0 "headless run" env PATH="$tmp/hlbin:$PATH" HL_RECORD="$tmp/hl-record" sh scripts/check.sh
has "ok    headless runtime candidate + tests" "headless run"
cand=$(tail -n 1 "$tmp/hl-record")
if [ -z "$cand" ] || [ -e "$(dirname "$cand")" ]; then die "read-only candidate left behind: $cand"; fi
printf '#!/bin/sh\nexit 1\n' > "$tmp/hlbin/rm" && chmod +x "$tmp/hlbin/rm"
expect_rc 1 "cleanup failure" env PATH="$tmp/hlbin:$PATH" HL_RECORD="$tmp/hl-record" sh scripts/check.sh
has "could not remove" "cleanup failure"
has "FAIL  headless runtime candidate + tests" "cleanup failure"
rm -f "$tmp/hlbin/rm"
cand=$(tail -n 1 "$tmp/hl-record"); chmod -R u+rwX "$(dirname "$cand")"; rm -rf "$(dirname "$cand")"
cd "$root"
ok "check.sh removes the read-only headless candidate and fails when it cannot"

# --- check.sh selection ----------------------------------------------------------
cd "$root"
expect_rc 0 "quick list" sh scripts/check.sh quick --list
has "cargo clippy --all-targets -D warnings" "quick list"
if grep -q "cargo clippy --release" "$tmp/out"; then die "quick mode must not run release clippy"; fi
if grep -q "regress" "$tmp/out"; then die "quick mode must not run regress"; fi
expect_rc 0 "full list" sh scripts/check.sh full --list
has "cargo clippy --release --all-targets -D warnings" "full release clippy"
has "tests/regress.sh" "full list"
has "release policy unittest" "full list"
exe=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=.exe ;; esac
release_bin="$(git -C "$root" rev-parse --show-toplevel)/target/release/rdsh$exe"
has "node tests (CI test job, BIN=./target/release/rdsh$exe)" "full mode tests the release binary"
if grep -F "npm test (RDSH_BIN=" "$tmp/out" | grep -vF "(RDSH_BIN=$release_bin)" | grep -q .; then
  die "plugin tests must get the absolute release binary in full mode"
fi
{ grep -Fq "plugins/rdsh-compute npm test (RDSH_BIN=$release_bin)" "$tmp/out" || \
  grep -Fq "plugins/rdsh-compute npm test (node_modules missing" "$tmp/out"; } \
  || die "rdsh-compute plugin test not selected with RDSH_BIN"
[ "$(grep -c "cargo build --release" "$tmp/out")" = 1 ] || die "release build must be selected exactly once"
has "(not run) tests/security-boundaries.test.mjs" "CI-only suites reported"
# Runs on Linux with Docker, otherwise listed as not run; selected either way.
has "tests/install-isolated.sh --source local" "installer isolation selected"
ok "check.sh selects checks per mode"

echo "dev-tooling: $pass passed"
