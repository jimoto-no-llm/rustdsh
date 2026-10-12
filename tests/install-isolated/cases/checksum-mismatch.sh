#!/usr/bin/env bash
# A tampered archive must be refused and must leave no binary behind.
set -euo pipefail
. /cases/lib.sh

base="$(copy_base)"
use_base "$base"
find "$base" -name 'rdsh-*.tar.gz' -exec sh -c 'printf tamper >> "$1"' _ {} \;
# #390: a failed download must not leak its temp files either.
scratch="$HOME/dl-tmp"
mkdir -p "$scratch"
export TMPDIR="$scratch"

if install_rdsh --from-release >"$HOME/install.log" 2>&1; then
  echo "installer accepted a tampered archive" >&2
  exit 1
fi
grep -q 'CHECKSUM MISMATCH' "$HOME/install.log"
if [ -e "$PREFIX/rdsh" ]; then
  echo "installer left a binary behind after a checksum failure" >&2
  exit 1
fi
leftover="$(find "$scratch" -mindepth 1 | head -20)"
[ -z "$leftover" ] || { echo "download temp files leaked: $leftover" >&2; exit 1; }
echo "CASE OK: checksum-mismatch"
