#!/usr/bin/env bash
# Fresh install from the staged release base plus a bare-box smoke test.
set -euo pipefail
. /cases/lib.sh

printf 'host libc: %s\n' "$(ldd --version 2>&1 | head -n 1)"
install_rdsh --from-release
expect_version
bare_box_smoke
echo "CASE OK: install-and-smoke"
