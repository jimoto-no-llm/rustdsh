#!/bin/sh
# Run the local PR checks that match CI, in one command.
#
#   sh scripts/check.sh           # checks for the areas changed vs origin/main (default)
#   sh scripts/check.sh quick     # cargo fmt --check, clippy -D warnings, cargo test
#   sh scripts/check.sh full      # full CONTRIBUTING.md matrix (release builds)
#   sh scripts/check.sh --list    # print the selected checks without running them
#
# Environment: RDSH_CHECK_BASE (default origin/main) selects the comparison base.
# Every selected check runs; the summary lists failures and the exit status is 1.
set -eu

mode=changed
list_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    quick|full|changed) mode="$1" ;;
    --list) list_only=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "check: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

root=$(git rev-parse --show-toplevel)
cd "$root"
base="${RDSH_CHECK_BASE:-origin/main}"

passed=""
failed=""
skipped=""
step() {
  label="$1"; shift
  if [ "$list_only" = 1 ]; then echo "  $label"; return 0; fi
  printf '\n==> %s\n' "$label"
  if "$@"; then passed="$passed\n  ok    $label"; else failed="$failed\n  FAIL  $label"; fi
}
# skip: not run here; listed as NOT verified so a green summary never hides it.
skip() { if [ "$list_only" = 1 ]; then echo "  (not run) $1"; else skipped="$skipped\n  todo  $1"; fi; }

# Changed files: committed since the merge base, staged, unstaged and untracked.
changed_files() {
  if mb=$(git merge-base "$base" HEAD 2>/dev/null); then
    git -c core.quotePath=false diff --name-only "$mb" HEAD
  fi
  git -c core.quotePath=false diff --name-only HEAD
  git -c core.quotePath=false ls-files --others --exclude-standard
}

# Node suites are read from CI itself, so tests added or moved on main are picked
# up without editing this script. ci_suite PATTERN: the .mjs arguments (globs kept)
# of the first `node --test` line in ci.yml that contains PATTERN.
ci=.github/workflows/ci.yml
ci_suite() {
  awk -v p="$1" 'index($0, "node --test") && index($0, p) { sub(/.*node --test /, ""); print; exit }' "$ci" \
    | tr ' ' '\n' | grep '\.mjs$' | tr '\n' ' '
}
node_base=$(ci_suite tests/plugin-security.test.mjs)
node_built=$(ci_suite tests/runtime-compatibility.test.mjs)
headless_tests=$(ci_suite headless-runtime/test/)
if [ -z "$node_base" ] || [ -z "$node_built" ]; then
  echo "check: cannot read the CI node suites from $ci; update scripts/check.sh" >&2
  exit 2
fi
# Directories whose tests run in the headless-runtime CI step (e.g. scripts/headless-runtime/).
headless_dirs=""
for g in $headless_tests; do headless_dirs="$headless_dirs ${g%%/test/*}/"; done
in_list() { case " $(printf '%s' "$2" | tr '\n' ' ') " in *" $1 "*) return 0 ;; esac; return 1; }

rust=0 node=0 dashboard=0 release=0 markdown=0 shell=0 devtools=0 installer=0 ps1=0 e2e=0 headless=0
plugins="" extra_tests="" ci_only_tests="" unmapped=""
add_word() { case " $1 " in *" $2 "*) printf '%s' "$1" ;; *) printf '%s' "${1:+$1 }$2" ;; esac; }
# classify_test FILE: run it with a CI-derived suite, as a CI-only suite, or directly.
classify_test() {
  if in_list "$1" "$node_base $node_built"; then :
  elif grep -qF -- "$1" "$ci"; then ci_only_tests=$(add_word "$ci_only_tests" "$1")
  else extra_tests=$(add_word "$extra_tests" "$1"); fi
}
case "$mode" in
  quick) rust=1 ;;
  full)
    rust=1 node=1 dashboard=1 release=1 markdown=1 shell=1 devtools=1 installer=1 ps1=1 e2e=1
    [ -n "$headless_tests" ] && headless=1
    for d in plugins/*/; do plugins=$(add_word "$plugins" "${d%/}"); done
    for t in tests/*.test.mjs tests/*/*.test.mjs; do [ -f "$t" ] && classify_test "$t"; done ;;
  changed)
    files=$(changed_files | sort -u)
    old_ifs=$IFS; IFS='
