#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT INT TERM
RELEASE_ROOT="$TEST_ROOT/releases"
TMP_ROOT="$TEST_ROOT/tmp"
CURL_SHIM="$TEST_ROOT/bin"
MANIFEST="$TEST_ROOT/release-digests.tsv"
CURL_LOG="$TEST_ROOT/curl.log"
mkdir -p "$RELEASE_ROOT/download/v9.9.9" "$TEST_ROOT/pkg" "$TMP_ROOT" "$CURL_SHIM"
export HOME="$TEST_ROOT/home" DSH_HOME="$TEST_ROOT/dsh" TMPDIR="$TMP_ROOT"
export RDSH_RELEASE_BASE="file://$RELEASE_ROOT" RDSH_TEST_MANIFEST="$MANIFEST" RDSH_TEST_CURL_LOG="$CURL_LOG"
export PATH="$CURL_SHIM:$PATH"
unset RDSH_NO_CHECKSUM || true

fail() { echo "FAIL: $1" >&2; exit 1; }
ok() { echo "ok: $1"; }

if command -v sha256sum >/dev/null 2>&1; then
  sum_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sum_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "sha256sum or shasum is required"
fi

cat >"$CURL_SHIM/curl" <<'CURL_EOF'
#!/bin/sh
set -eu
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --proto) shift 2 ;;
    --tlsv1.2) shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$out" ] && [ -n "$url" ] || exit 2
printf '%s\n' "$url" >> "$RDSH_TEST_CURL_LOG"
if [ "$url" = "https://raw.githubusercontent.com/jimoto-no-llm/rustdsh/main/release-digests.tsv" ]; then
  cp "$RDSH_TEST_MANIFEST" "$out"
elif [ "${url#file://}" != "$url" ]; then
  cp "${url#file://}" "$out"
else
  echo "unexpected test URL: $url" >&2
  exit 22
fi
CURL_EOF
chmod +x "$CURL_SHIM/curl"

cat >"$TEST_ROOT/pkg/rdsh" <<'RDSH_EOF'
#!/bin/sh
case "${1:-}" in
  --version) echo "rdsh release fixture" ;;
  doctor) echo "rdsh fixture doctor" ;;
  *) echo "rdsh fixture" ;;
esac
RDSH_EOF
chmod +x "$TEST_ROOT/pkg/rdsh"
GOOD_ARCHIVE="$RELEASE_ROOT/download/v9.9.9/rdsh-linux-x64.tar.gz"
tar -czf "$GOOD_ARCHIVE" -C "$TEST_ROOT/pkg" rdsh
GOOD_SHA="$(sum_file "$GOOD_ARCHIVE")"
ASSETS=(rdsh-linux-x64.tar.gz rdsh-linux-x64-musl.tar.gz rdsh-macos-arm64.tar.gz rdsh-macos-x64.tar.gz)
for asset in "${ASSETS[@]}"; do
  [ "$asset" = "rdsh-linux-x64.tar.gz" ] || cp "$GOOD_ARCHIVE" "$RELEASE_ROOT/download/v9.9.9/$asset"
done
{
  printf '# local fixture\nlatest v9.9.9\n'
  printf 'v9.9.9 rdsh-linux-x64.tar.gz %s\n' "$GOOD_SHA"
  printf 'v9.9.9 rdsh-linux-x64-musl.tar.gz %s\n' "$GOOD_SHA"
  printf 'v9.9.9 rdsh-macos-arm64.tar.gz %s\n' "$GOOD_SHA"
  printf 'v9.9.9 rdsh-macos-x64.tar.gz %s\n' "$GOOD_SHA"
} >"$MANIFEST"

# Validate the checked-in registry through the production parser, then prove
# it refuses an unpinned version before downloading that version's archive.
if RDSH_TEST_MANIFEST="$ROOT/release-digests.tsv" bash "$ROOT/install.sh" --from-release --version=v9.9.9 --prefix="$TEST_ROOT/unpinned" >"$TEST_ROOT/registry.log" 2>&1; then
  fail "unknown version unexpectedly accepted by the checked-in registry"
fi
grep -q "no pinned checksum for release v9.9.9" "$TEST_ROOT/registry.log" || {
  cat "$TEST_ROOT/registry.log" >&2
  fail "checked-in release registry was not validated"
}
ok "checked-in digest registry validates and rejects unknown version"

