#!/bin/sh
# Keep the original dsh in step with upstream releases (rdsh itself needs no
# rebuild: it delegates by exec). Safe by default: verify after update,
# roll back to the previous version on any failure.
# Usage: sync-dsh.sh [--check-only] [--channel rc|any]  (default channel: rc)
# Release checklist ref (Issue #7, docs only): after `cargo publish`, the new
# rdsh release binary is picked up here on the next run (step 6); use
# --check-only to preview without installing.
# rdsh self-update prefers a prebuilt release binary; source builds run only with
# RDSH_SYNC_FROM_SOURCE=1 (under nice/ionice). Regress always runs sandboxed.
set -u
CHANNEL="rc"
CHECK_ONLY=0
for a in "$@"; do
  case "$a" in
    --check-only) CHECK_ONLY=1 ;;
    --channel=*) CHANNEL="${a#--channel=}" ;;
    -h|--help) echo "usage: sync-dsh.sh [--check-only] [--channel rc|any]"; echo "  env: RDSH_SYNC_FROM_SOURCE=1 (rebuild rdsh from source instead of release binary)"; echo "       RDSH_MUSL=1 (prefer the static musl build), RDSH_SYNC_VERSION=VER (pin release)"; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done
case "$CHANNEL" in
  rc|any) ;;
  *) echo "unsupported channel: $CHANNEL (use rc or any)" >&2; exit 2 ;;
esac
LOGDIR="${HOME}/.local/share/rdsh"
LOCK="$LOGDIR/sync.lock"
mkdir -p "$LOGDIR"
log() { printf "%s %s\n" "$(date -u +%FT%TZ)" "$*" | tee -a "$LOGDIR/sync.log"; }
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK" || exit 1
  flock -n 9 || { log "another sync is running; exit"; exit 0; }
fi
# Resolve the newest locally-installed node-v* tree (same "latest matching
# tree" rule rdsh itself uses) instead of a pinned version dir.
node_tree_bin() {
  _os="$(uname -s 2>/dev/null | tr 'A-Z' 'a-z')"
  _arch="$(uname -m 2>/dev/null)"
  case "$_arch" in
    aarch64|arm64) _arch=arm64 ;;
    x86_64) _arch=x64 ;;
  esac
  # macOS/linux dirnames follow node-vX.Y.Z-<os>-<arch>; pick the latest by
  # numeric sort (sort -V is GNU-only and absent on macOS).
  _best=""; _bestv=""
  for d in "$HOME"/.local/opt/node-v*-"$_os"-"$_arch"; do
    [ -d "$d" ] || continue
    _v="${d##*/node-v}"; _v="${_v%%-*}"
    if [ -z "$_best" ] || [ "$(printf '%s\n%s\n' "$_v" "$_bestv" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1)" = "$_v" ]; then
      _best="$d"; _bestv="$_v"
    fi
  done
  [ -n "$_best" ] && printf '%s' "$_best/bin"
}
NODEBIN="$(node_tree_bin || true)"
if [ -n "$NODEBIN" ]; then
  export PATH="$HOME/.local/bin:$NODEBIN:$HOME/.cargo/bin:$PATH"
