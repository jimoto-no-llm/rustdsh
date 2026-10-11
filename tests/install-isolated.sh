#!/usr/bin/env bash
# Isolated install test for install.sh.
#
# Each case runs the repository installer inside a fresh container with
# --network=none against a file:// release base, so the only moving part is the
# installer itself: the distro matrix, the static-musl fallback for hosts whose
# glibc is too old, and the fail-closed paths.
#
# Check what a new user gets from the published channel today (default):
#   tests/install-isolated.sh
# Check the installer plus fresh local artifacts before tagging:
#   tests/install-isolated.sh --source local --require-musl
#
# usage: tests/install-isolated.sh [options]
#   --source published|local|dir   assets to serve (default: published)
#   --installer repo|published     installer script to exercise (default: repo)
#   --release-tag TAG              published tag, or "latest" (default: latest)
#   --assets-dir DIR               staged assets for --source dir
#   --musl-binary PATH             musl binary for --source local
#   --engine podman|docker         container engine (default: auto-detect)
#   --case NAME                    run only this case (repeatable)
#   --list                         list cases and exit
#   --no-build                     skip cargo build with --source local
#   --require-musl                 fail instead of skipping when musl is missing
#   --rebuild-images               rebuild the prepared container images
#   --keep                         keep the work directory and logs
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS_DIR="$REPO_ROOT/tests/install-isolated"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/rdsh/install-isolated"
RELEASES_URL="https://github.com/jimoto-no-llm/rustdsh/releases"

ENGINE=""
SOURCE="published"
INSTALLER="repo"
RELEASE_TAG="latest"
ASSETS_DIR=""
MUSL_BINARY=""
NO_BUILD=0
REQUIRE_MUSL=0
REBUILD_IMAGES=0
KEEP=0
LIST_ONLY=0
SELECTED=()

WORK_DIR=""
STAGE_DIR=""
LOG_DIR=""
MUSL_AVAILABLE=0
RESOLVED_TAG=""
PREFIX="/root/.local/bin"

die() { printf 'error: %s\n' "$*" >&2; exit 2; }
note() { printf '%s\n' "$*" >&2; }

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:?}"; shift 2 ;;
    --installer) INSTALLER="${2:?}"; shift 2 ;;
    --release-tag) RELEASE_TAG="${2:?}"; shift 2 ;;
    --assets-dir) ASSETS_DIR="${2:?}"; shift 2 ;;
    --musl-binary) MUSL_BINARY="${2:?}"; shift 2 ;;
    --engine) ENGINE="${2:?}"; shift 2 ;;
    --case) SELECTED+=("${2:?}"); shift 2 ;;
    --list) LIST_ONLY=1; shift ;;
    --no-build) NO_BUILD=1; shift ;;
    --require-musl) REQUIRE_MUSL=1; shift ;;
    --rebuild-images) REBUILD_IMAGES=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

case "$SOURCE" in published|local|dir) ;; *) die "--source must be published, local or dir" ;; esac
case "$INSTALLER" in repo|published) ;; *) die "--installer must be repo or published" ;; esac

# ---------------------------------------------------------------- case registry
case_ids=()
case_images=()
case_scripts=()
case_expect=()
case_require=()
case_forbid=()
case_needs_musl=()
case_envs=()

add_case() {
  # id image-key script expect require forbid needs-musl env
  case_ids+=("$1"); case_images+=("$2"); case_scripts+=("$3")
  case_expect+=("$4"); case_require+=("$5"); case_forbid+=("$6")
  case_needs_musl+=("$7"); case_envs+=("${8:-}")
}