'
    for f in $files; do
      m=0   # set when some local check (or an explicit CI todo) covers $f
      case "$f" in
        src/*|tests/*.rs|examples/*|benches/*|build.rs|Cargo.toml|Cargo.lock|assets/*|tests/regress.sh|tests/context_prototype.sh) rust=1 m=1 ;;
      esac
      case "$f" in
        dashboard/*) dashboard=1 m=1 ;;
        tests/e2e/*) e2e=1 m=1 ;;
        tests/*.test.mjs) node=1 m=1; classify_test "$f" ;;
        tests/*.mjs|security/*|scripts/*.mjs) node=1 m=1 ;;
      esac
      IFS=$old_ifs
      for h in $headless_dirs; do case "$f" in "$h"*) headless=1 m=1 ;; esac; done
      IFS='
'
      case "$f" in
        plugins/*/*) d=${f#plugins/}; plugins=$(add_word "$plugins" "plugins/${d%%/*}"); node=1 m=1 ;;
      esac
      case "$f" in
        install.sh|install-banner.sh|sync-dsh.sh|release-digests.tsv|tests/install-isolated*|tests/installer-*) installer=1 m=1 ;;
        *.ps1) ps1=1 m=1 ;;
      esac
      case "$f" in
        scripts/*.py|tests/test_*.py|Cargo.toml|CHANGELOG.md|docs/releases/*|release-digests.tsv) release=1 m=1 ;;
      esac
      case "$f" in *.md) markdown=1 m=1 ;; esac
      case "$f" in scripts/check-conflicts.sh|scripts/dev-setup.sh|scripts/check.sh|scripts/label-conflicts.sh|.githooks/*|tests/dev-tooling.sh) devtools=1 shell=1 m=1 ;; esac
      [ "$m" = 1 ] || unmapped="$unmapped
$f"
    done
    IFS=$old_ifs ;;
esac

release_flag=""
[ "$mode" = full ] && release_flag="--release"
profile=debug
[ "$mode" = full ] && profile=release
exe=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=.exe ;; esac
bin=./target/$profile/rdsh$exe
# Absolute: plugin tests run with the package directory as their cwd.
abs_bin="$root/target/$profile/rdsh$exe"

# Build the selected profile once per run, whichever check needs it first.
built=0
ensure_build() {
  [ "$built" = 1 ] && return 0
  built=1
  # shellcheck disable=SC2086 # release_flag is empty or one word
  step "cargo build${release_flag:+ $release_flag}${1:+ ($1)}" cargo build $release_flag
}

regress() {
  stub_dir=$(mktemp -d)
  printf '#!/bin/sh\necho stub-dsh "$@"\n' > "$stub_dir/dsh"
  chmod +x "$stub_dir/dsh"
  rc=0
  BIN="$bin" DSH_ORIG_BIN="$stub_dir/dsh" sh tests/regress.sh || rc=$?
  [ "$rc" = 0 ] && { BIN="$bin" sh tests/context_prototype.sh || rc=$?; }
  rm -rf "$stub_dir"
  return "$rc"
}

echo "check: mode=$mode base=$base"
[ "$list_only" = 1 ] && echo "Selected checks:"

if [ "$rust" = 1 ]; then
  step "cargo fmt --check" cargo fmt --check
  step "cargo clippy --all-targets -D warnings" cargo clippy --all-targets -- -D warnings
  if [ "$mode" = full ]; then
    step "cargo clippy --release --all-targets -D warnings" cargo clippy --release --all-targets -- -D warnings
  fi
  # shellcheck disable=SC2086 # release_flag is empty or one word
  step "cargo test${release_flag:+ $release_flag}" cargo test $release_flag
  if [ "$mode" != quick ]; then
    # shellcheck disable=SC2086
    step "cargo test${release_flag:+ $release_flag} --example benchmark_extended" cargo test $release_flag --example benchmark_extended
    # shellcheck disable=SC2086
    step "cargo test${release_flag:+ $release_flag} --example benchmark_models" cargo test $release_flag --example benchmark_models
    ensure_build
    step "tests/regress.sh + context_prototype.sh" regress
  fi
fi

if [ "$node" = 1 ] || { [ "$rust" = 1 ] && [ "$mode" != quick ]; }; then
  # shellcheck disable=SC2086 # word lists of repository paths
  step "node tests (CI plugin-security set)" node --test $node_base
  ensure_build "for binary-backed node tests"
  # shellcheck disable=SC2086
  # BIN: the binary this run built (release in full mode), not a stale debug build.
  step "node tests (CI test job, BIN=$bin)" env BIN="$abs_bin" node --test $node_built
  # shellcheck disable=SC2086
  [ -n "$extra_tests" ] && step "changed node tests" node --test $extra_tests
fi
for t in $ci_only_tests; do skip "$t (CI job with its own setup; see $ci)"; done

# remove_tree DIR: delete a tree this run created, including read-only parts
# (the candidate builder chmods it to 0500/0400). Symlinks are not followed.
remove_tree() {
  [ -e "$1" ] || return 0
  chmod -R u+rwX "$1" 2>/dev/null || true
  if ! rm -rf "$1" || [ -e "$1" ]; then
    echo "check: could not remove $1" >&2
    return 1
  fi
}
headless_run() {
  cand=$(mktemp -d)
  rc=0
  # shellcheck disable=SC2086 # CI's globs, expanded here as in CI
  node scripts/headless-runtime/build-candidate.mjs --out "$cand/candidate" \
    && RDSH_CANDIDATE="$cand/candidate" node --test $headless_tests || rc=$?
  # A leftover candidate is a failure too, not a silent pass.
  remove_tree "$cand" || { [ "$rc" = 0 ] && rc=1; }
  return "$rc"
}
if [ "$headless" = 1 ]; then
  rt=scripts/headless-runtime/runtime
  if [ ! -f scripts/headless-runtime/build-candidate.mjs ]; then
    skip "headless runtime tests (CI plugin-security job; build script not found)"
  elif [ ! -d "$rt/node_modules" ]; then
    step "headless runtime tests (node_modules missing: npm ci --ignore-scripts --prefix $rt)" false
  else
    step "headless runtime candidate + tests (CI plugin-security job)" headless_run
  fi
fi

for d in $plugins; do
  if [ ! -f "$d/package.json" ]; then
    skip "$d (no package.json; no local check)"
    continue
  fi
  if ! grep -q '"test"' "$d/package.json"; then
    # Covered by the headless step, by another CI step, or by nothing: never silently.
    case " $headless_dirs " in *" $d/ "*) continue ;; esac
    if grep -qF -- "$d/" "$ci"; then skip "$d (no npm test; CI runs it with its own setup, see $ci)"
    else skip "$d (no npm test script of its own; check the root node suites cover it)"; fi
    continue
  fi
  if grep -q '"\(dev\)\{0,1\}[dD]ependencies"' "$d/package.json" && [ ! -d "$d/node_modules" ]; then
    step "$d npm test (node_modules missing: npm ci --ignore-scripts --prefix $d)" false
  else
    ensure_build "for plugin tests"
    # Same contract as CI: plugins locate the built binary through RDSH_BIN.
    step "$d npm test (RDSH_BIN=$abs_bin)" env RDSH_BIN="$abs_bin" BIN="$abs_bin" npm test --prefix "$d"
  fi
done

if [ "$dashboard" = 1 ]; then
  if [ -d dashboard/node_modules ]; then
    step "dashboard npm test" sh -c 'cd dashboard && npm test'
  else
    # Not a pass: a dashboard change must not look verified without its tests.
    step "dashboard npm test (node_modules missing: sh scripts/dev-setup.sh --with-node-deps)" false
  fi
fi

if [ "$release" = 1 ]; then
  step "release policy unittest" python3 -m unittest discover -s tests -p 'test_release_*.py'
  step "icon generation unittest" python3 -m unittest discover -s tests -p 'test_icon_generation.py'
  version=$(sed -n 's/^version *= *"\([^"]*\)".*/\1/p' Cargo.toml | head -n 1)
  step "prepare-release.py v$version" python3 scripts/prepare-release.py "v$version"