else
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi
write_state() {
  node - "$LOGDIR/update-state.json" "$1" "$2" "$3" "$(date +%s)000" <<'JSON'
const fs = require('node:fs');
const [target, kind, from, to, at] = process.argv.slice(2);
const timestamp = Number(at);
if (!Number.isSafeInteger(timestamp)) process.exit(1);
const temporary = `${target}.${process.pid}.tmp`;
let created = false;
let fd;
try {
  fd = fs.openSync(temporary, 'wx', 0o600);
  created = true;
  fs.writeFileSync(fd, `${JSON.stringify({updated:true,kind,from,to,at:timestamp})}\n`);
  fs.closeSync(fd);
  fd = undefined;
  fs.renameSync(temporary, target);
  created = false;
} catch (error) {
  if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  if (created) try { fs.unlinkSync(temporary); } catch {}
  process.stderr.write(`failed to write update state: ${error.message}\n`);
  process.exitCode = 1;
}
JSON
}
FROM_SOURCE="${RDSH_SYNC_FROM_SOURCE:-0}"
PREFIX_BIN="${PREFIX_BIN:-$HOME/.local/bin}"
lowprio_run() {
  # Run "$@" at idle I/O + lowest CPU priority when nice/ionice exist.
  if command -v ionice >/dev/null 2>&1 && command -v nice >/dev/null 2>&1; then
    ionice -c3 nice -n 19 "$@"
  elif command -v nice >/dev/null 2>&1; then
    nice -n 19 "$@"
  else
    "$@"
  fi
}
sandboxed_regress() {
  # Run regress with a throwaway HOME/DSH_HOME (issue #85 item 8).
  sb="$(mktemp -d 2>/dev/null || mktemp -d -t rdsh-sync-regress)"
  mkdir -p "$sb/home" "$sb/dsh"
  if env -i PATH="$PATH" HOME="$sb/home" DSH_HOME="$sb/dsh" BIN="$1" sh "$REPO/tests/regress.sh" >> "$LOGDIR/sync.log" 2>&1; then
    rc=0
  else
    rc=1
  fi
  rm -rf "$sb"
  return $rc
}
rdsh_release_asset() {
  # Print the prebuilt asset name for this host (musl on Linux/x86_64 when
  # RDSH_MUSL=1 or glibc < 2.34); fail when no binary exists.
  os="$(uname -s 2>/dev/null || echo unknown)"
  arch="$(uname -m 2>/dev/null || echo unknown)"
  case "$os/$arch" in
    Linux/x86_64)
      if [ "${RDSH_MUSL:-0}" = 1 ]; then echo "rdsh-linux-x64-musl.tar.gz"; return 0; fi
      gv="$(ldd --version 2>/dev/null | head -n 1 | grep -oE "[0-9]+\.[0-9]+(\.[0-9]+)?" | tail -n 1)"
      if [ -n "$gv" ] && awk -v a="$gv" -v b="2.34" 'BEGIN { n=split(a,aa,"."); m=split(b,bb,"."); k=(n>m?n:m); for(i=1;i<=k;i++){x=(aa[i]==""?0:aa[i]); y=(bb[i]==""?0:bb[i]); if(x<y) exit 0; if(x>y) exit 1;} exit 1; }'; then
        echo "rdsh-linux-x64-musl.tar.gz"
      else
        echo "rdsh-linux-x64.tar.gz"
      fi
      ;;
    Darwin/arm64) echo "rdsh-macos-arm64.tar.gz" ;;
    Darwin/x86_64) echo "rdsh-macos-x64.tar.gz" ;;
    *) return 1 ;;
  esac
}
verify_sha256() {
  # Same check as install.sh: the first field of sidecar $2 must equal the
  # sha256 of $1 (case-insensitive). A missing or empty sidecar fails.
  line="$(cat "$2" 2>/dev/null)"
  want="${line%% *}"
  if [ -z "$want" ]; then
    log "empty checksum sidecar"
    return 1
  fi
  if ! printf '%s\n' "$want" | grep -Eq '^[a-fA-F0-9]{64}$'; then
    log "invalid release checksum; refusing update"
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$1")"
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$1")"
  else
    log "no sha256sum or shasum available"
    return 1
  fi
  got="${out%% *}"
  lwant="$(printf %s "$want" | tr A-F a-f)"
  lgot="$(printf %s "$got" | tr A-F a-f)"
  if [ -n "$lgot" ] && [ "$lwant" = "$lgot" ]; then
    log "checksum ok"
    return 0
  fi
  log "CHECKSUM MISMATCH"
  return 1
}
fetch_rdsh_release() {
  # Install the prebuilt release rdsh binary to $1 after checking it against
  # its <asset>.sha256 sidecar. Honors RDSH_RELEASE_BASE (tests: file:///path)
  # and RDSH_SYNC_VERSION (default: latest).
  dest="$1"
  base="${RDSH_RELEASE_BASE:-https://github.com/jimoto-no-llm/rustdsh/releases}"
  ver="${RDSH_SYNC_VERSION:-latest}"
  asset="$(rdsh_release_asset)" || { log "no prebuilt rdsh binary for this host; set RDSH_SYNC_FROM_SOURCE=1 to build"; return 1; }
  if [ "$ver" = "latest" ]; then url="$base/latest/download/$asset"; else url="$base/download/$ver/$asset"; fi
  tmpd="$(mktemp -d 2>/dev/null || mktemp -d -t rdsh-sync-fetch)"
  log "fetching rdsh release: $url"
  if ! curl -fsSL -o "$tmpd/pkg.tgz" "$url"; then rm -rf "$tmpd"; return 1; fi
  if ! curl -fsSL -o "$tmpd/pkg.tgz.sha256" "$url.sha256" 2>/dev/null; then
    log "no checksum sidecar: $url.sha256"; rm -rf "$tmpd"; return 1
  fi
  if ! verify_sha256 "$tmpd/pkg.tgz" "$tmpd/pkg.tgz.sha256"; then rm -rf "$tmpd"; return 1; fi
  if ! tar -xzf "$tmpd/pkg.tgz" -C "$tmpd"; then rm -rf "$tmpd"; return 1; fi
  if [ ! -x "$tmpd/rdsh" ]; then rm -rf "$tmpd"; return 1; fi
  install -m755 "$tmpd/rdsh" "$dest"
  rc=$?
  rm -rf "$tmpd"
  return $rc
}
NPM=""
for cand in "${NPM_BIN:-}" "$HOME/.local/bin/npm" "$NODEBIN/npm" "$(command -v npm 2>/dev/null)"; do
  if [ -n "$cand" ] && [ -x "$cand" ]; then NPM="$cand"; break; fi
