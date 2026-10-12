#!/usr/bin/env bash
# Issue #303: sync-dsh.sh must check the release archive against the pinned
# repository digest registry, not against an <asset>.sha256 served by the same
# release base, and must refuse a non-https release base outside the explicit
# RDSH_TEST_INSECURE_BASE=1 test mode.
#
# SYNC_SCRIPT points the same harness at another revision of the script (used to
# show that an older revision installs the hostile archive); SCENARIOS selects a
# subset of the names below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNC_SCRIPT="${SYNC_SCRIPT:-$ROOT/sync-dsh.sh}"
SCENARIOS="${SCENARIOS:-all}"
REGISTRY_URL="https://raw.githubusercontent.com/jimoto-no-llm/rustdsh/main/release-digests.tsv"
ASSETS=(rdsh-linux-x64.tar.gz rdsh-linux-x64-musl.tar.gz rdsh-macos-arm64.tar.gz rdsh-macos-x64.tar.gz)

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/sync-integrity.XXXXXX")"
HTTP_PID=""
BASE=""
stop_http() {
  if [ -n "$HTTP_PID" ]; then
    kill "$HTTP_PID" 2>/dev/null || true
    wait "$HTTP_PID" 2>/dev/null || true
    HTTP_PID=""
  fi
}
cleanup() {
  stop_http
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

REAL_CURL="$(command -v curl || true)"
REAL_NODE="$(command -v node || true)"
if [ -z "$REAL_CURL" ] || [ -z "$REAL_NODE" ]; then
  echo "FAIL: curl and node are required" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  sum_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sum_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  echo "FAIL: sha256sum or shasum is required" >&2
  exit 1
fi

REL="$TEST_ROOT/rel"
PKG="$TEST_ROOT/pkg"
SHIM="$TEST_ROOT/shim"
REPO="$TEST_ROOT/repo"
LOGS="$TEST_ROOT/logs"
HOME_DIR="$TEST_ROOT/home"
OUT="$TEST_ROOT/out"
NPMROOT="$TEST_ROOT/npmroot"
MANIFEST="$TEST_ROOT/release-digests.tsv"
CURL_LOG="$TEST_ROOT/curl.log"
mkdir -p "$REL/latest/download" "$REL/download/v9.9.9" "$PKG/good" "$PKG/evil" "$SHIM" \
  "$REPO" "$LOGS" "$HOME_DIR/.local/bin" "$OUT" "$NPMROOT/@deepseek-ai/dsh" "$TEST_ROOT/tmp"
: >"$CURL_LOG"
# Run from a copy so the script finds no tests/ or target/ next to itself.
cp "$SYNC_SCRIPT" "$REPO/sync-dsh.sh"

failures=0
ok() { echo "ok: $1"; }
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }
show() { sed 's/^/    /' "$1" >&2; }

# npm/node/host shims: the update path only needs version answers, never a real
# dsh package or a real install.
printf '{"version":"1.0.0"}\n' >"$NPMROOT/@deepseek-ai/dsh/package.json"
cat >"$HOME_DIR/.local/bin/npm" <<NPM_EOF
#!/bin/sh
case "\$1" in
  root) echo "$NPMROOT" ;;
  view) echo '["1.0.0"]' ;;
  *) exit 1 ;;
esac
NPM_EOF
cat >"$HOME_DIR/.local/bin/node" <<NODE_EOF
#!/bin/sh
case "\$1" in
  -p) echo "1.0.0" ;;
  *) exec "$REAL_NODE" "\$@" ;;
esac
NODE_EOF
chmod +x "$HOME_DIR/.local/bin/npm" "$HOME_DIR/.local/bin/node"

# Fixture curl: the canonical registry URL is served from a local manifest, so
# this test needs no network and proves the updater never asks the release base
# for a checksum. RDSH_TEST_REGISTRY=off makes the registry unreachable.
cat >"$SHIM/curl" <<CURL_EOF
#!/bin/sh
printf '%s\n' "\$*" >>"$CURL_LOG"
out=""
prev=""
url=""
for arg in "\$@"; do
  [ "\$prev" = "-o" ] && out="\$arg"
  prev="\$arg"
  url="\$arg"