# The default alias resolves through the registry, and no same-origin sidecar
# is required for a successful install.
if bash "$ROOT/install.sh" --from-release --prefix="$TEST_ROOT/valid-bin" >"$TEST_ROOT/valid.log" 2>&1; then
  if [ -x "$TEST_ROOT/valid-bin/rdsh" ] && "$TEST_ROOT/valid-bin/rdsh" --version | grep -q "rdsh release fixture"; then
    grep -Eq '/download/v9\.9\.9/rdsh-(linux-x64(-musl)?|macos-(arm64|x64))\.tar\.gz$' "$CURL_LOG" || fail "latest did not resolve through the registry"
    ok "pinned latest release installs without a sidecar"
  else
    cat "$TEST_ROOT/valid.log" >&2
    fail "pinned archive did not install"
  fi
else
  cat "$TEST_ROOT/valid.log" >&2
  fail "pinned archive did not install"
fi

# --musl has to find its own registry row: a musl host installs that asset
# without ever trying the glibc one. Only Linux/x86_64 selects it explicitly.
if [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ]; then
  if bash "$ROOT/install.sh" --from-release --musl --prefix="$TEST_ROOT/musl-bin" >"$TEST_ROOT/musl.log" 2>&1 \
    && "$TEST_ROOT/musl-bin/rdsh" --version | grep -q "rdsh release fixture"; then
    grep -Eq '/download/v9\.9\.9/rdsh-linux-x64-musl\.tar\.gz$' "$CURL_LOG" || fail "--musl did not fetch the musl archive"
    ok "pinned musl release installs"
  else
    cat "$TEST_ROOT/musl.log" >&2
    fail "pinned musl archive did not install"
  fi
fi

# A matching same-origin .sha256 cannot authorize a different archive.
cat >"$TEST_ROOT/pkg/rdsh" <<'EVIL_EOF'
#!/bin/sh
echo "unexpected release payload"
EVIL_EOF
chmod +x "$TEST_ROOT/pkg/rdsh"
EVIL_ARCHIVE="$RELEASE_ROOT/download/v9.9.9/evil.tar.gz"
tar -czf "$EVIL_ARCHIVE" -C "$TEST_ROOT/pkg" rdsh
for asset in "${ASSETS[@]}"; do cp "$EVIL_ARCHIVE" "$RELEASE_ROOT/download/v9.9.9/$asset"; done
EVIL_SHA="$(sum_file "$GOOD_ARCHIVE")"
printf '%s  %s\n' "$EVIL_SHA" rdsh-linux-x64.tar.gz >"$GOOD_ARCHIVE.sha256"
if bash "$ROOT/install.sh" --from-release --prefix="$TEST_ROOT/mismatch-bin" >"$TEST_ROOT/mismatch.log" 2>&1; then
  fail "same-origin sidecar authorized a mismatched package"
fi
grep -q "CHECKSUM MISMATCH" "$TEST_ROOT/mismatch.log" || fail "pinned mismatch was not reported"
if grep -q '\.sha256$' "$CURL_LOG"; then fail "installer fetched an untrusted sidecar"; fi
ok "same-origin sidecar cannot replace the repository digest"

# With a bypass requested, require both a controlling TTY and exact `YES`.
python3 - "$ROOT/install.sh" "$TEST_ROOT/no-tty-bin" <<'PY'
import os
import subprocess
import sys

script, prefix = sys.argv[1:]
env = os.environ.copy()
env["RDSH_NO_CHECKSUM"] = "1"
result = subprocess.run(
    ["bash", script, "--from-release", f"--prefix={prefix}"],
    env=env,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    timeout=30,
    start_new_session=True,
)
if result.returncode == 0 or "requires a terminal for confirmation" not in result.stdout:
    print(result.stdout, file=sys.stderr)
    raise SystemExit("noninteractive checksum bypass was not rejected")
PY
ok "checksum bypass refuses to run without a terminal"

cat >"$TEST_ROOT/run-with-tty.py" <<'PY'
import os
import pty
import select
import sys
import time

script, prefix, *extra = sys.argv[1:]
answer = os.environ["RDSH_TEST_ANSWER"]
env = os.environ.copy()
env["RDSH_NO_CHECKSUM"] = "1"
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bash", ["bash", script, "--from-release", f"--prefix={prefix}", *extra], env)
output = b""
sent = False
deadline = time.monotonic() + 30
status = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            chunk = b""
        output += chunk
        if not sent and b"Type YES to continue:" in output:
            os.write(fd, answer.encode() + b"\n")
            sent = True
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        break
else:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    raise SystemExit("interactive checksum-bypass test timed out")
text = output.decode(errors="replace")
print(text, end="")
if not sent:
    raise SystemExit("installer did not request terminal confirmation")
