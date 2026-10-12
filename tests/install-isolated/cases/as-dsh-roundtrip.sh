#!/usr/bin/env bash
# --as-dsh shadows an existing dsh with a backup, --restore puts it back.
set -euo pipefail
. /cases/lib.sh

mkdir -p "$PREFIX"
printf '#!/bin/sh\necho "original-dsh $*"\n' > "$PREFIX/dsh"
chmod 755 "$PREFIX/dsh"

install_rdsh --from-release --as-dsh
[ -x "$PREFIX/dsh-orig" ] || { echo "no dsh-orig backup" >&2; exit 1; }
# `dsh --version` is delegated verbatim to the original dsh by design, so the
# shadowing check uses a native command instead.
out="$("$PREFIX/dsh" doctor 2>&1)"
case "$out" in *rdsh*) ;; *) echo "dsh is not rdsh after --as-dsh: $out" >&2; exit 1 ;; esac
expect_version

bash /install.sh --restore
out="$("$PREFIX/dsh")"
case "$out" in original-dsh*) ;; *) echo "restore did not bring the original dsh back: $out" >&2; exit 1 ;; esac
expect_version
echo "CASE OK: as-dsh-roundtrip"
