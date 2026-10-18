#!/bin/sh
# Existing Gas City commands, with the local deployment's pinned runtime.
set -eu
root=${RDSH_LOCAL_ROOT:?Set RDSH_LOCAL_ROOT to the prepared deployment directory}
prefix=${RDSH_RUNTIME_PREFIX:-"$HOME/.local/share/deepflow-swarm"}
jq="$prefix/toolchains/jq-1.8.1/jq"
gc=$("$jq" -er .gc "$root/runtime.json")
rdsh=$("$jq" -er .rdsh "$root/runtime.json")
export GC_HOME="$root/home/.gc"
export GC_CITY="$root/city"
export GC_BEADS=file
export PATH="$(dirname "$jq"):$(dirname "$gc"):$prefix/node-v24.15.0-linux-x64/bin:/usr/bin:/bin"
export RDSH_GASCITY_BIN="$gc"
export RDSH_GASCITY_SHA256=02d9cac82babe4f0316c4764cdb5faadd40c3cae85796c8acbfdcf34b9258376
export RDSH_GASCITY_CITY="$GC_CITY"
case "${1:-status}" in
  start|status|stop|doctor) exec "$rdsh" swarm "${1:-status}" ;;
  *)
    printf '%s  %s\n' "$RDSH_GASCITY_SHA256" "$gc" | sha256sum --check --status
    exec "$gc" "$@"
    ;;
esac
