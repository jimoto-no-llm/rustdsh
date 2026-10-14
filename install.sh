#!/usr/bin/env bash
# rdsh installer: install as `rdsh`, optionally shadow `dsh` (with backup + restore).
# Release checklist (Issue #7, docs only):
# 1) bump version in Cargo.toml, 2) cargo build/test/regress green,
# 3) commit + push, 4) cargo publish (needs crates.io token + verified email),
# 5) refresh live install via ./install.sh --as-dsh and verify `dsh --version`
# delegation, 6) confirm sync-dsh.sh picks up the new version on its next run.
set -euo pipefail
# Installer download scratch dirs; all cleaned at exit.
DOWNLOAD_TMPD=""
# Downloads also run inside command substitutions, whose variable changes never
# reach this shell, so the dirs are listed in a file the EXIT trap can read.
DOWNLOAD_LIST=""
# Update this version and the per-target hashes together from rustup's official archive.
RUSTUP_INIT_VERSION="1.29.0"
cleanup_downloads() {
  if [ -n "$DOWNLOAD_LIST" ] && [ -f "$DOWNLOAD_LIST" ]; then
    while IFS= read -r d; do
      [ -n "$d" ] && rm -rf "$d"
    done < "$DOWNLOAD_LIST"
    rm -f "$DOWNLOAD_LIST"
  fi
}
new_download_tmpd() {
  DOWNLOAD_TMPD="$(mktemp -d)"
  printf '%s\n' "$DOWNLOAD_TMPD" >> "$DOWNLOAD_LIST"
}
DOWNLOAD_LIST="$(mktemp "${TMPDIR:-/tmp}/rdsh-download-list.XXXXXX")"
trap cleanup_downloads EXIT
PREFIX="${PREFIX:-$HOME/.local/bin}"
MODE="rdsh"
NO_RUSTUP=0
FROM_RELEASE=0
# Never make the digest registry follow RDSH_RELEASE_BASE or another environment value.
RELEASE_DIGESTS_URL="https://raw.githubusercontent.com/jimoto-no-llm/rustdsh/main/release-digests.tsv"
VER="latest"
USE_MUSL="${RDSH_MUSL:-0}"
DESKTOP=0
for a in "$@"; do
  case "$a" in
    --as-dsh) MODE="as-dsh" ;;
    --restore) MODE="restore" ;;
    --prefix=*) PREFIX="${a#--prefix=}" ;;
    --no-rustup) NO_RUSTUP=1 ;;
    --from-release) FROM_RELEASE=1 ;;
    --musl) USE_MUSL=1 ;;
    --desktop) DESKTOP=1 ;;
    --version=*) VER="${a#--version=}" ;;
    -h|--help)
      echo "usage: ./install.sh [--as-dsh] [--restore] [--prefix=DIR] [--no-rustup] [--from-release] [--musl] [--desktop] [--version=VER]"
      echo "  (default)  build + install rdsh to PREFIX/rdsh (Linux, macOS, WSL)"
      echo "  --as-dsh   also install rdsh as PREFIX/dsh (backs up original to PREFIX/dsh-orig)"
      echo "  --restore  restore PREFIX/dsh from PREFIX/dsh-orig"
      echo "  --no-rustup  do not auto-install Rust when cargo is missing"
      echo "  --from-release  install a prebuilt binary from GitHub Releases (no Rust needed)"
      echo "  --musl  use the static musl build (rdsh-linux-x64-musl.tar.gz; also via RDSH_MUSL=1)"
      echo "  --desktop  also attach the bundled plugins to the DeepSeek Harness Desktop profile"
      echo "  --version=VER  release to fetch with --from-release (default: latest, resolved from repository pins)"
      echo "  RDSH_NO_CHECKSUM=1  skip SHA-256 verification only after typing YES at a terminal"
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
is_musl_host() {
  # Musl-based Linux (Alpine, ...) cannot run the glibc build at all.
  if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then
    return 0
  fi
  if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    return 0
  fi
  return 1
}
# The published glibc build is produced on ubuntu-latest (glibc 2.39 today).
# Older hosts use the static musl build. This floor is only a hint:
# install_release_binary also runs the downloaded binary and falls back to
# musl when the glibc build cannot start, so a newer floor stays safe.
RELEASE_GLIBC_FLOOR="2.39"
want_musl() {
  # Explicit --musl / RDSH_MUSL=1 wins; $1 is the detected glibc version.
  if [ "${USE_MUSL:-0}" = 1 ]; then return 0; fi
  if [ "$OS/$ARCH" != "Linux/x86_64" ]; then return 1; fi
  if is_musl_host; then return 0; fi
  gv="${1:-}"
  if [ -n "$gv" ] && ver_lt "$gv" "$RELEASE_GLIBC_FLOOR"; then return 0; fi
  return 1
}
verify_sha256() {
  file="$1"
  want="$2"
  case "$want" in
    ''|*[!0123456789abcdefABCDEF]*) echo "invalid pinned SHA-256" >&2; return 1 ;;
  esac
  if [ "${#want}" -ne 64 ]; then echo "invalid pinned SHA-256 length" >&2; return 1; fi
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
  new_download_tmpd
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
release_version() {
  case "$1" in
    v*) printf '%s' "$1" ;;
    *) printf 'v%s' "$1" ;;
  esac
}

