#!/usr/bin/env bash
# Verify the desktop client against one harness build.
#
# Usage: scripts/verify-harness.sh [/path/to/dsh]
#
# Run this after installing or updating the upstream harness. It forces a fresh
# host for the given launcher, so a running service is never disturbed.
set -euo pipefail

dsh_path="${1:-}"
if [[ -z "$dsh_path" ]]; then
  dsh_path="$(command -v dsh || true)"
fi
if [[ -z "$dsh_path" || ! -x "$dsh_path" ]]; then
  echo "usage: $0 /path/to/dsh" >&2
  exit 2
fi

app="${RDSH_DESKTOP_BIN:-target/release/rdsh-desktop}"
if [[ ! -x "$app" ]]; then
  echo "desktop binary not found at $app; build it or set RDSH_DESKTOP_BIN" >&2
  exit 2
fi

export RDSH_DESKTOP_DSH="$dsh_path"
export RDSH_DESKTOP_NO_ATTACH=1

echo "harness: $dsh_path ($("$dsh_path" --version 2>/dev/null | tail -n 1))"

probe="$("$app" --probe 2>/dev/null || true)"
case "$probe" in
  *'"sessions"'*) echo "PASS session list" ;;
  *) echo "FAIL session list"; printf '%s\n' "$probe" | head -n 5; exit 1 ;;
esac

catalog="$(printf '%s' "$probe" | grep -c '"groups"' || true)"
if [[ "$catalog" -ge 1 ]]; then echo "PASS model catalog"; else echo "FAIL model catalog"; exit 1; fi

live="$("$app" --dump-live --listen 5 2>/dev/null || true)"
case "$live" in
  *'"eventsReady": true'*) echo "PASS live events" ;;
  *) echo "FAIL live events"; printf '%s\n' "$live" | head -n 5; exit 1 ;;
esac

if [[ "${RDSH_VERIFY_PROMPT:-0}" == "1" ]]; then
  send="$("$app" --send "${RDSH_VERIFY_PROMPT_TEXT:-reply with the single word ok}" --listen 60 2>/dev/null || true)"
  case "$send" in
    *'"assistantChars"'*) echo "PASS prompt streaming" ;;
    *) echo "FAIL prompt streaming"; printf '%s\n' "$send" | tail -n 5; exit 1 ;;
  esac
fi

echo "OK: $("$dsh_path" --version 2>/dev/null | tail -n 1) is compatible"
