#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

INSTALLER="$ROOT/install.sh"
FUNCTIONS="$TEST_ROOT/installer-functions.sh"
extract_function() {
  awk -v target="$1" '
    $0 == target "() {" { active = 1; found = 1 }
    active { print }
    active && $0 == "}" { exit }
    END { if (!found) exit 1 }
  ' "$INSTALLER"
}
extract_function cleanup_downloads > "$FUNCTIONS"
extract_function new_download_tmpd >> "$FUNCTIONS"
# shellcheck disable=SC1090
source "$FUNCTIONS"

DOWNLOAD_TMPD_ALL=("")
DOWNLOAD_TMPD=""
cleanup_downloads
export TMPDIR="$TEST_ROOT/with space"
mkdir -p "$TMPDIR" "$TEST_ROOT/with" "$TEST_ROOT/space"
printf 'keep\n' > "$TEST_ROOT/with/keep.txt"
printf 'keep\n' > "$TEST_ROOT/space/keep.txt"
# GNU and BSD mktemp differ in their no-template default. Make the helper's
# output deterministic so this test exercises cleanup of a path with spaces.
mktemp() {
  if [[ "$#" -ne 1 || "$1" != "-d" ]]; then
    echo "unexpected mktemp arguments: $*" >&2
    return 2
  fi
  command mktemp -d "$TMPDIR/rdsh.XXXXXXXXXX"
}

cd "$TEST_ROOT"
new_download_tmpd
first="$DOWNLOAD_TMPD"
new_download_tmpd
second="$DOWNLOAD_TMPD"
case "$first" in "$TMPDIR"/*) ;; *) echo "first temp dir escaped TMPDIR: $first" >&2; exit 1 ;; esac
case "$second" in "$TMPDIR"/*) ;; *) echo "second temp dir escaped TMPDIR: $second" >&2; exit 1 ;; esac
cleanup_downloads

if [[ ! -f "$TEST_ROOT/with/keep.txt" || ! -f "$TEST_ROOT/space/keep.txt" ]]; then
  echo "cleanup removed an unrelated fixture under the test root" >&2
  exit 1
fi
if [[ -e "$first" || -e "$second" ]]; then
  echo "cleanup left an installer temp directory behind" >&2
  exit 1
fi
