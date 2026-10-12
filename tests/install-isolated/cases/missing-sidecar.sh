#!/usr/bin/env bash
# Missing checksum sidecars must fail closed, not install unverified bytes.
set -euo pipefail
. /cases/lib.sh

base="$(copy_base)"
use_base "$base"
find "$base" -name '*.sha256' -delete

if install_rdsh --from-release >"$HOME/install.log" 2>&1; then
  echo "installer installed without a checksum sidecar" >&2
  exit 1
fi
grep -q 'no checksum sidecar' "$HOME/install.log"
if [ -e "$PREFIX/rdsh" ]; then
  echo "installer left a binary behind after a sidecar failure" >&2
  exit 1
fi
echo "CASE OK: missing-sidecar"
