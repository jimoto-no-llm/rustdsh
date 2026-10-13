#!/usr/bin/env bash
# Shared helpers for the isolated install cases. Sourced inside the container.
set -euo pipefail

: "${RDSH_RELEASE_BASE:?the driver sets RDSH_RELEASE_BASE}"
: "${PREFIX:?the driver sets PREFIX}"
: "${ASSET_BASE:=/base}"

install_rdsh() {
  # Extra install.sh flags are appended; --version follows the staged tag.
  local args=(--prefix="$PREFIX" "$@")
  if [ "${RDSH_RELEASE_VERSION:-latest}" != latest ]; then
    args+=(--version="$RDSH_RELEASE_VERSION")
  fi
  bash /install.sh "${args[@]}"
}

expect_version() {
  local out
  out="$("$PREFIX/rdsh" --version)"
  case "$out" in
    rdsh\ *) printf 'installed version: %s\n' "$out" ;;
    *) echo "unexpected --version output: $out" >&2; exit 1 ;;
  esac
}

copy_base() {
  # Print a writable copy of the staged release base for tampering cases.
  # Callers must pass the result to use_base: a command substitution cannot
  # export variables into this shell.
  local dest="${1:-/tmp/tampered-base}"
  rm -rf "$dest"
  cp -a "$ASSET_BASE" "$dest"
  printf '%s' "$dest"
}

use_base() {
  export RDSH_RELEASE_BASE="file://$1"
  # The digest registry travels with the base it describes, so a tampered copy
  # still verifies against its own pins. install.sh honours this only for a
  # file:// base, which is why the cases can run with --network=none.
  export RDSH_RELEASE_DIGESTS="$1/release-digests.tsv"
}

registry_version() {
  # Print the tag the staged registry resolves `latest` to.
  local base="${1:-$ASSET_BASE}"
  awk '$1 == "latest" { print $2 }' "$base/release-digests.tsv"
}

base_download_dir() {
  # Print the directory install.sh downloads from. It is always the exact tag
  # the registry resolves to, never latest/download: --version and the default
  # alias both end up at /download/<tag>/<asset>.
  local base="${1:-$ASSET_BASE}"
  printf '%s/download/%s' "$base" "$(registry_version "$base")"
}

repin_asset() {
  # repin_asset BASE ASSET: point the staged registry row at the archive the
  # case just replaced, so the tamper reaches the code under test.
  local base="$1" asset="$2" version sum
  version="$(registry_version "$base")"
  sum="$(cd "$base/download/$version" && sha256sum "$asset" | awk '{print $1}')"
  awk -v v="$version" -v a="$asset" -v s="$sum" 'BEGIN { OFS = " " } $1 == v && $2 == a { $3 = s } { print }' \
    "$base/release-digests.tsv" > "$base/release-digests.tsv.new"
  mv "$base/release-digests.tsv.new" "$base/release-digests.tsv"
}

bare_box_smoke() {
  # A buzz-fresh machine: no dsh, no node, empty DSH_HOME. Every command must
  # run and report; doctor exits 1 while dsh itself is missing, which is its
  # documented "something is not set up yet" status.
  export DSH_HOME="$HOME/dsh-home"
  local rc=0
  "$PREFIX/rdsh" doctor >"$HOME/doctor.txt" 2>&1 || rc=$?
  [ "$rc" = 0 ] || [ "$rc" = 1 ] || { echo "doctor crashed with exit $rc" >&2; exit 1; }
  grep -q 'original dsh' "$HOME/doctor.txt"
  "$PREFIX/rdsh" bench >"$HOME/bench.txt" 2>&1
  grep -q 'median=' "$HOME/bench.txt"
  printf 'hello token smoke\n' >"$HOME/sample.txt"
  "$PREFIX/rdsh" tokens "$HOME/sample.txt" >"$HOME/tokens.txt" 2>&1
  grep -Eq '^[[:space:]]*[0-9]+' "$HOME/tokens.txt"
  mkdir -p "$HOME/project"
  printf 'TODO: isolated smoke\n' >"$HOME/project/notes.txt"
  "$PREFIX/rdsh" search TODO --dir "$HOME/project" >"$HOME/search.txt" 2>&1
  grep -q 'TODO: isolated smoke' "$HOME/search.txt"
  "$PREFIX/rdsh" setup --json >"$HOME/setup.json" 2>&1
  grep -q '"needed"' "$HOME/setup.json"
  echo "bare-box smoke: ok"
}