register_cases() {
  # A fresh install must work on every supported distro, offline.
  add_case "install/ubuntu-24.04" "ubuntu-24.04" "install-and-smoke.sh" ok \
    "CASE OK: install-and-smoke" "retrying with the static musl build" 0 ""
  add_case "install/ubuntu-22.04" "ubuntu-22.04" "install-and-smoke.sh" ok \
    "CASE OK: install-and-smoke|selecting static musl build" "" 1 ""
  add_case "install/ubuntu-20.04" "ubuntu-20.04" "install-and-smoke.sh" ok \
    "CASE OK: install-and-smoke|selecting static musl build" "" 1 ""
  add_case "install/debian-12" "debian-12" "install-and-smoke.sh" ok \
    "CASE OK: install-and-smoke|selecting static musl build" "" 1 ""
  add_case "install/fedora-41" "fedora-41" "install-and-smoke.sh" ok \
    "CASE OK: install-and-smoke" "retrying with the static musl build" 0 ""
  add_case "install/rocky-9" "rocky-9" "install-and-smoke.sh" ok \
    "CASE OK: install-and-smoke|selecting static musl build" "" 1 ""
  add_case "install/alpine-3.20" "alpine-3.20" "install-and-smoke.sh" ok \
    "CASE OK: install-and-smoke|musl host detected" "" 1 ""
  add_case "install/nonroot-ubuntu-24.04" "ubuntu-24.04" "install-and-smoke.sh" ok \
    "CASE OK: install-and-smoke" "" 0 \
    "USER=1000:1000|HOME=/home/tester|PREFIX=/home/tester/.local/bin"
  # Release-path behavior: fallback, pinned tag.
  add_case "release/fallback-unrunnable-glibc" "ubuntu-24.04" "fallback-unrunnable-glibc.sh" ok \
    "CASE OK: fallback-unrunnable-glibc" "" 1 ""
  add_case "release/pinned-version" "ubuntu-24.04" "pinned-version.sh" ok \
    "CASE OK: pinned-version" "" 0 "RDSH_RELEASE_VERSION=__TAG__"
  # Fail-closed guards.
  add_case "guard/checksum-mismatch" "ubuntu-24.04" "checksum-mismatch.sh" ok \
    "CASE OK: checksum-mismatch" "" 0 ""
  add_case "guard/missing-sidecar" "ubuntu-24.04" "missing-sidecar.sh" ok \
    "CASE OK: missing-sidecar" "" 0 ""
  add_case "guard/unsupported-arch" "debian-12" "unsupported-arch.sh" ok \
    "CASE OK: unsupported-arch" "" 0 ""
  # CLI behaviors that a new user hits right after installing.
  add_case "cli/as-dsh-roundtrip" "ubuntu-24.04" "as-dsh-roundtrip.sh" ok \
    "CASE OK: as-dsh-roundtrip" "" 0 ""
  add_case "cli/reinstall" "ubuntu-24.04" "reinstall.sh" ok \
    "CASE OK: reinstall" "" 0 ""
  add_case "cli/wsl-detect" "ubuntu-24.04" "wsl-detect.sh" ok \
    "CASE OK: wsl-detect" "" 0 ""
}

image_for() {
  case "$1" in
    ubuntu-24.04) printf '%s' "ubuntu:24.04" ;;
    ubuntu-22.04) printf '%s' "ubuntu:22.04" ;;
    ubuntu-20.04) printf '%s' "ubuntu:20.04" ;;
    debian-12) printf '%s' "debian:12" ;;
    fedora-41) printf '%s' "fedora:41" ;;
    rocky-9) printf '%s' "rockylinux:9" ;;
    alpine-3.20) printf '%s' "alpine:3.20" ;;
    *) die "unknown image key: $1" ;;
  esac
}

# ---------------------------------------------------------------------- setup
detect_engine() {
  if [ -n "$ENGINE" ]; then
    command -v "$ENGINE" >/dev/null 2>&1 || die "--engine $ENGINE not found"
    return
  fi
  local candidate
  for candidate in podman docker; do
    if command -v "$candidate" >/dev/null 2>&1; then ENGINE="$candidate"; return; fi
  done
  die "no container engine found (install podman or docker)"
}