code = os.waitstatus_to_exitcode(status)
if answer == "YES":
    if code != 0 or "checksum bypass confirmed interactively" not in text:
        raise SystemExit("confirmed checksum bypass failed")
elif code == 0 or "checksum bypass not confirmed" not in text:
    raise SystemExit("declined checksum bypass was not rejected")
PY

RDSH_TEST_ANSWER=NO python3 "$TEST_ROOT/run-with-tty.py" "$ROOT/install.sh" "$TEST_ROOT/declined-bin" >"$TEST_ROOT/declined.log" 2>&1 || true
grep -q "checksum bypass not confirmed" "$TEST_ROOT/declined.log" || fail "a declined bypass was accepted"
ok "checksum bypass requires an exact YES response"

mkdir -p "$RELEASE_ROOT/download/v8.8.8"
# A confirmed bypass installs bytes no registry pins, but the installer still
# runs the result: a fixture that cannot start would only trigger the static
# musl retry and a second prompt, which proves nothing about the bypass.
cat >"$TEST_ROOT/pkg/rdsh" <<'UNPINNED_EOF'
#!/bin/sh
echo "rdsh unpinned v8.8.8"
UNPINNED_EOF
chmod +x "$TEST_ROOT/pkg/rdsh"
tar -czf "$TEST_ROOT/unpinned.tar.gz" -C "$TEST_ROOT/pkg" rdsh
for asset in "${ASSETS[@]}"; do cp "$TEST_ROOT/unpinned.tar.gz" "$RELEASE_ROOT/download/v8.8.8/$asset"; done
: >"$CURL_LOG"
RDSH_TEST_ANSWER=YES python3 "$TEST_ROOT/run-with-tty.py" "$ROOT/install.sh" "$TEST_ROOT/confirmed-bin" --version=v8.8.8 >"$TEST_ROOT/confirmed.log" 2>&1 || {
  cat "$TEST_ROOT/confirmed.log" >&2
  fail "confirmed interactive bypass failed"
}
if grep -q 'raw.githubusercontent.com' "$CURL_LOG"; then fail "explicit unpinned bypass fetched the registry"; fi
if "$TEST_ROOT/confirmed-bin/rdsh" --version | grep -q "rdsh unpinned v8.8.8"; then
  ok "confirmed interactive bypass works"
else
  fail "confirmed interactive bypass did not install the fixture"
fi

# Even with an explicit bypass, reject a second archive entry that traverses
# outside the extraction directory.
TRAVERSAL_ARCHIVE="$RELEASE_ROOT/download/v9.9.9/traversal.tar.gz"
python3 - "$TRAVERSAL_ARCHIVE" "$TEST_ROOT/pkg/rdsh" <<'PY'
import io
import sys
import tarfile

archive_path, binary_path = sys.argv[1:]
with tarfile.open(archive_path, "w:gz") as archive:
    archive.add(binary_path, arcname="rdsh")
    payload = b"must not be extracted"
    entry = tarfile.TarInfo("../escaped-from-release")
    entry.size = len(payload)
    archive.addfile(entry, io.BytesIO(payload))
PY
MUSL_SHA="$(sum_file "$TRAVERSAL_ARCHIVE")"
for asset in "${ASSETS[@]}"; do cp "$TRAVERSAL_ARCHIVE" "$RELEASE_ROOT/download/v9.9.9/$asset"; done
{
  printf '# local fixture\nlatest v9.9.9\n'
  printf 'v9.9.9 rdsh-linux-x64.tar.gz %s\n' "$MUSL_SHA"
  printf 'v9.9.9 rdsh-linux-x64-musl.tar.gz %s\n' "$MUSL_SHA"
  printf 'v9.9.9 rdsh-macos-arm64.tar.gz %s\n' "$MUSL_SHA"
  printf 'v9.9.9 rdsh-macos-x64.tar.gz %s\n' "$MUSL_SHA"
} >"$MANIFEST"
RDSH_TEST_ANSWER=YES python3 "$TEST_ROOT/run-with-tty.py" "$ROOT/install.sh" "$TEST_ROOT/traversal-bin" --musl >"$TEST_ROOT/traversal.log" 2>&1 || true
grep -q "release archive must contain only the rdsh binary" "$TEST_ROOT/traversal.log" || fail "traversal archive was not rejected"
if [ -e "$TMP_ROOT/escaped-from-release" ]; then fail "tar archive wrote outside its temp directory"; fi
ok "archive traversal entry is refused before extraction"
