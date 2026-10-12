#!/usr/bin/env bash
# When the glibc build cannot start, the installer must retry with the static
# musl build instead of leaving a broken binary installed.
set -euo pipefail
. /cases/lib.sh

base="$(copy_base)"
use_base "$base"
dir="$(base_download_dir "$base")"
rm -rf /tmp/stub
mkdir -p /tmp/stub
printf '#!/bin/sh\nexit 1\n' > /tmp/stub/rdsh
chmod 755 /tmp/stub/rdsh
tar -czf "$dir/rdsh-linux-x64.tar.gz" -C /tmp/stub rdsh
(cd "$dir" && sha256sum rdsh-linux-x64.tar.gz > rdsh-linux-x64.tar.gz.sha256)

install_rdsh --from-release >"$HOME/install.log" 2>&1
cat "$HOME/install.log"
grep -q 'retrying with the static musl build' "$HOME/install.log"
expect_version
bare_box_smoke
echo "CASE OK: fallback-unrunnable-glibc"
