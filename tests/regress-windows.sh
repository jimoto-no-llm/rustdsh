#!/usr/bin/env bash
set -euo pipefail

case "${OSTYPE:-}" in
  msys*|cygwin*) ;;
  *) echo "FAIL: this subset must run under Git Bash on Windows" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${BIN:-./target/debug/rdsh.exe}"
TASK_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TASK_ROOT"; }
trap cleanup EXIT INT TERM

if [ ! -f "$BIN" ]; then
  echo "FAIL: rdsh binary missing: $BIN" >&2
  exit 1
fi
if ! command -v cygpath >/dev/null 2>&1; then
  echo "FAIL: cygpath is required under Git Bash" >&2
  exit 1
fi

mkdir -p "$TASK_ROOT/home" "$TASK_ROOT/dsh" "$TASK_ROOT/bin"
WIN_HOME="$(cygpath -w "$TASK_ROOT/home")"
WIN_DSH="$(cygpath -w "$TASK_ROOT/dsh")"
export USERPROFILE="$WIN_HOME" HOME="$WIN_HOME" DSH_HOME="$WIN_DSH"

if ! "$BIN" --version 2>&1 | grep -qi rdsh; then
  echo "FAIL: Windows binary did not start from Git Bash" >&2
  exit 1
fi
echo "ok: Windows binary starts under Git Bash"

# The dsh.exe name delegates non-native commands to the configured original.
cp "$BIN" "$TASK_ROOT/bin/dsh.exe"
NODE_EXE="$(type -P node.exe || type -P node || true)"
if [ -z "$NODE_EXE" ]; then
  echo "FAIL: Node.js is unavailable for the delegation fixture" >&2
  exit 1
fi
export RDSH_ORIG_BIN="$(cygpath -w "$NODE_EXE")"
node_version="$("$NODE_EXE" --version)"
delegated="$("$TASK_ROOT/bin/dsh.exe" --version)"
if [ "$delegated" != "$node_version" ]; then
  echo "FAIL: dsh.exe did not delegate to RDSH_ORIG_BIN" >&2
  exit 1
fi
echo "ok: dsh.exe delegates through RDSH_ORIG_BIN"

native="$("$TASK_ROOT/bin/dsh.exe" doctor 2>&1)"
if ! printf '%s\n' "$native" | grep -q '\[rdsh\] original dsh:'; then
  echo "FAIL: dsh.exe did not retain native doctor dispatch" >&2
  exit 1
fi
echo "ok: dsh.exe keeps native doctor dispatch"

# Run the existing checksum-before-extraction installer cases from Git Bash.
POWERSHELL="$(type -P powershell.exe || type -P powershell || true)"
if [ -z "$POWERSHELL" ]; then
  echo "FAIL: Windows PowerShell is unavailable" >&2
  exit 1
fi
"$POWERSHELL" -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File "$(cygpath -w "$ROOT/tests/installer-security.ps1")" \
  -InstallerPath "$(cygpath -w "$ROOT/install.ps1")"
echo "ok: PowerShell installer security fixture runs from Git Bash"
