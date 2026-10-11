#!/usr/bin/env bash
# Re-running the installer over an existing install must stay clean.
set -euo pipefail
. /cases/lib.sh

install_rdsh --from-release
expect_version
install_rdsh --from-release
expect_version
count="$(find "$PREFIX" -maxdepth 1 -type f -name rdsh | wc -l)"
[ "$count" = 1 ] || { echo "expected one rdsh binary, found $count" >&2; exit 1; }
leftovers="$(find "$PREFIX" -maxdepth 1 -name '.dsh.new.*' | wc -l)"
[ "$leftovers" = 0 ] || { echo "installer left $leftovers temporary files behind" >&2; exit 1; }
echo "CASE OK: reinstall"
