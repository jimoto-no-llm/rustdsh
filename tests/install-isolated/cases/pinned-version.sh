#!/usr/bin/env bash
# Pinned --version installs must fetch the tag's download path.
set -euo pipefail
. /cases/lib.sh

[ "${RDSH_RELEASE_VERSION:-latest}" != latest ] || { echo "pinned case needs a concrete tag" >&2; exit 1; }
install_rdsh --from-release >"$HOME/install.log" 2>&1
cat "$HOME/install.log"
grep -q "download/$RDSH_RELEASE_VERSION/rdsh-linux" "$HOME/install.log"
expect_version
echo "CASE OK: pinned-version"