done
if [ -n "\$out" ] && [ "\$url" = "$REGISTRY_URL" ]; then
  [ "\${RDSH_TEST_REGISTRY:-fixture}" != off ] || exit 22
  cp "$MANIFEST" "\$out"
  exit 0
fi
exec "$REAL_CURL" "\$@"
CURL_EOF
chmod +x "$SHIM/curl"

make_archive() { tar -czf "$2" -C "$1" rdsh; }

# Same bytes at both URL shapes: latest/download/<asset> (old revision) and
# download/<version>/<asset> (pinned revision), each with a matching sidecar so
# a sidecar-trusting revision would accept them.
stage_release() {
  for dir in "$REL/latest/download" "$REL/download/v9.9.9"; do
    for asset in "${ASSETS[@]}"; do
      cp "$1" "$dir/$asset"
      printf '%s  %s\n' "$(sum_file "$1")" "$asset" >"$dir/$asset.sha256"
    done
  done
}

write_manifest() { # $1 = sha256 for every asset, $2 = latest version
  version="${2:-v9.9.9}"
  {
    printf '# local fixture\nlatest %s\n' "$version"
    for asset in "${ASSETS[@]}"; do printf '%s %s %s\n' "$version" "$asset" "$1"; done
  } >"$MANIFEST"
}

make_stub() { # $1 = dir, $2 = marker
  mkdir -p "$1"
  cat >"$1/rdsh" <<STUB_EOF
#!/bin/sh
case "\${1:-}" in
  --version) echo "rdsh stub $2" ;;
  *) echo "rdsh stub $2" ;;
esac
STUB_EOF
  chmod +x "$1/rdsh"
}

reset_prefix() { rm -rf "$OUT/bin"; mkdir -p "$OUT/bin"; }

run_sync() { # $1 = log, $2 = registry mode, $3 = RDSH_TEST_INSECURE_BASE, $4 = RDSH_SYNC_VERSION
  log_file="$1"; registry="$2"; insecure="$3"; version="${4:-}"
  : >"$CURL_LOG"
  if ! env -u RDSH_SYNC_FROM_SOURCE -u RDSH_MUSL \
    HOME="$HOME_DIR" NPM_BIN="$HOME_DIR/.local/bin/npm" PREFIX_BIN="$OUT/bin" \
    TMPDIR="$TEST_ROOT/tmp" RDSH_RELEASE_BASE="$BASE" RDSH_TEST_INSECURE_BASE="$insecure" \
    RDSH_TEST_REGISTRY="$registry" RDSH_SYNC_VERSION="${version:-latest}" \
    PATH="$SHIM:$PATH" sh "$REPO/sync-dsh.sh" >"$log_file" 2>&1; then
    echo "note: sync-dsh.sh exited non-zero for $log_file" >&2
  fi
}

start_http() { # $1 = directory to serve, $2 = plain|redirect; sets HTTP_PORT
  stop_http
  rm -f "$TEST_ROOT/port"
  python3 - "$1" "$TEST_ROOT/port" "${2:-plain}" >"$TEST_ROOT/http.log" 2>&1 <<'PY' &
import http.server, os, socketserver, sys
os.chdir(sys.argv[1])
mode = sys.argv[3]
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        # Bounce the version-pinned path onto the latest/ path, which serves the
        # same bytes, so a followed redirect still installs.
        if mode == "redirect" and self.path.startswith("/download/"):
            self.send_response(302)
            self.send_header("Location", "/latest/download/" + self.path.rsplit("/", 1)[-1])
            self.end_headers()
            return
        super().do_GET()
class Server(socketserver.TCPServer):
    allow_reuse_address = True
with Server(("127.0.0.1", 0), Handler) as server:
    with open(sys.argv[2], "w") as port_file:
        port_file.write(str(server.server_address[1]))
    server.serve_forever()
PY
  HTTP_PID=$!
  i=0
  while [ ! -s "$TEST_ROOT/port" ]; do
    i=$((i + 1))
    if [ "$i" -ge 50 ] || ! kill -0 "$HTTP_PID" 2>/dev/null; then
      fail "http fixture did not start"
      return 1
    fi
    sleep 0.1
  done
  HTTP_PORT="$(cat "$TEST_ROOT/port")"
}