done
if [ -z "$NPM" ]; then log "npm not found; set NPM_BIN"; exit 1; fi
log "using npm: $NPM"
PKGROOT="$("$NPM" root -g 2>/dev/null)/@deepseek-ai/dsh"
if [ ! -f "$PKGROOT/package.json" ]; then log "dsh package not found under $PKGROOT"; exit 1; fi
INSTALLED="$(node -p "require(process.argv[1]).version" "$PKGROOT/package.json" 2>/dev/null)"
if [ -z "$INSTALLED" ]; then log "cannot read installed version"; exit 1; fi
ALL="$("$NPM" view @deepseek-ai/dsh versions --json 2>/dev/null || true)"
if [ -z "$ALL" ]; then log "registry unreachable; try later"; exit 0; fi
# SemVer 2.0.0 precedence: stable follows its prereleases, numeric identifiers
# compare numerically, build metadata has no precedence. Use the Node runtime
# already required above, without a new package or GNU-only sort dependency.
pick() {
  node - "$INSTALLED" "$CHANNEL" "$ALL" <<'SEMVER'
const [installed, channel, versions] = process.argv.slice(2);
function parse(value) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const pre = match[4]?.split('.') || [];
  if (pre.some(part => /^[0-9]+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return {value, core:match.slice(1,4).map(BigInt), pre};
}
function compare(a,b) {
  for (let i=0;i<3;i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i=0;i<Math.max(a.pre.length,b.pre.length);i++) {
    const x=a.pre[i], y=b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx=/^[0-9]+$/.test(x), ny=/^[0-9]+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
const current=parse(installed);
if (!current) {console.error('Installed DSH version is not valid SemVer'); process.exit(1);}
let candidates;
try {
  const data=JSON.parse(versions);
  candidates=Array.isArray(data) ? data : typeof data === 'string' ? [data] : null;
  if (!candidates || candidates.some(value => typeof value !== 'string')) throw new Error('Expected version strings');
} catch {
  console.error('Registry DSH versions are not valid JSON version strings'); process.exit(1);
}
let latest;
for (const value of candidates) {
  const candidate=parse(value);
  if (!candidate || (channel === 'rc' && candidate.pre.length && !/^rc\.(0|[1-9][0-9]*)$/.test(candidate.pre.join('.')))) continue;
  if (!latest || compare(candidate,latest) > 0) latest=candidate;
}
if (!latest) {console.error('No valid DSH version in selected channel'); process.exit(1);}
console.log(`${latest.value}|${compare(latest,current)}`);
SEMVER
}
SELECTED="$(pick)" || { log "cannot compare DSH versions; binaries untouched"; exit 1; }
LATEST="${SELECTED%|*}"
PRECEDENCE="${SELECTED##*|}"
log "installed=$INSTALLED latest($CHANNEL)=$LATEST"
DSH_CHANGED=0
if [ "$PRECEDENCE" -le 0 ]; then
  log "dsh up to date (no newer SemVer in selected channel)"
else
  DSH_CHANGED=1
  if [ "$CHECK_ONLY" = 1 ]; then log "dsh update available: $LATEST"; fi
fi
if [ "$DSH_CHANGED" = 1 ] && [ "$CHECK_ONLY" = 0 ]; then
log "updating $INSTALLED -> $LATEST"
if ! "$NPM" install -g "@deepseek-ai/dsh@$LATEST" >> "$LOGDIR/sync.log" 2>&1; then
  log "npm install failed; kept $INSTALLED"; exit 1
fi
GOT="$(node -p "require(process.argv[1]).version" "$PKGROOT/package.json" 2>/dev/null)"
ORIG_BIN="$(command -v dsh-orig 2>/dev/null || printf "%s" "$HOME/.local/bin/dsh-orig")"
if [ "$GOT" = "$LATEST" ] && [ -x "$ORIG_BIN" ] && "$ORIG_BIN" --version >/dev/null 2>&1; then
  log "updated OK: $GOT (orig binary answers)"
  write_state "dsh" "$INSTALLED" "$GOT"
else
  log "verify failed (got=$GOT); rolling back to $INSTALLED"
  "$NPM" install -g "@deepseek-ai/dsh@$INSTALLED" >> "$LOGDIR/sync.log" 2>&1 || true
  log "rollback done"
  exit 1
fi
fi
REPO="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$REPO/target/release/rdsh" ] && [ -f "$REPO/tests/regress.sh" ]; then
  if sandboxed_regress "$REPO/target/release/rdsh"; then
    log "post-update regress: ALL PASS"
  else
    log "post-update regress: FAILURES (see above); dsh itself is updated, rdsh compat needs a look"
  fi
fi
if [ "$FROM_SOURCE" = 1 ]; then
  if [ ! -d "$REPO/.git" ] || ! command -v git >/dev/null 2>&1; then
    log "rdsh repo unavailable; skipping source build"
  elif ! git -C "$REPO" fetch origin main >> "$LOGDIR/sync.log" 2>&1; then
    log "rdsh fetch failed; try later"
  else
    LOCAL="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)"
    REMOTE="$(git -C "$REPO" rev-parse origin/main 2>/dev/null)"
    if [ -z "$LOCAL" ] || [ -z "$REMOTE" ]; then
      log "rdsh ref lookup failed"
    elif [ "$LOCAL" = "$REMOTE" ]; then
      log "rdsh up to date ($LOCAL)"
    elif [ "$CHECK_ONLY" = 1 ]; then
      log "rdsh update available: $REMOTE"
    elif [ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; then
      log "rdsh tree dirty; skipping auto-update"
    elif ! git -C "$REPO" merge --ff-only "origin/main" >> "$LOGDIR/sync.log" 2>&1; then
      log "rdsh fast-forward failed; skipping"
    elif ! command -v cargo >/dev/null 2>&1; then
      log "cargo not found; pulled but not rebuilt"
    elif (cd "$REPO" && lowprio_run cargo build --release >> "$LOGDIR/sync.log" 2>&1) \
      && sandboxed_regress "$REPO/target/release/rdsh"; then
      install -m755 "$REPO/target/release/rdsh" "$PREFIX_BIN/rdsh"
      if "$PREFIX_BIN/dsh" doctor 2>&1 | grep -q "rdsh"; then
        TMP="$PREFIX_BIN/.dsh.new.$$"
        install -m755 "$PREFIX_BIN/rdsh" "$TMP" && mv -f "$TMP" "$PREFIX_BIN/dsh"
      fi
      write_state "rdsh-source" "$LOCAL" "$REMOTE"
      log "rdsh updated OK: $REMOTE (source build, regress passed, binaries refreshed)"
    else
      log "rdsh build/regress failed; binaries untouched"
    fi
  fi
else
  if [ "$CHECK_ONLY" = 1 ]; then
    log "rdsh update check: release channel (RDSH_SYNC_VERSION=${RDSH_SYNC_VERSION:-latest})"
  else
    NEWBIN="$(mktemp 2>/dev/null || mktemp -t rdsh-sync-new)"
    rm -f "$NEWBIN"
    if ! fetch_rdsh_release "$NEWBIN"; then
      log "rdsh release fetch failed; binaries untouched"
    elif ! "$NEWBIN" --version >/dev/null 2>&1; then
      log "rdsh release binary failed to run; binaries untouched"
    elif cmp -s "$NEWBIN" "$PREFIX_BIN/rdsh"; then
      # Checking again is not a new update; keep the original notice cadence.
      log "rdsh up to date (release binary unchanged)"
    elif [ -f "$REPO/tests/regress.sh" ] && ! sandboxed_regress "$NEWBIN"; then
      log "rdsh release regress failed; binaries untouched"
    else
      OLD_RDSH="$("$PREFIX_BIN/rdsh" --version 2>/dev/null || echo unknown)"
      NEW_RDSH="$("$NEWBIN" --version 2>/dev/null || echo unknown)"
      install -m755 "$NEWBIN" "$PREFIX_BIN/rdsh"
      if "$PREFIX_BIN/dsh" doctor 2>&1 | grep -q "rdsh"; then
        TMP="$PREFIX_BIN/.dsh.new.$$"
        install -m755 "$PREFIX_BIN/rdsh" "$TMP" && mv -f "$TMP" "$PREFIX_BIN/dsh"
      fi
      write_state "rdsh-release" "$OLD_RDSH" "$NEW_RDSH"
      log "rdsh updated OK via release binary ($NEW_RDSH; regress passed, binaries refreshed)"
    fi
    rm -f "$NEWBIN"
  fi
fi
log "done"