fi

if [ "$markdown" = 1 ]; then
  if command -v markdownlint-cli2 >/dev/null 2>&1; then
    step "markdownlint-cli2" markdownlint-cli2 '**/*.md' '#**/node_modules' '#target'
  else
    skip "markdownlint (CI docs job; local: npx markdownlint-cli2 '**/*.md')"
  fi
fi

if [ "$shell" = 1 ]; then
  if command -v shellcheck >/dev/null 2>&1; then
    step "shellcheck dev tooling" shellcheck -s sh scripts/check.sh scripts/check-conflicts.sh \
      scripts/dev-setup.sh scripts/label-conflicts.sh .githooks/pre-commit .githooks/pre-push tests/dev-tooling.sh
  else
    skip "shellcheck (not installed)"
  fi
fi

if [ "$installer" = 1 ]; then
  step "syntax: bash -n install.sh, sh -n install-banner.sh sync-dsh.sh" \
    sh -c 'bash -n install.sh && sh -n install-banner.sh && sh -n sync-dsh.sh'
  if [ "$(uname -s)" = Linux ] && command -v docker >/dev/null 2>&1; then
    step "tests/install-isolated.sh --source local" tests/install-isolated.sh --source local
  else
    skip "tests/install-isolated.sh --source local (CI Isolated install job; needs Linux + Docker)"
  fi
fi
[ "$ps1" = 1 ] && skip "PowerShell installer/tests (CI test (windows-latest, false) job)"
[ "$e2e" = 1 ] && skip "browser e2e (CI browser-e2e job; local: tests/e2e/README.md)"

[ "$devtools" = 1 ] && step "tests/dev-tooling.sh" sh tests/dev-tooling.sh

# Changed files no check above covers are listed, never silently treated as verified.
old_ifs=$IFS; IFS='
'
for f in $unmapped; do
  case "$f" in
    .github/*) skip "$f (CI configuration; verified by the CI run itself)" ;;
    *) skip "$f (no local check mapped; confirm in CI)" ;;
  esac
done
IFS=$old_ifs
step "check-conflicts vs $base" sh scripts/check-conflicts.sh --base "$base"

[ "$list_only" = 1 ] && exit 0
printf '\nSummary:'
printf '%b\n' "$passed$failed"
if [ -n "$skipped" ]; then
  printf 'Not verified locally (confirm in CI):'
  printf '%b\n' "$skipped"
fi
if [ -n "$failed" ]; then
  echo "check: failures above."
  exit 1
fi
if [ -n "$skipped" ]; then
  echo "check: selected checks passed; the items marked todo still need CI"
else
  echo "check: all selected checks passed"
fi