validate_release_digest_manifest() {
  awk '
    BEGIN { FS = "[ \t]+"; bad = 0; latest_count = 0 }
    /^[ \t]*#/ || NF == 0 { next }
    function valid_version(v) { return v ~ /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/ }
    function valid_asset(a) {
      return a == "rdsh-linux-x64.tar.gz" || a == "rdsh-linux-x64-musl.tar.gz" ||
        a == "rdsh-macos-arm64.tar.gz" || a == "rdsh-macos-x64.tar.gz"
    }
    $1 == "latest" {
      if (NF != 2 || !valid_version($2) || $2 ~ /-/ || latest_count++) bad = 1
      latest = $2
      next
    }
    {
      if (NF != 3 || !valid_version($1) || !valid_asset($2) || length($3) != 64 || $3 ~ /[^0-9a-fA-F]/) {
        bad = 1
        next
      }
      key = $1 SUBSEP $2
      if (seen[key]++) bad = 1
      versions[$1] = 1
      if ($1 == latest) latest_assets++
    }
    END {
      if (bad || latest_count != 1 || !versions[latest] || latest_assets != 4) exit 1
    }
  ' "$1"
}

latest_release_version() {
  awk '$1 == "latest" { print $2 }' "$1"
}

expected_release_sha256() {
  awk -v wanted_version="$2" -v wanted_asset="$3" '
    $1 == wanted_version && $2 == wanted_asset { print $3; matches++ }
    END { if (matches != 1) exit 1 }
  ' "$1"
}

confirm_checksum_bypass() {
  version="$1"
  asset="$2"
  answer=""
  if ! printf 'RDSH_NO_CHECKSUM=1 skips SHA-256 verification for %s/%s. Type YES to continue: ' "$version" "$asset" >/dev/tty 2>/dev/null; then
    echo "RDSH_NO_CHECKSUM=1 requires a terminal for confirmation; refusing" >&2
    return 1
  fi
  if ! IFS= read -r answer </dev/tty; then
    echo "could not read checksum-bypass confirmation; refusing" >&2
    return 1
  fi
  if [ "$answer" != "YES" ]; then
    echo "checksum bypass not confirmed; refusing" >&2
    return 1
  fi
  echo "checksum bypass confirmed interactively" >&2
}

extract_release_archive() {
  archive="$1"
  destination="$2"
  entries="$(tar -tzf "$archive")" || { echo "could not list release archive" >&2; return 1; }
  if [ "$entries" != "rdsh" ]; then
    echo "release archive must contain only the rdsh binary" >&2
    return 1
  fi
  # Both GNU tar and bsdtar reject traversal by default; keep that default by
  # never passing their unsafe absolute-path option, and extract only rdsh.
  tar -xzf "$archive" -C "$destination" --no-same-owner --no-same-permissions rdsh
}

