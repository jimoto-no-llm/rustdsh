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
SHADOW_TEMP=""
SHADOW_RECEIPT_TEMP=""
SHADOW_BACKUP_PENDING=0
SHADOW_RECEIPT_PENDING=0
# Update this version and the per-target hashes together from rustup's official archive.
RUSTUP_INIT_VERSION="1.29.0"
cleanup_downloads() {
  if [ "$SHADOW_BACKUP_PENDING" = 1 ]; then
    if [ ! -e "$PREFIX/dsh" ] && [ ! -L "$PREFIX/dsh" ]; then
      mv -f "$PREFIX/dsh-orig" "$PREFIX/dsh" || echo "original dsh remains at $PREFIX/dsh-orig" >&2
    fi
  fi
  if [ "$SHADOW_RECEIPT_PENDING" = 1 ]; then rm -f "$SHADOW_RECEIPT"; fi
  if [ -n "$SHADOW_TEMP" ]; then rm -f "$SHADOW_TEMP"; fi
  if [ -n "$SHADOW_RECEIPT_TEMP" ]; then rm -f "$SHADOW_RECEIPT_TEMP"; fi
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
      echo "  --desktop  also attach the bundled + default third-party (sound, gitview) plugins to the Desktop profile"
      echo "  --version=VER  release to fetch with --from-release (default: latest, resolved from repository pins)"
      echo "  RDSH_NO_CHECKSUM=1  skip SHA-256 verification only after typing YES at a terminal"
      echo "  native Windows: use install.ps1 instead (it can also side-install into WSL via -Wsl)"
      exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done
SHADOW_RECEIPT="$PREFIX/.rdsh-dsh-shadow"
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
echo "rdsh installer: $OS/$ARCH"
if grep -qi microsoft /proc/version 2>/dev/null || [ -n "${WSL_DISTRO_NAME:-}${WSL_INTEROP:-}" ]; then
  echo "WSL detected (${WSL_DISTRO_NAME:-unknown distro}): installing inside this distro."
  echo "From Windows, this install is reachable via File Explorer; for a native"
  echo "Windows install (no WSL), run install.ps1 from PowerShell instead."
fi
sha256_file() {
  local file="$1" out
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$file")" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$file")" || return 1
  else
    echo "no sha256sum or shasum available" >&2
    return 1
  fi
  printf '%s' "${out%% *}" | tr 'A-F' 'a-f'
}
shadow_matches_anchor() {
  local installed_sha shadow_sha installed_version
  [ -f "$PREFIX/rdsh" ] && [ -x "$PREFIX/rdsh" ] && [ ! -L "$PREFIX/rdsh" ] \
    && [ -f "$PREFIX/dsh" ] && [ -x "$PREFIX/dsh" ] && [ ! -L "$PREFIX/dsh" ] || return 1
  installed_sha="$(sha256_file "$PREFIX/rdsh")" || return 1
  shadow_sha="$(sha256_file "$PREFIX/dsh")" || return 1
  [ -n "$installed_sha" ] && [ "$installed_sha" = "$shadow_sha" ] || return 1
  installed_version="$("$PREFIX/rdsh" --version 2>/dev/null)" || return 1
  case "$installed_version" in rdsh*) return 0 ;; *) return 1 ;; esac
}
write_shadow_receipt() {
  local shadow_sha backup_sha
  shadow_sha="$(sha256_file "$1")" || return 1
  backup_sha="$(sha256_file "$2")" || return 1
  [[ "$shadow_sha" =~ ^[0-9a-f]{64}$ && "$backup_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  SHADOW_RECEIPT_TEMP="$(mktemp "$PREFIX/.rdsh-shadow.new.XXXXXX")" || return 1
  printf 'rdsh-shadow-v1 %s %s\n' "$shadow_sha" "$backup_sha" > "$SHADOW_RECEIPT_TEMP" || return 1
  mv -f "$SHADOW_RECEIPT_TEMP" "$SHADOW_RECEIPT" || return 1
  SHADOW_RECEIPT_TEMP=""
}
shadow_matches_receipt() {
  local line extra receipt_size recorded_shadow recorded_backup shadow_sha backup_sha
  [ -f "$SHADOW_RECEIPT" ] && [ ! -L "$SHADOW_RECEIPT" ] \
    && [ -f "$PREFIX/dsh" ] && [ -x "$PREFIX/dsh" ] && [ ! -L "$PREFIX/dsh" ] \
    && [ -f "$PREFIX/dsh-orig" ] || return 1
  # Count a bounded raw snapshot before Bash read can discard any NUL bytes.
  # The canonical ASCII record, including its final LF, is exactly 145 bytes.
  SHADOW_RECEIPT_TEMP="$(mktemp "${TMPDIR:-/tmp}/rdsh-shadow-read.XXXXXX")" || return 1
  head -c 161 "$SHADOW_RECEIPT" > "$SHADOW_RECEIPT_TEMP" || return 1
  receipt_size="$(wc -c < "$SHADOW_RECEIPT_TEMP")" || return 1
  [ "$receipt_size" -eq 145 ] || return 1
  {
    LC_ALL=C IFS= read -r -n 160 line || return 1
    if LC_ALL=C IFS= read -r -n 1 extra; then return 1; fi
  } < "$SHADOW_RECEIPT_TEMP"
  [[ "$line" =~ ^rdsh-shadow-v1\ ([0-9a-f]{64})\ ([0-9a-f]{64})$ ]] || return 1
  recorded_shadow="${BASH_REMATCH[1]}"
  recorded_backup="${BASH_REMATCH[2]}"
  shadow_sha="$(sha256_file "$PREFIX/dsh")" || return 1
  backup_sha="$(sha256_file "$PREFIX/dsh-orig")" || return 1
  [ "$shadow_sha" = "$recorded_shadow" ] && [ "$backup_sha" = "$recorded_backup" ]
}
if [ "$MODE" = restore ]; then
  if [ ! -f "$PREFIX/dsh-orig" ]; then echo "no backup at $PREFIX/dsh-orig" >&2; exit 1; fi
  # A receipt binds the owned shadow and its original backup independently of
  # later standalone rdsh updates. Invalid receipts never use the legacy fallback.
  if [ -e "$SHADOW_RECEIPT" ] || [ -L "$SHADOW_RECEIPT" ]; then
    shadow_matches_receipt || { echo "refusing: dsh shadow receipt does not match" >&2; exit 1; }
  else
    shadow_matches_anchor || { echo "refusing: $PREFIX/dsh does not match the installed rdsh" >&2; exit 1; }
  fi
  mv -f "$PREFIX/dsh-orig" "$PREFIX/dsh"
  rm -f "$SHADOW_RECEIPT"
  echo "restored original dsh (rdsh still at $PREFIX/rdsh)"
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
    echo "next: check the network or proxy, then re-run this installer" >&2
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
      echo "next: check the network or proxy, then re-run this installer" >&2
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
  # Pin TLS like the rustup fetch below; a future sigstore/cosign check
  # belongs here (same-channel SHA256 alone cannot survive a mirror breach).
  # The documented explicit file:// fixture/mirror override is local-only.
  # Network downloads and redirects remain restricted to HTTPS.
  download_protocol='=https'
  case "$base" in file://*) download_protocol='=file' ;; esac
  curl --proto "$download_protocol" --proto-redir '=https' --tlsv1.2 -fsSL -o "$DOWNLOAD_TMPD/pkg.tgz" "$url" || {
    echo "download failed for release asset $version/$asset" >&2
    echo "next: check the network or proxy, then re-run this installer" >&2
    exit 1
  }
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
# ------------------------------------------------------------------ host checks
# Everything below is read-only and runs before the first download or build.
# The installer never guesses a package name: it prints this host's own command
# when it can name one, and only a missing tool this path cannot finish without
# becomes a hard error.
os_release_id() {
  [ -r /etc/os-release ] || return 0
  sed -n 's/^ID=//p' /etc/os-release | head -n 1 | tr -d '"' | tr 'A-Z' 'a-z'
}
# The rpm families below are shared with src/distro.rs, whose test asserts this
# exact quoted-ID spelling so install.sh and `rdsh doctor` cannot drift apart.
is_rpm_family() {
  [ -r /etc/os-release ] || return 1
  grep -qE '^ID="?(fedora|rhel|centos|rocky|almalinux|ol)"?$' /etc/os-release
}
package_install_command() {
  # $@: package names. Print this host's install command, or nothing when the
  # distribution is unknown (the caller then prints no "next:" line at all).
  local id
  id="$(os_release_id)"
  case "$id" in
    fedora|rhel|centos|rocky|almalinux|ol) printf 'sudo dnf install -y %s' "$*" ;;
    ubuntu|debian|linuxmint|pop|raspbian|zorin) printf 'sudo apt-get install -y %s' "$*" ;;
    alpine) printf 'sudo apk add %s' "$*" ;;
    arch|manjaro|endeavouros) printf 'sudo pacman -S --needed %s' "$*" ;;
    opensuse*|sles) printf 'sudo zypper install -y %s' "$*" ;;
  esac
}
prefix_writable() {
  # mkdir -p creates the missing part, so walk up to the nearest directory that
  # already exists and test that one.
  local dir="$PREFIX"
  while [ ! -e "$dir" ] && [ "$dir" != "/" ]; do dir="$(dirname "$dir")"; done
  [ -d "$dir" ] && [ -w "$dir" ]
}
preflight_prefix() {
  prefix_writable && return 0
  echo "error: $PREFIX is not writable by $(id -un 2>/dev/null || echo 'this user')" >&2
  echo "next: ./install.sh --prefix=\"\$HOME/.local/bin\"   # user-writable, no sudo" >&2
  echo "next: or re-run with sudo for a system-wide prefix" >&2
  exit 1
}
preflight_tools() {
  local tool missing_names="" missing_pkgs="" need_coreutils=0 fatal=0
  # curl/tar/gzip fetch and unpack the release archive, so --from-release cannot
  # finish without them; a source build only needs curl when Rust itself still
  # has to be downloaded.
  for tool in curl tar gzip; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing_names="$missing_names $tool"
      missing_pkgs="$missing_pkgs $tool"
      if [ "$FROM_RELEASE" = 1 ]; then fatal=1; fi
    fi
  done
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    missing_names="$missing_names sha256sum"
    need_coreutils=1
    if [ "$FROM_RELEASE" = 1 ]; then fatal=1; fi
  fi
  # install(1) is the coreutils copy that places the binary in PREFIX; every
  # path that installs anything needs it.
  if ! command -v install >/dev/null 2>&1; then
    missing_names="$missing_names install"
    need_coreutils=1
    fatal=1
  fi
  if [ "$need_coreutils" = 1 ]; then missing_pkgs="$missing_pkgs coreutils"; fi
  if [ -z "$missing_names" ]; then return 0; fi
  echo "note: installer prerequisites missing:$missing_names"
  local hint=""
  # shellcheck disable=SC2086 # the package names are the command's arguments
  hint="$(package_install_command $missing_pkgs)"
  if [ -n "$hint" ]; then echo "next: $hint   # then re-run this installer"; fi
  if [ "$fatal" = 1 ]; then
    echo "error: this install path cannot continue without:$missing_names" >&2
    exit 1
  fi
}
preflight_runtime() {
  # rdsh is one native binary; conversations and agent runs delegate to the
  # original dsh, which needs Node.js 22+. Native commands keep working without
  # either one, so these stay notes.
  local missing="" node_version="" node_major=""
  if command -v node >/dev/null 2>&1; then
    node_version="$(node --version 2>/dev/null || true)"
    node_major="${node_version#v}"
    node_major="${node_major%%.*}"
    case "$node_major" in ''|*[!0-9]*) node_major="" ;; esac
    if [ -n "$node_major" ] && [ "$node_major" -lt 22 ]; then missing="$missing node($node_version)"; fi
  else
    missing="$missing node"
  fi
  if ! command -v npm >/dev/null 2>&1; then missing="$missing npm"; fi
  if ! command -v dsh >/dev/null 2>&1 && [ -z "${DSH_ORIG_BIN:-}${RDSH_ORIG_BIN:-}" ]; then
    missing="$missing dsh"
  fi
  if [ -z "$missing" ]; then return 0; fi
  echo "note: conversations and agent runs need Node.js 22+ and the original dsh; missing:$missing"
  echo "next: install Node.js 22+ (nvm install 22 / volta install node@22), then: npm install -g @deepseek-ai/dsh"
  echo "next: already have dsh elsewhere? set DSH_ORIG_BIN=/path/to/dsh"
  echo "note: native commands (tokens, search, sessions, doctor) work without Node.js."
}
preflight_checks() {
  preflight_prefix
  preflight_tools
  preflight_runtime
}
# The user-facing "what now?" block after a successful install: PATH, the
# optional rpm-family packages, and how the release build was chosen.
post_install_notes() {
  case ":$PATH:" in
    *":$PREFIX:"*) ;;
    *)
      echo "note: $PREFIX is not on PATH yet"
      echo "next: export PATH=\"$PREFIX:\$PATH\"   # add the same line to ~/.bashrc to keep it"
      ;;
  esac
  if is_rpm_family; then
    local id missing_names="" missing_pkgs=""
    if ! command -v zstd >/dev/null 2>&1; then
      missing_names="$missing_names zstd (rdsh sessions --tokens)"
      missing_pkgs="$missing_pkgs zstd"
    fi
    if ! command -v bwrap >/dev/null 2>&1 && ! command -v bubblewrap >/dev/null 2>&1; then
      missing_names="$missing_names bubblewrap (--share-file sandbox)"
      missing_pkgs="$missing_pkgs bubblewrap"
    fi
    if [ -n "$missing_pkgs" ]; then
      echo "note: optional tools missing on this rpm-based host:$missing_names"
      # shellcheck disable=SC2086 # the package names are the command's arguments
      echo "next: $(package_install_command $missing_pkgs)"
    fi
    # rpm hosts ship a current glibc, so the static musl archive is only the
    # fallback and never needs a musl package of its own.
    if [ "$FROM_RELEASE" = 1 ]; then
      id="$(os_release_id)"
      local gv=""
      gv="$(glibc_version 2>/dev/null || true)"
      if [ "${USE_MUSL:-0}" = 1 ]; then
        echo "note: static musl build requested (--musl); it needs no extra package"
      elif [ -n "$gv" ] && ver_lt "$gv" "$RELEASE_GLIBC_FLOOR"; then
        echo "note: glibc $gv is older than $RELEASE_GLIBC_FLOOR; the static musl fallback needs no extra package"
      elif [ -n "$gv" ]; then
        echo "note: $id ships glibc $gv; the standard glibc build is used (no musl package needed)"
      fi
    fi
  fi
}
preflight_checks
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
  if ! cargo build --release; then
    echo "next: fix the build error above, or use the prebuilt binary: ./install.sh --from-release" >&2
    exit 1
  fi
