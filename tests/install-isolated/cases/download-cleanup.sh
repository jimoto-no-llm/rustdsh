#!/usr/bin/env bash
# #390: --from-release must not leave download temp files behind.
# fetch_release runs inside a command substitution, so its scratch dir is
# tracked in a file the EXIT trap reads. Assert the dedicated TMPDIR is
# empty after a successful install.
set -euo pipefail
. /cases/lib.sh

scratch="$HOME/dl-tmp"
mkdir -p "$scratch"
export TMPDIR="$scratch"
install_rdsh --from-release >"$HOME/install.log" 2>&1
expect_version
leftover="$(find "$scratch" -mindepth 1 | head -20)"
[ -z "$leftover" ] || { echo "download temp files leaked: $leftover" >&2; exit 1; }
echo "CASE OK: download-cleanup"