prepare_workdir() {
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rdsh-install-isolated.XXXXXX")"
  STAGE_DIR="$WORK_DIR/base"
  LOG_DIR="$WORK_DIR/logs"
  mkdir -p "$STAGE_DIR" "$LOG_DIR"
  trap cleanup EXIT
}

cleanup() {
  if [ "$KEEP" = 1 ]; then
    note "work directory kept: $WORK_DIR"
  elif [ -n "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
}

package_asset() {
  # binary destination-archive
  local binary="$1" archive="$2" dir
  dir="$(dirname "$archive")"
  mkdir -p "$dir"
  tar -czf "$archive" -C "$(dirname "$binary")" "$(basename "$binary")"
  (cd "$dir" && sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256")
}

stage_layout() {
  # Copy the archives and sidecars in $1 into the release-base layout.
  local source_dir="$1"
  local targets=("$STAGE_DIR/download/$RESOLVED_TAG")
  mkdir -p "${targets[@]}"
  if [ "$RELEASE_TAG" = latest ]; then
    targets+=("$STAGE_DIR/latest/download")
    mkdir -p "$STAGE_DIR/latest/download"
  fi
  local target asset
  for target in "${targets[@]}"; do
    for asset in "$source_dir"/rdsh-*.tar.gz "$source_dir"/rdsh-*.tar.gz.sha256; do
      [ -e "$asset" ] || continue
      cp -f "$asset" "$target/"
    done
  done
}

resolve_published_tag() {
  local url
  url="$(curl -fsSI -o /dev/null -w '%{redirect_url}' "$RELEASES_URL/latest/download/install.sh")"
  printf '%s' "${url##*/download/}" | sed 's#/.*##'
}

fetch_published_assets() {
  local tag="$1"
  local dir="$CACHE_DIR/published-$tag" asset
  mkdir -p "$dir"
  for asset in rdsh-linux-x64.tar.gz rdsh-linux-x64-musl.tar.gz; do
    [ -f "$dir/$asset" ] || curl -fsSL -o "$dir/$asset" "$RELEASES_URL/download/$tag/$asset" \
      || die "could not download $asset for $tag"
    [ -f "$dir/$asset.sha256" ] || curl -fsSL -o "$dir/$asset.sha256" "$RELEASES_URL/download/$tag/$asset.sha256" \
      || die "could not download $asset.sha256 for $tag"
    (cd "$dir" && sha256sum -c "$asset.sha256" >/dev/null) || die "$asset does not match its published sidecar"
  done
  printf '%s' "$dir"
}

stage_local_assets() {
  local dir="$WORK_DIR/local-assets" musl=""
  mkdir -p "$dir"
  if [ "$NO_BUILD" = 0 ]; then
    note "building local release artifacts (cargo build --locked --release)"
    (cd "$REPO_ROOT" && cargo build --locked --release) || die "cargo build failed"
  fi
  [ -x "$REPO_ROOT/target/release/rdsh" ] || die "no target/release/rdsh (drop --no-build to build it)"
  package_asset "$REPO_ROOT/target/release/rdsh" "$dir/rdsh-linux-x64.tar.gz"
  if [ -n "$MUSL_BINARY" ]; then
    musl="$MUSL_BINARY"
  elif [ -x "$REPO_ROOT/target/x86_64-unknown-linux-musl/release/rdsh" ]; then
    musl="$REPO_ROOT/target/x86_64-unknown-linux-musl/release/rdsh"
  fi
  if [ -n "$musl" ]; then
    package_asset "$musl" "$dir/rdsh-linux-x64-musl.tar.gz"
  fi
  printf '%s' "$dir"
}

stage_dir_assets() {
  [ -n "$ASSETS_DIR" ] || die "--source dir needs --assets-dir DIR"
  printf '%s' "$ASSETS_DIR"
}

musl_asset_available() {
  local dir="$1"
  [ -f "$dir/rdsh-linux-x64-musl.tar.gz" ] && [ -f "$dir/rdsh-linux-x64-musl.tar.gz.sha256" ]
}

stage_installer() {
  # The repo copy tests the installer under review; the published copy is the
  # exact path a new user gets from the release.
  case "$INSTALLER" in
    repo) cp -f "$REPO_ROOT/install.sh" "$STAGE_DIR/install.sh" ;;
    published)
      curl -fsSL -o "$STAGE_DIR/install.sh" "$RELEASES_URL/download/$RESOLVED_TAG/install.sh" \
        || die "could not download the published install.sh for $RESOLVED_TAG"
      ;;
  esac
}

