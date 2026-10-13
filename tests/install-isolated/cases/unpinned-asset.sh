#!/usr/bin/env bash
# An asset with no registry pin must fail closed, not install unverified bytes.
# Replaces the sidecar-era case: install.sh no longer trusts <asset>.sha256, so
# the equivalent guard is a release the trusted registry does not pin.
set -euo pipefail
. /cases/lib.sh

# v0.0.1 is deliberately absent from the staged registry.
if install_rdsh --from-release --version=v0.0.1 >"$HOME/install.log" 2>&1; then
  echo "installer installed an unpinned release" >&2
  exit 1
fi
grep -q 'no pinned checksum' "$HOME/install.log"
if [ -e "$PREFIX/rdsh" ]; then
  echo "installer left a binary behind after an unpinned release" >&2
  exit 1
fi
echo "CASE OK: unpinned-asset"
