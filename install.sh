#!/usr/bin/env bash
# rdsh installer: install as `rdsh`, optionally shadow `dsh` (with backup + restore).
# Release checklist (Issue #7, docs only):
# 1) bump version in Cargo.toml, 2) cargo build/test/regress green,
# 3) commit + push, 4) cargo publish (needs crates.io token + verified email),
# 5) refresh live install via ./install.sh --as-dsh and verify `dsh --version`
# delegation, 6) confirm sync-dsh.sh picks up the new version on its next run.
set -euo pipefail
# Installer download scratch dir; cleaned at exit.
DOWNLOAD_TMPD=""
# Update this version and the per-target hashes together from rustup's official archive.
RUSTUP_INIT_VERSION="1.29.0"
cleanup_downloads() {
  if [ -n "${DOWNLOAD_TMPD:-}" ]; then rm -rf "$DOWNLOAD_TMPD"; fi
}
trap cleanup_downloads EXIT
PREFIX="${PREFIX:-$HOME/.local/bin}"
MODE="rdsh"
NO_RUSTUP=0
FROM_RELEASE=0
VER="latest"
USE_MUSL="${RDSH_MUSL:-0}"
for a in "$@"; do
  case "$a" in
    --as-dsh) MODE="as-dsh" ;;
    --restore) MODE="restore" ;;
    --prefix=*) PREFIX="${a#--prefix=}" ;;
    --no-rustup) NO_RUSTUP=1 ;;
    --from-release) FROM_RELEASE=1 ;;
    --musl) USE_MUSL=1 ;;
    --version=*) VER="${a#--version=}" ;;
    -h|--help)
      echo "usage: ./install.sh [--as-dsh] [--restore] [--prefix=DIR] [--no-rustup] [--from-release] [--musl] [--version=VER]"
      echo "  (default)  build + install rdsh to PREFIX/rdsh (Linux, macOS, WSL)"
      echo "  --as-dsh   also install rdsh as PREFIX/dsh (backs up original to PREFIX/dsh-orig)"
      echo "  --restore  restore PREFIX/dsh from PREFIX/dsh-orig"
      echo "  --no-rustup  do not auto-install Rust when cargo is missing"
      echo "  --from-release  install a prebuilt binary from GitHub Releases (no Rust needed)"
      echo "  --musl  use the static musl build (rdsh-linux-x64-musl.tar.gz; also via RDSH_MUSL=1)"
      echo "  --version=VER  release to fetch with --from-release (default: latest)"
      echo "  native Windows: use install.ps1 instead (it can also side-install into WSL via -Wsl)"
      exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
echo "rdsh installer: $OS/$ARCH"
if grep -qi microsoft /proc/version 2>/dev/null || [ -n "${WSL_DISTRO_NAME:-}${WSL_INTEROP:-}" ]; then
  echo "WSL detected (${WSL_DISTRO_NAME:-unknown distro}): installing inside this distro."
  echo "From Windows, this install is reachable via File Explorer; for a native"
  echo "Windows install (no WSL), run install.ps1 from PowerShell instead."
fi
if [ "$MODE" = restore ]; then
  if [ ! -e "$PREFIX/dsh-orig" ]; then echo "no backup at $PREFIX/dsh-orig" >&2; exit 1; fi
  if "$PREFIX/dsh" doctor 2>&1 | grep -q 'rdsh'; then
    mv -f "$PREFIX/dsh-orig" "$PREFIX/dsh"
    echo "restored original dsh (rdsh still at $PREFIX/rdsh)"
  else
    echo "refusing: $PREFIX/dsh does not look like rdsh" >&2; exit 1
  fi
  exit 0
fi
glibc_version() {
  # Print glibc X.Y (e.g. 2.41) or empty when undetectable (musl, macOS, ...).
  v="$(ldd --version 2>/dev/null | head -n 1 | grep -oE "[0-9]+\.[0-9]+(\.[0-9]+)?" | tail -n 1)"
  if [ -z "$v" ]; then v="$(getconf GNU_LIBC_VERSION 2>/dev/null | grep -oE "[0-9]+\.[0-9]+(\.[0-9]+)?" | tail -n 1)"; fi
  printf "%s" "$v"
}
ver_lt() {
  # ver_lt A B: true when dotted version A < B.
  awk -v a="$1" -v b="$2" 'BEGIN { n=split(a,aa,"."); m=split(b,bb,"."); k=(n>m?n:m); for(i=1;i<=k;i++){x=(aa[i]==""?0:aa[i]); y=(bb[i]==""?0:bb[i]); if(x<y) exit 0; if(x>y) exit 1;} exit 1; }'
}
want_musl() {
  # Explicit --musl / RDSH_MUSL=1 wins; otherwise auto-select musl when the
  # glibc passed in $1 (computed once by fetch_release) is older than 2.34.
  if [ "${USE_MUSL:-0}" = 1 ]; then return 0; fi
  if [ "$OS/$ARCH" = "Linux/x86_64" ]; then
    gv="${1:-}"
    if [ -n "$gv" ] && ver_lt "$gv" "2.34"; then return 0; fi
  fi
  return 1
}
verify_sha256() {
  file="$1"
  sidecar="$2"
  line="$(cat "$sidecar" 2>/dev/null)"
  want="${line%% *}"
  if [ -z "$want" ]; then
    echo "empty checksum sidecar" >&2
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$file")"
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$file")"
  else
    echo "no sha256sum or shasum available" >&2
    return 1
  fi
  got="${out%% *}"
  lwant="$(printf %s "$want" | tr A-F a-f)"
  lgot="$(printf %s "$got" | tr A-F a-f)"
  if [ -n "$lgot" ] && [ "$lwant" = "$lgot" ]; then
    echo "checksum ok" >&2
    return 0
  fi
  echo "CHECKSUM MISMATCH" >&2
  return 1
}