stage_assets() {
  local dir
  case "$SOURCE" in
    published)
      if [ "$RELEASE_TAG" = latest ]; then
        RESOLVED_TAG="$(resolve_published_tag)" || die "could not resolve the latest published tag"
        [ -n "$RESOLVED_TAG" ] || die "could not resolve the latest published tag"
      else
        RESOLVED_TAG="$RELEASE_TAG"
      fi
      note "published assets: $RESOLVED_TAG"
      dir="$(fetch_published_assets "$RESOLVED_TAG")"
      ;;
    local)
      RESOLVED_TAG="$RELEASE_TAG"
      if [ "$RESOLVED_TAG" = latest ]; then
        RESOLVED_TAG="v$(cd "$REPO_ROOT" && python3 -c 'import tomllib; print(tomllib.load(open("Cargo.toml","rb"))["package"]["version"])')"
      fi
      dir="$(stage_local_assets)"
      ;;
    dir)
      RESOLVED_TAG="$RELEASE_TAG"
      dir="$(stage_dir_assets)"
      ;;
  esac
  if musl_asset_available "$dir"; then MUSL_AVAILABLE=1; fi
  stage_layout "$dir"
  stage_installer
  if [ "$MUSL_AVAILABLE" = 0 ]; then
    if [ "$REQUIRE_MUSL" = 1 ]; then
      die "--require-musl is set but no static musl asset is available"
    fi
    note "warning: no static musl asset available; musl-dependent cases will be skipped"
  fi
}

prepare_image() {
  # image-key -> image reference
  local key="$1" ref="rdsh-install-isolated/$key:local"
  if [ "$REBUILD_IMAGES" = 0 ] && "$ENGINE" image inspect "$ref" >/dev/null 2>&1; then
    printf '%s' "$ref"
    return
  fi
  # Registry pulls and package installs are the flaky part of this test; retry
  # before failing so a transient network problem does not read as a bad install.
  local attempt
  for attempt in 1 2 3; do
    note "building test image $ref from $(image_for "$key") (attempt $attempt)"
    if "$ENGINE" build -q --build-arg "BASE_IMAGE=$(image_for "$key")" -t "$ref" \
        -f "$TESTS_DIR/Containerfile" "$TESTS_DIR" >&2; then
      printf '%s' "$ref"
      return
    fi
    sleep $((attempt * 5))
  done
  die "could not build $ref"
}

selected_case() {
  [ "${#SELECTED[@]}" = 0 ] && return 0
  local want
  for want in "${SELECTED[@]}"; do [ "$want" = "$1" ] && return 0; done
  return 1
}

matches_any() {
  # $1: haystack pattern list "a|b"; $2: log file
  local pattern
  [ -z "$1" ] && return 0
  while IFS= read -r pattern; do
    [ -z "$pattern" ] && continue
    grep -Eq "$pattern" "$2" || { printf '%s' "$pattern"; return 1; }
  done < <(printf '%s\n' "$1" | tr '|' '\n')
  return 0
}

first_match() {
  local pattern
  [ -z "$1" ] && return 1
  while IFS= read -r pattern; do
    [ -z "$pattern" ] && continue
    if grep -Eq "$pattern" "$2"; then printf '%s' "$pattern"; return 0; fi
  done < <(printf '%s\n' "$1" | tr '|' '\n')
  return 1
}

# ------------------------------------------------------------------ execution
pass=0; fail=0; skip=0; failed_ids=()