# A same-origin archive plus its own sidecar cannot authorize an update; only
# the repository pin can, and it still pins the genuine archive here.
scenario_hostile() {
  make_stub "$PKG/good" good
  make_stub "$PKG/evil" evil
  make_archive "$PKG/good" "$TEST_ROOT/good.tar.gz"
  make_archive "$PKG/evil" "$TEST_ROOT/evil.tar.gz"
  stage_release "$TEST_ROOT/evil.tar.gz"
  write_manifest "$(sum_file "$TEST_ROOT/good.tar.gz")"
  reset_prefix
  BASE="file://$REL"
  run_sync "$LOGS/hostile.log" fixture 1
  if [ -e "$OUT/bin/rdsh" ]; then
    show "$LOGS/hostile.log"
    fail "hostile same-origin archive was installed"
    return 0
  fi
  if ! grep -q "CHECKSUM MISMATCH" "$LOGS/hostile.log"; then
    show "$LOGS/hostile.log"
    fail "hostile same-origin archive was not reported as a checksum mismatch"
    return 0
  fi
  ok "hostile same-origin archive with a self-computed sidecar is refused"
}

# Control for scenario_hostile: the pinned archive alone installs.
scenario_pinned() {
  make_stub "$PKG/good" good
  make_archive "$PKG/good" "$TEST_ROOT/good.tar.gz"
  stage_release "$TEST_ROOT/good.tar.gz"
  write_manifest "$(sum_file "$TEST_ROOT/good.tar.gz")"
  reset_prefix
  BASE="file://$REL"
  run_sync "$LOGS/pinned.log" fixture 1
  if [ ! -x "$OUT/bin/rdsh" ] || ! cmp -s "$OUT/bin/rdsh" "$PKG/good/rdsh"; then
    show "$LOGS/pinned.log"
    fail "pinned release archive was not installed"
    return 0
  fi
  if ! grep -q "checksum ok" "$LOGS/pinned.log" || ! grep -q "rdsh updated OK via release binary" "$LOGS/pinned.log"; then
    show "$LOGS/pinned.log"
    fail "pinned release archive installed without the expected log"
    return 0
  fi
  ok "pinned release archive installs (control)"
}

# Plain http is refused before anything is fetched; the same base works in the
# explicit test mode, which proves the scheme is the only reason for refusal.
scenario_http() {
  make_stub "$PKG/good" good
  make_archive "$PKG/good" "$TEST_ROOT/good.tar.gz"
  stage_release "$TEST_ROOT/good.tar.gz"
  write_manifest "$(sum_file "$TEST_ROOT/good.tar.gz")"
  start_http "$REL" || return 0
  BASE="http://127.0.0.1:$HTTP_PORT"
  reset_prefix
  run_sync "$LOGS/http.log" fixture 0
  if [ -e "$OUT/bin/rdsh" ]; then
    show "$LOGS/http.log"
    fail "plain http release base was accepted outside test mode"
    return 0
  fi
  if ! grep -q "refusing non-https release base" "$LOGS/http.log"; then
    show "$LOGS/http.log"
    fail "plain http release base was not refused by name"
    return 0
  fi
  if [ -s "$CURL_LOG" ]; then
    show "$CURL_LOG"
    fail "plain http release base was refused after a fetch"
    return 0
  fi
  ok "plain http release base is refused before any fetch"
  reset_prefix
  run_sync "$LOGS/http-test.log" fixture 1
  if [ ! -x "$OUT/bin/rdsh" ] || ! grep -q "rdsh updated OK via release binary" "$LOGS/http-test.log"; then
    show "$LOGS/http-test.log"
    fail "RDSH_TEST_INSECURE_BASE=1 control did not install from the same base"
    return 0
  fi
  ok "RDSH_TEST_INSECURE_BASE=1 control installs from the same base"
}

