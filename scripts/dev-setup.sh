#!/bin/sh
# Prepare a rustdsh checkout for development (macOS, Linux, WSL, Git Bash).
#
#   sh scripts/dev-setup.sh                   # check tools, enable hooks and local git settings
#   sh scripts/dev-setup.sh --check           # report only; change nothing
#   sh scripts/dev-setup.sh --with-node-deps  # also npm ci in dashboard/
#
# Git settings are written to this repository only (git config --local) and
# never replace a value you have already set. Run it again at any time.
set -eu

check_only=0
node_deps=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_only=1 ;;
    --with-node-deps) node_deps=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "dev-setup: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "dev-setup: run inside the rustdsh checkout" >&2; exit 2; }
cd "$root"

missing=0
ok() { printf '  ok    %s\n' "$1"; }
warn() { printf '  warn  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; missing=$((missing+1)); }

# version_ge 1.85.0 1.85 -> true. Compares up to three numeric fields.
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0 }'
}

msrv=$(sed -n 's/^rust-version *= *"\([0-9.]*\)".*/\1/p' Cargo.toml)

echo "Tools"
if command -v git >/dev/null 2>&1; then
  v=$(git --version | awk '{print $3}')
  if version_ge "$v" 2.38; then ok "git $v"; else fail "git $v is older than 2.38 (scripts/check-conflicts.sh and the pre-push hook need it)"; fi
else
  fail "git not found"
fi

if command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1; then
  v=$(rustc --version | awk '{print $2}')
  if version_ge "$v" "$msrv"; then ok "rustc $v (MSRV $msrv; CI lint uses stable)"; else fail "rustc $v is older than MSRV $msrv (rustup update stable)"; fi
  if cargo fmt --version >/dev/null 2>&1; then ok "rustfmt"; else fail "rustfmt missing (rustup component add rustfmt)"; fi
  if cargo clippy --version >/dev/null 2>&1; then ok "clippy"; else fail "clippy missing (rustup component add clippy)"; fi
else
  fail "Rust toolchain not found (https://rustup.rs)"
fi

if command -v node >/dev/null 2>&1; then
  v=$(node --version | sed 's/^v//')
  if version_ge "$v" 22; then ok "node $v"; else fail "node $v is older than 22"; fi
  if command -v npm >/dev/null 2>&1; then ok "npm $(npm --version)"; else fail "npm not found"; fi
else
  fail "node 22+ not found (dashboard, plugins and Node tests)"
fi

if command -v python3 >/dev/null 2>&1; then
  v=$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')
  if version_ge "$v" 3.11; then ok "python3 $v"; else fail "python3 $v is older than 3.11 (release scripts use tomllib)"; fi
else
  fail "python3 3.11+ not found (release scripts and tests)"
fi

if command -v zstd >/dev/null 2>&1; then ok "zstd"; else warn "zstd not found (some cargo tests and tests/regress.sh need it)"; fi
if command -v gh >/dev/null 2>&1; then ok "gh"; else warn "gh not found (optional: check-conflicts --open-prs, PRs)"; fi
if command -v shellcheck >/dev/null 2>&1; then ok "shellcheck"; else warn "shellcheck not found (optional: lint shell scripts)"; fi

echo "Git settings (written to this repository only)"
# set_local KEY VALUE: write only when no scope (system, global, local, worktree)
# sets KEY, so an effective personal or managed setting is never overridden.
set_local() {
  current=$(git config --get "$1" 2>/dev/null || true)
  if [ -n "$current" ]; then
    scope=$(git config --show-scope --get "$1" 2>/dev/null | cut -f1 || true)
    if [ "$current" = "$2" ]; then ok "$1=$2${scope:+ ($scope)}"
    else ok "$1=$current (kept from ${scope:-config}; recommended $2)"; fi
  elif [ "$check_only" = 1 ]; then
    warn "$1 unset (recommended $2)"
  else
    git config --local "$1" "$2"
    ok "$1=$2 (set)"
  fi
}
# Hooks: block conflict markers and unformatted Rust; warn on conflicts at push.
set_local core.hooksPath .githooks
hooks=$(git config --get core.hooksPath 2>/dev/null || true)
if [ -n "$hooks" ] && [ "$hooks" != .githooks ]; then
  warn "repository hooks inactive: core.hooksPath=$hooks. To opt in here: git config --local core.hooksPath .githooks"
  warn "  (or call .githooks/pre-commit and .githooks/pre-push from your own hooks)"
fi
# Reuse recorded resolutions when the same conflict appears again (main merged repeatedly).
set_local rerere.enabled true
set_local rerere.autoupdate true
# Show the common ancestor in conflict hunks; easier to resolve correctly.
if version_ge "$(git --version | awk '{print $3}')" 2.35; then style=zdiff3; else style=diff3; fi
set_local merge.conflictStyle "$style"
# Drop remote branches deleted after merge (delete_branch_on_merge is on).
set_local fetch.prune true

if [ "$node_deps" = 1 ]; then
  echo "Node dependencies"
  if [ "$check_only" = 1 ]; then
    warn "--check given; skipped npm ci"
  else
    if (cd dashboard && npm ci --no-audit --no-fund); then ok "dashboard/node_modules"; else fail "npm ci in dashboard/"; fi
  fi
fi

echo
if [ "$missing" -gt 0 ]; then
  echo "dev-setup: $missing required item(s) missing; see FAIL lines above."
  exit 1
fi
if [ "$check_only" = 1 ]; then
  echo "dev-setup: tools OK. Run without --check to apply the git settings marked warn."
else
  echo "dev-setup: ready. Next: sh scripts/check.sh   (docs/DEVELOPMENT.md)"
fi