run_case() {
  local id="$1" key="$2" script="$3" expect="$4" require="$5" forbid="$6" needs_musl="$7" envs="${8:-}"
  selected_case "$id" || return 0
  local label
  label="$(printf '%-34s' "$id")"

  if [ "$needs_musl" = 1 ] && [ "$MUSL_AVAILABLE" = 0 ]; then
    printf 'SKIP  %s (no static musl asset; use --require-musl to fail)\n' "$label"
    skip=$((skip + 1))
    return 0
  fi

  local image log started elapsed rc
  image="$(prepare_image "$key")"
  if [ -z "$image" ]; then
    printf 'FAIL  %s (could not prepare the test image)\n' "$label"
    failed_ids+=("$id")
    fail=$((fail + 1))
    return 0
  fi
  log="$LOG_DIR/${id//\//_}.log"
  started="$(date +%s)"

  local -a args=(run --rm --network=none --security-opt label=disable
    -v "$STAGE_DIR/install.sh:/install.sh:ro"
    -v "$TESTS_DIR/cases:/cases:ro"
    -v "$STAGE_DIR:/base:ro"
    -e HOME=/root
    -e "PREFIX=$PREFIX"
    -e "ASSET_BASE=/base"
    -e "RDSH_RELEASE_BASE=file:///base"
    -e "RDSH_RELEASE_VERSION=$RELEASE_TAG")

  local entry user_env
  if [ -n "$envs" ]; then
    while IFS= read -r entry; do
      [ -z "$entry" ] && continue
      case "$entry" in
        USER=*) args+=(--user "${entry#USER=}") ;;
        *) args+=(-e "${entry//__TAG__/$RESOLVED_TAG}") ;;
      esac
    done < <(printf '%s\n' "$envs" | tr '|' '\n')
  fi

  set +e
  "$ENGINE" "${args[@]}" "$image" /bin/bash "/cases/$script" >"$log" 2>&1
  rc=$?
  set -e
  elapsed=$(( $(date +%s) - started ))

  local problem=""
  if [ "$expect" = fail ]; then
    [ "$rc" != 0 ] || problem="installer unexpectedly succeeded"
  else
    [ "$rc" = 0 ] || problem="exit $rc"
  fi
  if [ -z "$problem" ]; then
    local missing
    missing="$(matches_any "$require" "$log")" || problem="missing expected output: $missing"
  fi
  if [ -z "$problem" ]; then
    local hit
    hit="$(first_match "$forbid" "$log")" && problem="unexpected output: $hit"
  fi

  if [ -z "$problem" ]; then
    printf 'PASS  %s %ss\n' "$label" "$elapsed"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s %s (%s)\n' "$label" "${elapsed}s" "$problem"
    printf '      log: %s\n' "$log"
    tail -n 12 "$log" | sed 's/^/      | /'
    failed_ids+=("$id")
    fail=$((fail + 1))
  fi
}

main() {
  detect_engine
  register_cases
  if [ "$LIST_ONLY" = 1 ]; then
    printf '%s\n' "${case_ids[@]}"
    exit 0
  fi
  prepare_workdir
  note "engine: $ENGINE"
  note "source: $SOURCE (tag $RELEASE_TAG)"
  stage_assets
  note "stage:  $STAGE_DIR"
  note ""

  local index
  for index in "${!case_ids[@]}"; do
    run_case "${case_ids[$index]}" "${case_images[$index]}" "${case_scripts[$index]}" \
      "${case_expect[$index]}" "${case_require[$index]}" "${case_forbid[$index]}" \
      "${case_needs_musl[$index]}" "${case_envs[$index]}"
  done

  printf '\n== isolated install test: %s passed, %s failed, %s skipped ==\n' "$pass" "$fail" "$skip"
  if [ "$fail" != 0 ]; then
    printf 'failed: %s\n' "${failed_ids[*]}"
    exit 1
  fi
}

main "$@"
