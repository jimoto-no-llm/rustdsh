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
}

base_download_dir() {
  # Print the staged download directory for the tag under test.
  local base="${1:-$ASSET_BASE}"
  if [ "${RDSH_RELEASE_VERSION:-latest}" = latest ]; then
    printf '%s/latest/download' "$base"
  else
    printf '%s/download/%s' "$base" "$RDSH_RELEASE_VERSION"
  fi
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
