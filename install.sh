#!/usr/bin/env bash
# rdsh installer: install as `rdsh`, optionally shadow `dsh` (with backup + restore).
set -euo pipefail
# Release-download scratch dir (set by fetch_release); cleaned at exit.
FETCH_TMPD=""
trap '[ -n "${FETCH_TMPD:-}" ] && rm -rf "$FETCH_TMPD"' EXIT
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
  # Explicit --musl / RDSH_MUSL=1 wins; otherwise auto-select musl on old glibc.
  if [ "${USE_MUSL:-0}" = 1 ]; then return 0; fi
  if [ "$OS/$ARCH" = "Linux/x86_64" ]; then
    gv="$(glibc_version)"
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

fetch_release() {
  # Print the path of the extracted prebuilt rdsh binary.
  # Overridable for tests: RDSH_RELEASE_BASE=file:///path/to/dir.
  base="${RDSH_RELEASE_BASE:-https://github.com/sahenjp/rustdsh/releases}"
  case "$OS/$ARCH" in
    Linux/x86_64)
      if want_musl; then asset="rdsh-linux-x64-musl.tar.gz"; else asset="rdsh-linux-x64.tar.gz"; fi
      if [ "${USE_MUSL:-0}" != 1 ]; then
        gv="$(glibc_version)"
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
  FETCH_TMPD="$(mktemp -d)"
  echo "fetching $url" >&2
  curl -fsSL -o "$FETCH_TMPD/pkg.tgz" "$url" || { echo "download failed: $url" >&2; exit 1; }
  if [ "${RDSH_NO_CHECKSUM:-0}" = 1 ]; then
    echo "checksum verification skipped (RDSH_NO_CHECKSUM=1)" >&2
  elif curl -fsSL -o "$FETCH_TMPD/pkg.tgz.sha256" "$url.sha256" 2>/dev/null; then
    verify_sha256 "$FETCH_TMPD/pkg.tgz" "$FETCH_TMPD/pkg.tgz.sha256" || exit 1
  else
    echo "no checksum sidecar: refusing release install (set RDSH_NO_CHECKSUM=1 to override)" >&2
    exit 1
  fi
  tar -xzf "$FETCH_TMPD/pkg.tgz" -C "$FETCH_TMPD"
  if [ ! -x "$FETCH_TMPD/rdsh" ]; then echo "release archive has no rdsh binary" >&2; exit 1; fi
  echo "$FETCH_TMPD/rdsh"
}
BIN_SRC="target/release/rdsh"
if [ "$FROM_RELEASE" = 1 ]; then
  BIN_SRC="$(fetch_release)"
else
  export PATH="$HOME/.cargo/bin:$PATH"
  if ! command -v cargo >/dev/null 2>&1; then
    if [ "$NO_RUSTUP" = 1 ]; then echo "cargo not found (drop --no-rustup to auto-install Rust)" >&2; exit 1; fi
    if ! command -v curl >/dev/null 2>&1; then echo "cargo not found and no curl to fetch rustup" >&2; exit 1; fi
    echo "cargo not found: installing Rust via rustup (minimal profile)..."
    curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
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
