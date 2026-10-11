#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
FAKE_BIN="$TMPD/fake-bin"
mkdir -p "$FAKE_BIN"

RUSTUP_INIT_VERSION="1.29.0"
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    if [ -e /lib/ld-musl-x86_64.so.1 ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
      RUSTUP_INIT_TARGET="x86_64-unknown-linux-musl"
      RUSTUP_INIT_SHA256="9cd3fda5fd293890e36ab271af6a786ee22084b5f6c2b83fd8323cec6f0992c1"
    else
      RUSTUP_INIT_TARGET="x86_64-unknown-linux-gnu"
      RUSTUP_INIT_SHA256="4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10"
    fi
    ;;
  Linux/aarch64)
    if [ -e /lib/ld-musl-aarch64.so.1 ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
      RUSTUP_INIT_TARGET="aarch64-unknown-linux-musl"
      RUSTUP_INIT_SHA256="88761caacddb92cd79b0b1f939f3990ba1997d701a38b3e8dd6746a562f2a759"
    else
      RUSTUP_INIT_TARGET="aarch64-unknown-linux-gnu"
      RUSTUP_INIT_SHA256="9732d6c5e2a098d3521fca8145d826ae0aaa067ef2385ead08e6feac88fa5792"
    fi
    ;;
  Darwin/arm64)
    RUSTUP_INIT_TARGET="aarch64-apple-darwin"
    RUSTUP_INIT_SHA256="aeb4105778ca1bd3c6b0e75768f581c656633cd51368fa61289b6a71696ac7e1"
    ;;
  Darwin/x86_64)
    RUSTUP_INIT_TARGET="x86_64-apple-darwin"
    RUSTUP_INIT_SHA256="33cf85df9142bc6d29cbc62fa5ca1d4c29622cddb55213a4c1a43c457fb9b2d7"
    ;;
  *)
    echo "unsupported host for rustup-init pin test: $(uname -s)/$(uname -m)" >&2
    exit 1
    ;;
esac

RUSTUP_INIT_URL="https://static.rust-lang.org/rustup/archive/${RUSTUP_INIT_VERSION}/${RUSTUP_INIT_TARGET}/rustup-init"

cat > "$FAKE_BIN/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) output="$2"; shift 2 ;;
    *)
      case "$1" in https://*|http://*) url="$1" ;; esac
      shift
      ;;
  esac
done
if [ "$url" != "$RDSH_TEST_URL" ] || [ -z "$output" ]; then
  echo "unexpected rustup-init request: $url" >&2
  exit 91
fi
printf '%s\n' "$url" > "$HOME/rustup-url"
cat > "$output" <<'RUSTUP'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$HOME/rustup-args"
mkdir -p "$HOME/.cargo/bin"
cat > "$HOME/.cargo/bin/cargo" <<'CARGO'
#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 2 ] || [ "$1" != build ] || [ "$2" != --release ]; then exit 92; fi
mkdir -p target/release
cat > target/release/rdsh <<'RDSH'
#!/usr/bin/env bash
if [ "${1:-}" = doctor ]; then echo 'stub rdsh doctor'; fi
RDSH
chmod +x target/release/rdsh
CARGO
chmod +x "$HOME/.cargo/bin/cargo"
RUSTUP
CURL

cat > "$FAKE_BIN/sha256sum" <<'SHA256SUM'
#!/usr/bin/env bash
set -euo pipefail
if [ "${RDSH_TEST_CHECKSUM_MODE:-valid}" = mismatch ]; then
  printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "$1"
else
  printf '%s  %s\n' "$RDSH_TEST_SHA256" "$1"
fi
SHA256SUM
chmod +x "$FAKE_BIN/curl" "$FAKE_BIN/sha256sum"

run_installer() {
  local label="$1" mode="$2" home prefix work
  work="$TMPD/$label"
  home="$work/home"
  prefix="$work/prefix"
  mkdir -p "$home" "$prefix" "$work/project"
  (
    cd "$work/project"
    export HOME="$home" PREFIX="$prefix"
    export PATH="$FAKE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"
    export RDSH_TEST_URL="$RUSTUP_INIT_URL" RDSH_TEST_SHA256="$RUSTUP_INIT_SHA256"
    export RDSH_TEST_CHECKSUM_MODE="$mode"
    bash "$REPO_ROOT/install.sh"
  ) > "$work/install.log" 2>&1
}

if ! run_installer valid valid; then
  cat "$TMPD/valid/install.log" >&2
  echo "pinned rustup-init fixture did not install" >&2
  exit 1
fi
if [ "$(cat "$TMPD/valid/home/rustup-url")" != "$RUSTUP_INIT_URL" ]; then
  echo "installer did not request the versioned rustup-init URL" >&2
  exit 1
fi
if [ "$(cat "$TMPD/valid/home/rustup-args")" != "-y --profile minimal --default-toolchain stable" ]; then
  echo "installer changed rustup-init arguments" >&2
  exit 1
fi
if [ ! -x "$TMPD/valid/prefix/rdsh" ] || ! grep -q 'rustup-init checksum ok' "$TMPD/valid/install.log"; then
  echo "valid pinned checksum did not reach the build/install steps" >&2
  exit 1
fi

if run_installer mismatch mismatch; then
  echo "installer accepted a rustup-init checksum mismatch" >&2
  exit 1
fi
if [ -e "$TMPD/mismatch/home/rustup-args" ] || [ -e "$TMPD/mismatch/prefix/rdsh" ]; then
  echo "installer executed or installed a rustup-init binary after a checksum mismatch" >&2
  exit 1
fi
if ! grep -q 'rustup-init SHA-256 mismatch' "$TMPD/mismatch/install.log"; then
  cat "$TMPD/mismatch/install.log" >&2
  echo "checksum mismatch was not reported" >&2
  exit 1
fi

echo "PASS: pinned rustup-init URL, arguments, checksum, and fail-closed behavior"
