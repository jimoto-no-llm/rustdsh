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

# Node tests by CI job. Linux-only suites need bubblewrap and run in CI only.
node_base="tests/plugin-security.test.mjs tests/settings-client.test.mjs tests/update-banner.test.mjs
tests/feature-switches.test.mjs tests/discord-presence.test.mjs tests/model_benchmark/fence.test.mjs
tests/serial_proxy/serial-proxy.test.mjs plugins/workflow-board/tests/source-patch.test.mjs"
node_built="tests/runtime-compatibility.test.mjs tests/icon-assets.test.mjs"
node_ci_only="tests/security-boundaries.test.mjs tests/tool-isolation.test.mjs tests/desktop.test.mjs
tests/upstream-approval-integrity.test.mjs"
in_list() { case " $(printf '%s' "$2" | tr '\n' ' ') " in *" $1 "*) return 0 ;; esac; return 1; }

rust=0 node=0 dashboard=0 release=0 markdown=0 shell=0 devtools=0 installer=0 ps1=0 e2e=0
plugins="" extra_tests="" ci_only_tests=""
add_word() { case " $1 " in *" $2 "*) printf '%s' "$1" ;; *) printf '%s' "${1:+$1 }$2" ;; esac; }
case "$mode" in
  quick) rust=1 ;;
  full)
    rust=1 node=1 dashboard=1 release=1 markdown=1 shell=1 devtools=1 installer=1 ps1=1 e2e=1
    for d in plugins/*/; do plugins=$(add_word "$plugins" "${d%/}"); done
    ci_only_tests="$node_ci_only" ;;
  changed)
    files=$(changed_files | sort -u)
    old_ifs=$IFS; IFS='
'
    for f in $files; do
      case "$f" in
        src/*|tests/*.rs|examples/*|benches/*|build.rs|Cargo.toml|Cargo.lock|assets/*|tests/regress.sh|tests/context_prototype.sh) rust=1 ;;
      esac
      case "$f" in
        dashboard/*) dashboard=1 ;;
        tests/e2e/*) e2e=1 ;;
        tests/*.mjs|security/*|plugins/*|scripts/*.mjs) node=1 ;;
      esac
      case "$f" in
        plugins/*/*) d=${f#plugins/}; plugins=$(add_word "$plugins" "plugins/${d%%/*}") ;;
      esac
      case "$f" in
        tests/e2e/*) ;;
        tests/*.test.mjs)
          if in_list "$f" "$node_ci_only"; then ci_only_tests=$(add_word "$ci_only_tests" "$f")
          elif ! in_list "$f" "$node_base $node_built"; then extra_tests=$(add_word "$extra_tests" "$f"); fi ;;
      esac
      case "$f" in
        install.sh|install-banner.sh|sync-dsh.sh|release-digests.tsv|tests/install-isolated*|tests/installer-*) installer=1 ;;
        *.ps1) ps1=1 ;;
      esac
      case "$f" in
        scripts/*.py|tests/test_*.py|Cargo.toml|CHANGELOG.md|docs/releases/*|release-digests.tsv) release=1 ;;
      esac
      case "$f" in *.md) markdown=1 ;; esac
      case "$f" in *.sh|.githooks/*) shell=1 ;; esac
      case "$f" in scripts/check-conflicts.sh|scripts/dev-setup.sh|scripts/check.sh|scripts/label-conflicts.sh|.githooks/*|tests/dev-tooling.sh) devtools=1 ;; esac
    done
    IFS=$old_ifs ;;
esac

release_flag=""
[ "$mode" = full ] && release_flag="--release"
bin=./target/debug/rdsh
[ "$mode" = full ] && bin=./target/release/rdsh

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
  # shellcheck disable=SC2086 # release_flag is empty or one word
  step "cargo test${release_flag:+ $release_flag}" cargo test $release_flag
  if [ "$mode" != quick ]; then
    # shellcheck disable=SC2086
    step "cargo test${release_flag:+ $release_flag} --example benchmark_extended" cargo test $release_flag --example benchmark_extended
    # shellcheck disable=SC2086
    step "cargo test${release_flag:+ $release_flag} --example benchmark_models" cargo test $release_flag --example benchmark_models
    # shellcheck disable=SC2086
    step "cargo build${release_flag:+ $release_flag}" cargo build $release_flag
    step "tests/regress.sh + context_prototype.sh" regress
  fi
fi

if [ "$node" = 1 ] || { [ "$rust" = 1 ] && [ "$mode" != quick ]; }; then
  # shellcheck disable=SC2086 # word lists of repository paths
  step "node tests (CI plugin-security set)" node --test $node_base
  if [ "$rust" != 1 ] || [ "$mode" = quick ]; then
    # shellcheck disable=SC2086
    step "cargo build${release_flag:+ $release_flag} (for binary-backed node tests)" cargo build $release_flag
  fi
  # shellcheck disable=SC2086
  # BIN: the binary this run built (release in full mode), not a stale debug build.
  step "node tests (CI test job, BIN=$bin)" env BIN="$bin" node --test $node_built
  # shellcheck disable=SC2086
  [ -n "$extra_tests" ] && step "changed node tests" node --test $extra_tests
fi
for t in $ci_only_tests; do skip "$t (CI security-boundaries job: Linux + bubblewrap)"; done

for d in $plugins; do
  [ -f "$d/package.json" ] || continue
  grep -q '"test"' "$d/package.json" || continue
  if grep -q '"\(dev\)\{0,1\}[dD]ependencies"' "$d/package.json" && [ ! -d "$d/node_modules" ]; then
    step "$d npm test (node_modules missing: npm ci --ignore-scripts --prefix $d)" false
  else
    step "$d npm test" npm test --prefix "$d"
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
