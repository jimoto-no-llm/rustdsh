#!/usr/bin/env bash
# Pinned --version installs must resolve to the tag itself, not the latest one.
set -euo pipefail
. /cases/lib.sh

[ "${RDSH_RELEASE_VERSION:-latest}" != latest ] || { echo "pinned case needs a concrete tag" >&2; exit 1; }
install_rdsh --from-release >"$HOME/install.log" 2>&1
cat "$HOME/install.log"
grep -q "fetching release asset $RDSH_RELEASE_VERSION/rdsh-linux" "$HOME/install.log"
expect_version
echo "CASE OK: pinned-version"
