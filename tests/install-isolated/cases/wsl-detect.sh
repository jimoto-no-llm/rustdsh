#!/usr/bin/env bash
# WSL detection stays informational and the install still succeeds.
set -euo pipefail
. /cases/lib.sh

WSL_DISTRO_NAME=Ubuntu install_rdsh --from-release >"$HOME/install.log" 2>&1
cat "$HOME/install.log"
grep -q 'WSL detected' "$HOME/install.log"
expect_version
echo "CASE OK: wsl-detect"