rustup_init_target() {
  case "$OS/$ARCH" in
    Linux/x86_64)
      if [ -e /lib/ld-musl-x86_64.so.1 ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
        printf '%s' "x86_64-unknown-linux-musl"
      else
        printf '%s' "x86_64-unknown-linux-gnu"
      fi
      ;;
    Linux/aarch64)
      if [ -e /lib/ld-musl-aarch64.so.1 ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
        printf '%s' "aarch64-unknown-linux-musl"
      else
        printf '%s' "aarch64-unknown-linux-gnu"
      fi
      ;;
    Darwin/arm64) printf '%s' "aarch64-apple-darwin" ;;
    Darwin/x86_64) printf '%s' "x86_64-apple-darwin" ;;
    *)
      echo "no pinned rustup-init binary for $OS/$ARCH; install Rust manually or use --no-rustup" >&2
      return 1
      ;;
  esac
}

rustup_init_sha256() {
  case "$1" in
    x86_64-unknown-linux-gnu) printf '%s' "4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10" ;;
    aarch64-unknown-linux-gnu) printf '%s' "9732d6c5e2a098d3521fca8145d826ae0aaa067ef2385ead08e6feac88fa5792" ;;
    x86_64-unknown-linux-musl) printf '%s' "9cd3fda5fd293890e36ab271af6a786ee22084b5f6c2b83fd8323cec6f0992c1" ;;
    aarch64-unknown-linux-musl) printf '%s' "88761caacddb92cd79b0b1f939f3990ba1997d701a38b3e8dd6746a562f2a759" ;;
    x86_64-apple-darwin) printf '%s' "33cf85df9142bc6d29cbc62fa5ca1d4c29622cddb55213a4c1a43c457fb9b2d7" ;;
    aarch64-apple-darwin) printf '%s' "aeb4105778ca1bd3c6b0e75768f581c656633cd51368fa61289b6a71696ac7e1" ;;
    *) return 1 ;;
  esac
}

sha256_file() {
  local file="$1" out
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$file")"
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$file")"
  else
    echo "no sha256sum or shasum available" >&2
    return 1
  fi
  printf '%s' "${out%% *}" | tr 'A-F' 'a-f'
}

verify_pinned_sha256() {
  local file="$1" expected="$2" actual
  actual="$(sha256_file "$file")" || return 1
  if [ "$actual" = "$expected" ]; then
    echo "rustup-init checksum ok" >&2
    return 0
  fi
  echo "rustup-init SHA-256 mismatch (expected $expected, got $actual)" >&2
  return 1
}

install_pinned_rustup() {
  local target expected url binary
  target="$(rustup_init_target)" || return 1
  expected="$(rustup_init_sha256 "$target")" || {
    echo "no pinned rustup-init checksum for $target" >&2
    return 1
  }
  url="https://static.rust-lang.org/rustup/archive/${RUSTUP_INIT_VERSION}/${target}/rustup-init"
  DOWNLOAD_TMPD="$(mktemp -d)"
  binary="$DOWNLOAD_TMPD/rustup-init"
  echo "downloading pinned rustup-init $RUSTUP_INIT_VERSION for $target..." >&2
  curl --proto "=https" --proto-redir "=https" --tlsv1.2 --fail --silent --show-error --location --output "$binary" "$url" || {
    echo "rustup-init download failed: $url" >&2
    return 1
  }
  verify_pinned_sha256 "$binary" "$expected" || return 1
  chmod 700 "$binary"
  "$binary" -y --profile minimal --default-toolchain stable
}