fetch_release_digests() {
  # $1: destination. Normally the fixed canonical registry. A file:// release
  # base -- which only the tests use -- may instead point RDSH_RELEASE_DIGESTS
  # at a local copy so the offline installer tests never need the network.
  # A remote base never consults it: the release origin must not choose the
  # digests that verify its own artifact.
  local dest="$1" source="${RDSH_RELEASE_DIGESTS:-}"
  if [ -n "$source" ]; then
    case "${RDSH_RELEASE_BASE:-}" in
      file://*) ;;
      *) echo "warning: ignoring RDSH_RELEASE_DIGESTS (needs a file:// RDSH_RELEASE_BASE)" >&2; source="" ;;
    esac
  fi
  case "$source" in
    "") ;;
    /*) ;;
    *) echo "warning: ignoring RDSH_RELEASE_DIGESTS=$source (needs an absolute path)" >&2; source="" ;;
  esac
  if [ -n "$source" ]; then
    if [ ! -f "$source" ]; then echo "no local digest registry at $source" >&2; return 1; fi
    echo "warning: using local digest registry $source (file:// release base)" >&2
    cp "$source" "$dest"
    return
  fi
  curl --proto '=https' --tlsv1.2 -fsSL -o "$dest" "$RELEASE_DIGESTS_URL"
}

choose_release_asset() {
  # Print the release asset for this host; the reason goes to stderr.
  case "$OS/$ARCH" in
    Linux/x86_64)
      gv="$(glibc_version)"
      if want_musl "$gv"; then
        if [ "${USE_MUSL:-0}" = 1 ]; then
          echo "selecting static musl build (--musl / RDSH_MUSL=1)" >&2
        elif is_musl_host; then
          echo "musl host detected: selecting static musl build" >&2
        else
          echo "glibc $gv < $RELEASE_GLIBC_FLOOR: selecting static musl build" >&2
        fi
        printf '%s' "rdsh-linux-x64-musl.tar.gz"
      else
        printf '%s' "rdsh-linux-x64.tar.gz"
      fi
      ;;
    Darwin/arm64) printf '%s' "rdsh-macos-arm64.tar.gz" ;;
    Darwin/x86_64) printf '%s' "rdsh-macos-x64.tar.gz" ;;
    *) echo "no prebuilt binary for $OS/$ARCH (build from source instead)" >&2; return 1 ;;
  esac
}
verify_installed_binary() {
  # $1: candidate binary; print its output when it cannot run.
  local out=""
  if out="$("$1" --version 2>&1)"; then
    case "$out" in *rdsh*) return 0 ;; esac
  fi
  printf '%s\n' "$out" >&2
  return 1
}
install_release_binary() {
  # Print a release binary that provably runs on this host, or exit non-zero.
  # Never installs a binary that failed to start: the glibc build falls back
  # to the static musl build when the host glibc is too old.
  local asset candidate
  asset="$(choose_release_asset)" || exit 1
  [ -n "$asset" ] || { echo "no prebuilt binary for $OS/$ARCH (build from source instead)" >&2; exit 1; }
  # fetch_release runs in a command substitution, where a refusal that only
  # exits its subshell would leave an empty candidate and turn into a retry.
  candidate="$(fetch_release "$asset")" || exit 1
  if verify_installed_binary "$candidate"; then
    echo "$candidate"
    return 0
  fi
  if [ "$asset" = "rdsh-linux-x64-musl.tar.gz" ]; then
    echo "error: the downloaded $asset cannot run on this host (see above)" >&2
    exit 1
  fi
  echo "warning: $asset cannot run on this host; retrying with the static musl build" >&2
  candidate="$(fetch_release "rdsh-linux-x64-musl.tar.gz")" || exit 1
  if verify_installed_binary "$candidate"; then
    echo "$candidate"
    return 0
  fi
  echo "error: neither the glibc nor the static musl rdsh build runs on this host" >&2
  exit 1
}
fetch_release() {
  # $1: asset name. Print the path of the extracted prebuilt rdsh binary.
  # Overridable for tests: RDSH_RELEASE_BASE=file:///path/to/dir.
  local asset="$1"
  base="${RDSH_RELEASE_BASE:-https://github.com/jimoto-no-llm/rustdsh/releases}"
  if [ -n "${RDSH_RELEASE_BASE:-}" ]; then
    echo "warning: custom RDSH_RELEASE_BASE in use; the trusted digest registry remains canonical" >&2
  fi
  new_download_tmpd
  expected=""
  if [ "$VER" = "latest" ] || [ "${RDSH_NO_CHECKSUM:-0}" != 1 ]; then
    manifest="$DOWNLOAD_TMPD/release-digests.tsv"
    fetch_release_digests "$manifest" || {
      echo "could not fetch the trusted release digest registry; refusing release install" >&2
      exit 1
    }
    validate_release_digest_manifest "$manifest" || {
      echo "trusted release digest registry is invalid; refusing release install" >&2
      exit 1
    }
  fi
  if [ "$VER" = "latest" ]; then
    version="$(latest_release_version "$manifest")"
  else
    version="$(release_version "$VER")"
  fi
  # Reject anything outside the version alphabet first. The anchored match below
  # is applied line by line, so on its own it accepts a value such as
  # $'v0.3.2\n../../x' by matching its first line; the version must be one value
  # because it is interpolated into the download URL.
  case "$version" in
    "" | *[!0-9A-Za-z.-]*)
      echo "invalid release version: $version" >&2
      exit 1
      ;;
  esac
  if ! printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'; then
    echo "invalid release version: $version" >&2
    exit 1
  fi
  if [ -n "${manifest:-}" ]; then
    if ! expected="$(expected_release_sha256 "$manifest" "$version" "$asset")"; then
      if [ "${RDSH_NO_CHECKSUM:-0}" != 1 ]; then
        echo "no pinned checksum for release $version asset $asset; refusing release install" >&2
        exit 1
      fi
    fi
  fi
  url="$base/download/$version/$asset"
  echo "fetching release asset $version/$asset" >&2
  if [ "${RDSH_NO_CHECKSUM:-0}" = 1 ]; then confirm_checksum_bypass "$version" "$asset" || exit 1; fi
  curl -fsSL -o "$DOWNLOAD_TMPD/pkg.tgz" "$url" || { echo "download failed for release asset $version/$asset" >&2; exit 1; }
  if [ "${RDSH_NO_CHECKSUM:-0}" != 1 ]; then
    verify_sha256 "$DOWNLOAD_TMPD/pkg.tgz" "$expected" || exit 1
  fi
  extract_release_archive "$DOWNLOAD_TMPD/pkg.tgz" "$DOWNLOAD_TMPD" || exit 1
  if [ ! -f "$DOWNLOAD_TMPD/rdsh" ] || [ -L "$DOWNLOAD_TMPD/rdsh" ] || [ ! -x "$DOWNLOAD_TMPD/rdsh" ]; then
    echo "release archive has no regular executable rdsh binary" >&2
    exit 1
  fi
  echo "$DOWNLOAD_TMPD/rdsh"
}
BIN_SRC="target/release/rdsh"
if [ "$FROM_RELEASE" = 1 ]; then
  BIN_SRC="$(install_release_binary)"
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
  echo "next: PROFILE=web ./plugins/install.sh adds recommended plugins, including the rdsh settings UI and the phone-width Web layout"
fi
# Desktop (Electron) keeps its own reserved profile next to the CLI profiles.
# Detection is read-only and never fails the install.
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
desktop_status="$("$PREFIX/rdsh" desktop status 2>/dev/null || true)"
if printf '%s' "$desktop_status" | grep -q "desktop profile: .*(initialized)"; then
  if [ "$DESKTOP" = 1 ]; then
    echo "--- DeepSeek Harness Desktop ---"
    if "$PREFIX/rdsh" desktop install --plugins-dir "$REPO_ROOT/plugins" --compute; then
      echo "note: quit and reopen DeepSeek Harness to load the plugins"
    else
      echo "note: Desktop plugin attach failed; rerun 'rdsh desktop status' for the next step" >&2
    fi
  else
    echo "next: rdsh desktop install --plugins-dir . attaches the rdsh plugins to the Desktop app"
  fi
fi