# The configured scheme is not the only way a fetch lands on plain http: a
# redirect target must stay https too.
scenario_redirect() {
  make_stub "$PKG/good" good
  make_archive "$PKG/good" "$TEST_ROOT/good.tar.gz"
  stage_release "$TEST_ROOT/good.tar.gz"
  write_manifest "$(sum_file "$TEST_ROOT/good.tar.gz")"
  start_http "$REL" redirect || return 0
  BASE="http://127.0.0.1:$HTTP_PORT"
  if ! "$REAL_CURL" -fsSL -o /dev/null "$BASE/latest/download/rdsh-linux-x64.tar.gz"; then
    fail "redirect fixture target is not reachable"
    return 0
  fi
  reset_prefix
  run_sync "$LOGS/redirect.log" fixture 1
  if [ -e "$OUT/bin/rdsh" ]; then
    show "$LOGS/redirect.log"
    fail "update followed a redirect onto a non-https URL"
    return 0
  fi
  if ! grep -q "rdsh release fetch failed" "$LOGS/redirect.log"; then
    show "$LOGS/redirect.log"
    fail "refused redirect was not reported as a failed fetch"
    return 0
  fi
  ok "a release fetch redirected onto plain http is not followed"
}

scenario_registry_unreachable() {
  make_stub "$PKG/good" good
  make_archive "$PKG/good" "$TEST_ROOT/good.tar.gz"
  stage_release "$TEST_ROOT/good.tar.gz"
  write_manifest "$(sum_file "$TEST_ROOT/good.tar.gz")"
  reset_prefix
  BASE="file://$REL"
  run_sync "$LOGS/registry-off.log" off 1
  if [ -e "$OUT/bin/rdsh" ] || ! grep -q "could not fetch the trusted release digest registry" "$LOGS/registry-off.log"; then
    show "$LOGS/registry-off.log"
    fail "unreachable digest registry did not refuse the update"
    return 0
  fi
  ok "unreachable digest registry refuses the update"
}

scenario_registry_invalid() {
  make_stub "$PKG/good" good
  make_archive "$PKG/good" "$TEST_ROOT/good.tar.gz"
  stage_release "$TEST_ROOT/good.tar.gz"
  printf 'v9.9.9 rdsh-linux-x64.tar.gz not-a-digest\n' >"$MANIFEST"
  reset_prefix
  BASE="file://$REL"
  run_sync "$LOGS/registry-bad.log" fixture 1
  if [ -e "$OUT/bin/rdsh" ] || ! grep -q "trusted release digest registry is invalid" "$LOGS/registry-bad.log"; then
    show "$LOGS/registry-bad.log"
    fail "invalid digest registry did not refuse the update"
    return 0
  fi
  ok "invalid digest registry refuses the update"
}

scenario_unpinned() {
  make_stub "$PKG/good" good
  make_archive "$PKG/good" "$TEST_ROOT/good.tar.gz"
  stage_release "$TEST_ROOT/good.tar.gz"
  write_manifest "$(sum_file "$TEST_ROOT/good.tar.gz")"
  reset_prefix
  BASE="file://$REL"
  run_sync "$LOGS/unpinned.log" fixture 1 v9.9.8
  if [ -e "$OUT/bin/rdsh" ] || ! grep -q "no pinned checksum for release v9.9.8" "$LOGS/unpinned.log"; then
    show "$LOGS/unpinned.log"
    fail "release without a registry row did not refuse the update"
    return 0
  fi
  ok "release without a registry row refuses the update"
}

# The trusted origin must stay a literal constant, and the archive URL must name
# the pinned version instead of the redirecting latest/download path.
scenario_static() {
  if ! grep -q "^RELEASE_DIGESTS_URL=\"$REGISTRY_URL\"\$" "$REPO/sync-dsh.sh"; then
    fail "digest registry URL is not the canonical literal"
    return 0
  fi
  if grep -q "RELEASE_DIGESTS_URL:-" "$REPO/sync-dsh.sh"; then
    fail "digest registry URL is environment-overridable"
    return 0
  fi
  if grep -q "latest/download" "$REPO/sync-dsh.sh"; then
    fail "release URL still uses the redirecting latest/download path"
    return 0
  fi
  ok "digest registry origin is a fixed literal and archives are version-pinned"
}

for name in hostile pinned http redirect registry_unreachable registry_invalid unpinned static; do
  case "$SCENARIOS" in
    all | *"$name"*) "scenario_$name" ;;
  esac
done

if [ "$failures" -ne 0 ]; then
  echo "sync-release-integrity: $failures failure(s)" >&2
  exit 1
fi
echo "sync-release-integrity: ALL PASS"