fetch_release() {
  # Print the path of the extracted prebuilt rdsh binary.
  # Overridable for tests: RDSH_RELEASE_BASE=file:///path/to/dir.
  base="${RDSH_RELEASE_BASE:-https://github.com/jimoto-no-llm/rustdsh/releases}"
  if [ -n "${RDSH_RELEASE_BASE:-}" ]; then
    echo "warning: custom release base in use (RDSH_RELEASE_BASE=$base); checksum verification stays mandatory" >&2
  fi
  case "$OS/$ARCH" in
    Linux/x86_64)
      gv="$(glibc_version)"
      if want_musl "$gv"; then asset="rdsh-linux-x64-musl.tar.gz"; else asset="rdsh-linux-x64.tar.gz"; fi
      if [ "${USE_MUSL:-0}" != 1 ]; then
        if [ -n "$gv" ] && ver_lt "$gv" "2.34"; then echo "glibc $gv < 2.34: selecting static musl build" >&2; fi
      else
        echo "selecting static musl build (--musl / RDSH_MUSL=1)" >&2
      fi
      ;;
    Darwin/arm64) asset="rdsh-macos-arm64.tar.gz" ;;
    Darwin/x86_64) asset="rdsh-macos-x64.tar.gz" ;;
    *) echo "no prebuilt binary for $OS/$ARCH (build from source instead)" >&2; exit 1 ;;
  esac
  if [ "$VER" = "latest" ]; then url="$base/latest/download/$asset"; else url="$base/download/$VER/$asset"; fi
  DOWNLOAD_TMPD="$(mktemp -d)"
  echo "fetching $url" >&2
  curl -fsSL -o "$DOWNLOAD_TMPD/pkg.tgz" "$url" || { echo "download failed: $url" >&2; exit 1; }
  if [ "${RDSH_NO_CHECKSUM:-0}" = 1 ]; then
    echo "WARNING: checksum verification skipped (RDSH_NO_CHECKSUM=1); only use this with a trusted release base" >&2
  elif curl -fsSL -o "$DOWNLOAD_TMPD/pkg.tgz.sha256" "$url.sha256" 2>/dev/null; then
    verify_sha256 "$DOWNLOAD_TMPD/pkg.tgz" "$DOWNLOAD_TMPD/pkg.tgz.sha256" || exit 1
  else
    echo "no checksum sidecar: refusing release install (set RDSH_NO_CHECKSUM=1 to override)" >&2
    exit 1
  fi
  tar -xzf "$DOWNLOAD_TMPD/pkg.tgz" -C "$DOWNLOAD_TMPD"
  if [ ! -x "$DOWNLOAD_TMPD/rdsh" ]; then echo "release archive has no rdsh binary" >&2; exit 1; fi
  echo "$DOWNLOAD_TMPD/rdsh"
}
BIN_SRC="target/release/rdsh"
if [ "$FROM_RELEASE" = 1 ]; then
  BIN_SRC="$(fetch_release)"
else
  export PATH="$HOME/.cargo/bin:$PATH"
  if ! command -v cargo >/dev/null 2>&1; then
    if [ "$NO_RUSTUP" = 1 ]; then echo "cargo not found (drop --no-rustup to auto-install Rust)" >&2; exit 1; fi
    if ! command -v curl >/dev/null 2>&1; then echo "cargo not found and no curl to fetch rustup" >&2; exit 1; fi
    echo "cargo not found: installing Rust via pinned rustup-init (minimal profile)..."
    install_pinned_rustup
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
  cargo build --release
fi
mkdir -p "$PREFIX" "$HOME/.config/rdsh"
install -m755 "$BIN_SRC" "$PREFIX/rdsh"
echo "installed $PREFIX/rdsh"
if [ "$MODE" = as-dsh ]; then
  if [ -e "$PREFIX/dsh-orig" ]; then echo "backup exists: $PREFIX/dsh-orig (use --restore first)" >&2; exit 1; fi
  if [ -e "$PREFIX/dsh" ]; then
    if "$PREFIX/dsh" doctor 2>&1 | grep -q 'rdsh'; then
      echo "PREFIX/dsh is already rdsh; refreshing"
    else
      mv "$PREFIX/dsh" "$PREFIX/dsh-orig"
      echo "$PREFIX/dsh-orig" > "$HOME/.config/rdsh/origin"
      echo "backed up original dsh -> $PREFIX/dsh-orig"
    fi
  else
    echo "no existing dsh in PREFIX; PATH lookup only"
  fi
  tmp="$PREFIX/.dsh.new.$$"
  install -m755 "$PREFIX/rdsh" "$tmp" && mv -f "$tmp" "$PREFIX/dsh"
  echo "installed rdsh as $PREFIX/dsh (atomic replace; revert: ./install.sh --restore)"
  if grep -l "node" "$PREFIX"/* 2>/dev/null | xargs grep -l "dsh" 2>/dev/null | grep -q .; then
    echo "note: wrappers calling 'node ...dsh...' break while dsh is shadowed (native binary, not JS)."
    echo "note: exec dsh/rdsh directly instead of via node; 'rdsh doctor' lists the offenders."
  fi
fi
echo "--- rdsh doctor ---"
"$PREFIX/rdsh" doctor 2>&1 | head -n 12 || true
echo "next: run '$PREFIX/rdsh setup' to connect a model (GPT subscription via OAuth needs no API key)"
if [ -f "./plugins/install.sh" ]; then
  echo "next: PROFILE=web ./plugins/install.sh adds recommended plugins, including the rdsh settings UI"
fi