fi
mkdir -p "$PREFIX" "$HOME/.config/rdsh"
# Preserve a provable legacy shadow before replacing its only native anchor.
# Unknown or already stale ownership does not block a standalone rdsh update.
if [ ! -e "$SHADOW_RECEIPT" ] && [ ! -L "$SHADOW_RECEIPT" ] \
  && [ -f "$PREFIX/dsh-orig" ] && shadow_matches_anchor; then
  write_shadow_receipt "$PREFIX/dsh" "$PREFIX/dsh-orig" || exit 1
fi
shadow_already_rdsh=0
if [ "$MODE" = as-dsh ] && shadow_matches_anchor; then shadow_already_rdsh=1; fi
install -m755 "$BIN_SRC" "$PREFIX/rdsh"
echo "installed $PREFIX/rdsh"
if [ "$MODE" = as-dsh ]; then
  if [ -e "$PREFIX/dsh-orig" ] || [ -L "$PREFIX/dsh-orig" ]; then echo "backup exists: $PREFIX/dsh-orig (use --restore first)" >&2; exit 1; fi
  if [ -e "$SHADOW_RECEIPT" ] || [ -L "$SHADOW_RECEIPT" ]; then echo "shadow receipt exists: $SHADOW_RECEIPT (use --restore first)" >&2; exit 1; fi
  SHADOW_TEMP="$(mktemp "$PREFIX/.dsh.new.XXXXXX")"
  install -m755 "$PREFIX/rdsh" "$SHADOW_TEMP"
  if [ "$shadow_already_rdsh" = 1 ]; then
    echo "PREFIX/dsh is already rdsh; refreshing"
  elif [ -e "$PREFIX/dsh" ] || [ -L "$PREFIX/dsh" ]; then
    mv "$PREFIX/dsh" "$PREFIX/dsh-orig"
    SHADOW_BACKUP_PENDING=1
    write_shadow_receipt "$SHADOW_TEMP" "$PREFIX/dsh-orig" || exit 1
    SHADOW_RECEIPT_PENDING=1
    echo "backed up original dsh -> $PREFIX/dsh-orig"
  else
    echo "no existing dsh in PREFIX; PATH lookup only"
  fi
  mv -f "$SHADOW_TEMP" "$PREFIX/dsh"
  SHADOW_TEMP=""
  SHADOW_BACKUP_PENDING=0
  SHADOW_RECEIPT_PENDING=0
  if [ -e "$PREFIX/dsh-orig" ]; then printf '%s\n' "$PREFIX/dsh-orig" > "$HOME/.config/rdsh/origin"; fi
  echo "installed rdsh as $PREFIX/dsh (atomic replace; revert: ./install.sh --restore)"
  # Bounded scan: regular files directly under PREFIX only (no recursion,
  # no binaries), matching the Rust doctor's own offender listing.
  # -I: バイナリは走査しない。rdsh/dsh 自身が "node" と "dsh" の両方を含むため、
  # テキストのラッパーが1つも無くても常に一致して誤検知になる。
  node_wrappers="$(find "$PREFIX" -maxdepth 1 -type f -size -65536c -exec sh -c '
    grep -Il "node" "$@"
    status=$?
    [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
  ' sh {} + 2>/dev/null)"
  if [ -n "$node_wrappers" ] && printf '%s\n' "$node_wrappers" | tr '\n' '\0' | xargs -0 grep -Il "dsh" 2>/dev/null | grep -q .; then
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
post_install_notes
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
