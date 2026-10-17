#!/bin/sh
# rdsh CLI regression. Fails on first mismatch (explicit checks; set -e は無い).
if [ "${1:-}" = "--windows-installer-delegation" ]; then
  shift
  exec bash "$(dirname "$0")/regress-windows.sh" "$@"
fi
# Works from any cwd: a relative BIN is taken relative to the caller's cwd, the
# default is <repo>/target/release/rdsh, then we cd to the repo root (the checks
# below use ./install.sh, ./sync-dsh.sh and --dir src).
case "${BIN:-}" in ""|/*) ;; */*) BIN="$(pwd)/$BIN" ;; esac
cd "$(dirname "$0")/.." || exit 1
BIN="${BIN:-$PWD/target/release/rdsh}"
# Hermetic: this suite must never write to the real ~/.dsh (issue #85 item 8).
# Unless the caller already sandboxed it (RDSH_REGRESS_SANDBOXED=1), HOME and
# DSH_HOME point at a throwaway tree under RG_TMP, so the original dsh is found
# only via DSH_ORIG_BIN / RDSH_ORIG_BIN / PATH. Tests that need fixtures override
# HOME/DSH_HOME explicitly. rdsh's auth autosync is off for the same reason.
export RDSH_AUTH_AUTOSYNC=0
unset RDSH_DEFAULT_PROFILE
RG_TMP="$(mktemp -d 2>/dev/null || mktemp -d -t rdsh-regress)" || exit 1
trap 'rm -rf "$RG_TMP"' EXIT
trap 'exit 1' INT TERM
# Child mktemp calls (install.sh's download dir, ...) land under RG_TMP too.
mkdir -p "$RG_TMP/tmp"; TMPDIR="$RG_TMP/tmp"; export TMPDIR
if [ "${RDSH_REGRESS_SANDBOXED:-}" != 1 ]; then
  RR_SANDBOX="$RG_TMP/sandbox"
  mkdir -p "$RR_SANDBOX/home" "$RR_SANDBOX/dsh"
  HOME="$RR_SANDBOX/home"; DSH_HOME="$RR_SANDBOX/dsh"; RDSH_REGRESS_SANDBOXED=1
  export HOME DSH_HOME RDSH_REGRESS_SANDBOXED RR_SANDBOX
elif [ -z "${DSH_HOME:-}" ]; then
  DSH_HOME="$RG_TMP/dsh"; export DSH_HOME; mkdir -p "$DSH_HOME"
fi
pass=0
ok() { pass=$((pass+1)); echo "ok: $1"; }
# Keep the default diagnostic/delegation probe inside this test's sandbox.
# A developer's primary override must not win over later legacy fixtures.
# Use our own default stub even on hosts with no installed DSH. Individual
# delegation checks override the legacy variable; a developer's live primary
# override must not take precedence over those fixtures.
unset RDSH_ORIG_BIN DSH_ORIG_BIN
mkdir -p "$RR_SANDBOX/original"
printf '#!/bin/sh\necho stub-dsh "$@"\n' > "$RR_SANDBOX/original/dsh"
chmod +x "$RR_SANDBOX/original/dsh"
DSH_ORIG_BIN="$RR_SANDBOX/original/dsh"
export DSH_ORIG_BIN
need_ok() {
  desc="$1"; shift
  if "$@" >"$RG_TMP/rr-out" 2>"$RG_TMP/rr-err"; then ok "$desc"; else echo "FAIL(exit): $desc"; cat "$RG_TMP/rr-err"; exit 1; fi
}
need_exit() {
  want="$1"; desc="$2"; shift 2
  "$@" >"$RG_TMP/rr-out" 2>"$RG_TMP/rr-err"
  code=$?
  if [ "$code" = "$want" ]; then ok "$desc"; else echo "FAIL(exit $code want $want): $desc"; exit 1; fi
}
need_grep() {
  pat="$1"; desc="$2"; shift 2
  "$@" >"$RG_TMP/rr-out" 2>"$RG_TMP/rr-err"
  if grep -q "$pat" "$RG_TMP/rr-out"; then ok "$desc"; else echo "FAIL(output): $desc"; exit 1; fi
}
need_grep "rdsh" "version string" "$BIN" --version
need_ok "doctor" "$BIN" doctor
printf "hello world, this is a token test" | "$BIN" tokens > "$RG_TMP/rr-out" 2>/dev/null
if grep -q "\"tokens\": 9" "$RG_TMP/rr-out"; then ok "tokens stdin"; else echo "FAIL(output): tokens stdin"; exit 1; fi
need_ok "search" "$BIN" search estimate_tokens --dir src --max 5
need_ok "profiles" "$BIN" profiles
need_ok "skills" "$BIN" skills
need_ok "logs" "$BIN" logs --tail 3
need_ok "sessions" "$BIN" sessions --limit 2
need_ok "dump-native" "$BIN" dump-config --profile tui --native
need_ok "boot dry-run" "$BIN" --dry-run tui
printf "ls /tmp" | "$BIN" guard --deny "zzz-no-match" > /dev/null
if [ $? -eq 0 ]; then ok "guard allow"; else echo "FAIL: guard allow"; exit 1; fi
printf "run this" | "$BIN" guard --deny "run*" > /dev/null 2>&1
if [ $? -eq 2 ]; then ok "guard block"; else echo "FAIL: guard block"; exit 1; fi
need_exit 2 "reject desktop profile" "$BIN" --profile desktop
need_ok "desktop status" "$BIN" desktop status
need_grep "desktop profile" "desktop status reports the profile" "$BIN" desktop
need_grep "\"schema\": 1" "desktop status json" "$BIN" desktop status --json
need_exit 1 "desktop install refuses an uninitialized profile" "$BIN" desktop install --dry-run --plugins-dir .
need_exit 1 "desktop verify fails without a profile" "$BIN" desktop verify
need_exit 2 "reject double profile" "$BIN" --profile a --profile b
need_exit 2 "reject dump with args" "$BIN" --profile tui --dump-config --foo
need_exit 2 "reject plugin w/o args" "$BIN" plugin --profile tui
need_grep "plugin" "plugin delegation dry-run" "$BIN" --dry-run plugin --profile web add ./dsh-notify-push
need_grep "smart-dsh" "doctor reports smart-dsh" "$BIN" doctor
printf "%s" "$(python3 -c 'print(5791 * 4)')" | "$BIN" tokens > "$RG_TMP/rr-out" 2>"$RG_TMP/rr-err" \
  || { echo "FAIL(exit): tokens numeric stdin"; cat "$RG_TMP/rr-err"; exit 1; }
# 23164 は5バイトのASCIIなので 2 トークン。値まで見て初めて検証になる。
if python3 -c 'import json, sys
def reject_constant(value):
    raise ValueError(value)
try:
    output = json.load(sys.stdin, parse_constant=reject_constant)
except ValueError:
    sys.exit(1)
sys.exit(0 if isinstance(output, dict) and type(output.get("tokens")) is int and output["tokens"] == 2 else 1)' < "$RG_TMP/rr-out"; then
  ok "tokens numeric stdin"
else
  echo "FAIL(output): tokens numeric stdin"; cat "$RG_TMP/rr-out"; exit 1
fi
printf "FROMSTDIN" > "$RG_TMP/rr-in.txt"
need_ok "compact noop" "$BIN" compact "$RG_TMP/rr-in.txt" --max-tokens 8000
SB="$RG_TMP/delegate"
mkdir -p $SB/bin $SB/orig
cat > $SB/orig/dsh << FAKEEOF
#!/bin/sh
echo FAKE-ORIG
FAKEEOF
chmod +x $SB/orig/dsh
cp "$BIN" "$SB/bin/dsh"
if RDSH_AUTH_AUTOSYNC=0 PATH="$SB/bin:$SB/orig:$PATH" DSH_ORIG_BIN="$SB/orig/dsh" "$SB/bin/dsh" --version | grep -q FAKE-ORIG; then ok "dsh-mode delegates"; else echo "FAIL: dsh-mode delegates"; exit 1; fi
if RDSH_AUTH_AUTOSYNC=0 PATH="$SB/bin:$SB/orig:$PATH" DSH_ORIG_BIN="$SB/orig/dsh" "$SB/bin/dsh" doctor | grep -q rdsh; then ok "dsh-mode native"; else echo "FAIL: dsh-mode native"; exit 1; fi
if RDSH_AUTH_AUTOSYNC=0 PATH="$SB/bin:$SB/orig:$PATH" RDSH_ORIG_BIN="$SB/orig/dsh" "$SB/bin/dsh" --version | grep -q FAKE-ORIG; then ok "RDSH_ORIG_BIN primary"; else echo "FAIL: RDSH_ORIG_BIN primary"; exit 1; fi
# --- default profile: dsh >= 0.2.0 no longer ships `tui` ---
DP=$RG_TMP/dp
mkdir -p "$DP/empty" "$DP/withtui/profiles/tui"
dp_dry() { env -u RDSH_DEFAULT_PROFILE DSH_ORIG_BIN="$SB/orig/dsh" "$@"; }
dp_dry DSH_HOME="$DP/empty" "$BIN" --dry-run boot >"$DP/out" 2>"$DP/err"; code=$?
if [ "$code" = 1 ] && grep -q "no profile specified" "$DP/err" && grep -q "headless" "$DP/err" && grep -q "RDSH_DEFAULT_PROFILE=" "$DP/err"; then ok "no profile + no tui dir: guided error"; else echo "FAIL(exit $code want 1): no default profile guidance"; cat "$DP/err"; exit 1; fi
dp_dry DSH_HOME="$DP/empty" "$BIN" dump-config --native >"$DP/out" 2>"$DP/err"; code=$?
if [ "$code" = 1 ] && grep -q "no profile specified" "$DP/err"; then ok "dump-config without profile: guided error"; else echo "FAIL(exit $code want 1): dump-config default"; cat "$DP/err"; exit 1; fi
if dp_dry DSH_HOME="$DP/empty" RDSH_DEFAULT_PROFILE=web "$BIN" --dry-run boot 2>/dev/null | grep -q '"--profile" "web"'; then ok "RDSH_DEFAULT_PROFILE=web dry-run shows --profile web"; else echo "FAIL(output): RDSH_DEFAULT_PROFILE"; exit 1; fi
if dp_dry DSH_HOME="$DP/withtui" "$BIN" --dry-run boot 2>/dev/null | grep -q '"--profile" "tui"'; then ok "local tui profile dir keeps tui as default"; else echo "FAIL(output): tui dir default"; exit 1; fi
if dp_dry DSH_HOME="$DP/withtui" RDSH_DEFAULT_PROFILE=headless "$BIN" --dry-run boot 2>/dev/null | grep -q '"--profile" "headless"'; then ok "RDSH_DEFAULT_PROFILE beats local tui dir"; else echo "FAIL(output): env beats tui dir"; exit 1; fi
# general.default_profile (rdsh.json under DSH_HOME): beats the local tui dir, loses to the env var.
mkdir -p "$DP/cfg/profiles/tui"
DSH_HOME="$DP/cfg" "$BIN" settings set general.default_profile headless >/dev/null 2>&1
if dp_dry DSH_HOME="$DP/cfg" "$BIN" --dry-run boot 2>/dev/null | grep -q '"--profile" "headless"'; then ok "general.default_profile beats local tui dir"; else echo "FAIL(output): settings default_profile beats tui dir"; exit 1; fi
if dp_dry DSH_HOME="$DP/cfg" RDSH_DEFAULT_PROFILE=web "$BIN" --dry-run boot 2>/dev/null | grep -q '"--profile" "web"'; then ok "RDSH_DEFAULT_PROFILE beats general.default_profile"; else echo "FAIL(output): env beats settings default_profile"; exit 1; fi
if dp_dry DSH_HOME="$DP/empty" "$BIN" --dry-run --profile tui 2>/dev/null | grep -q '"--profile" "tui"' && dp_dry DSH_HOME="$DP/empty" "$BIN" --dry-run tui 2>/dev/null | grep -q '"--profile" "tui"'; then ok "explicit tui passes through verbatim"; else echo "FAIL(output): explicit tui passthrough"; exit 1; fi
# --- slim: Node compile cache (the part of slim that really speeds up Node boot) ---
# Default dir is $HOME/.cache/rdsh-node-compile-cache (XDG_CACHE_HOME is not consulted).
CC="$RG_TMP/cc"
mkdir -p "$CC/home" "$CC/home-pt"
printf '#!/bin/sh\nprintf "CACHE=%%s SLIM=%%s\\n" "$NODE_COMPILE_CACHE" "$RDSH_SLIM"\n' > "$CC/envdsh"
chmod 755 "$CC/envdsh"
CCDEF="$CC/home/.cache/rdsh-node-compile-cache"
if env -u NODE_COMPILE_CACHE -u RDSH_NODE_COMPILE_CACHE HOME="$CC/home" DSH_ORIG_BIN="$SB/orig/dsh" "$BIN" --dry-run tui 2>/dev/null | grep -q "NODE_COMPILE_CACHE=\"$CCDEF\""; then ok "slim dry-run shows NODE_COMPILE_CACHE"; else echo "FAIL(output): slim dry-run shows NODE_COMPILE_CACHE"; exit 1; fi
if env -u NODE_COMPILE_CACHE HOME="$CC/home-pt" DSH_ORIG_BIN="$SB/orig/dsh" "$BIN" --dry-run --passthrough tui 2>/dev/null | grep -q "NODE_COMPILE_CACHE\|RDSH_SLIM"; then echo "FAIL: --passthrough must add no env"; exit 1; else ok "passthrough adds no env"; fi
if [ ! -e "$CC/home-pt/.cache" ]; then ok "passthrough does not create the cache dir"; else echo "FAIL: passthrough created the cache dir"; exit 1; fi
if env -u NODE_COMPILE_CACHE HOME="$CC/home" RDSH_PASSTHROUGH=1 DSH_ORIG_BIN="$SB/orig/dsh" "$BIN" --dry-run tui 2>/dev/null | grep -q "NODE_COMPILE_CACHE"; then echo "FAIL: RDSH_PASSTHROUGH=1 must add no env"; exit 1; else ok "RDSH_PASSTHROUGH=1 adds no cache env"; fi
if env -u NODE_COMPILE_CACHE HOME="$CC/home" RDSH_NODE_COMPILE_CACHE=0 DSH_ORIG_BIN="$SB/orig/dsh" "$BIN" --dry-run tui 2>/dev/null | grep -q 'NODE_COMPILE_CACHE="'; then echo "FAIL: RDSH_NODE_COMPILE_CACHE=0 opt-out ignored"; exit 1; else ok "RDSH_NODE_COMPILE_CACHE=0 opts out"; fi
# A value the user already exports is left alone: rdsh adds nothing to the exec line.
if NODE_COMPILE_CACHE=/tmp/rdsh-mine HOME="$CC/home" DSH_ORIG_BIN="$SB/orig/dsh" "$BIN" --dry-run tui 2>/dev/null | grep "would exec" | grep -q 'NODE_COMPILE_CACHE='; then echo "FAIL: user NODE_COMPILE_CACHE must not be overridden (dry-run)"; exit 1; else ok "user NODE_COMPILE_CACHE respected (dry-run)"; fi
if NODE_COMPILE_CACHE=/tmp/rdsh-mine HOME="$CC/home" DSH_HOME="$CC/dsh" DSH_ORIG_BIN="$CC/envdsh" "$SB/bin/dsh" --version 2>/dev/null | grep -q "CACHE=/tmp/rdsh-mine "; then ok "metadata exec passes the user's NODE_COMPILE_CACHE through"; else echo "FAIL(output): metadata exec must keep the user's NODE_COMPILE_CACHE"; exit 1; fi
# Real exec (not dry-run): the child sees the default value and the directory exists.
# (The dry-runs above already made it, so start from a clean slate.)
rm -rf "$CC/home/.cache"
if env -u NODE_COMPILE_CACHE HOME="$CC/home" DSH_HOME="$CC/dsh" DSH_ORIG_BIN="$CC/envdsh" "$SB/bin/dsh" --version 2>/dev/null | grep -q "CACHE=$CCDEF " && [ -d "$CCDEF" ]; then ok "metadata exec exports NODE_COMPILE_CACHE and creates the dir"; else echo "FAIL(output): metadata exec exports NODE_COMPILE_CACHE"; exit 1; fi
rm -rf "$CC/home/.cache"
if env -u NODE_COMPILE_CACHE -u RDSH_NODE_COMPILE_CACHE -u RDSH_SECURITY HOME="$CC/home" DSH_HOME="$CC/dsh" DSH_ORIG_BIN="$CC/envdsh" "$BIN" tui > "$CC/out" 2> "$CC/err" && grep -q "CACHE=$CCDEF " "$CC/out" && [ -d "$CCDEF" ]; then ok "normal agent boot exports compile cache"; else echo "FAIL: normal agent boot compile cache"; cat "$CC/err"; exit 1; fi
rm -rf "$CC/home/.cache"
if env -u NODE_COMPILE_CACHE HOME="$CC/home" DSH_HOME="$CC/dsh" RDSH_SECURITY=1 DSH_ORIG_BIN="$CC/envdsh" "$BIN" tui > "$CC/out" 2> "$CC/err"; then echo "FAIL: strict agent runtime executed"; exit 1; elif grep -q "RDSH_SECURITY" "$CC/err" && [ ! -d "$CCDEF" ]; then ok "strict agent boot refuses before creating a cache"; else echo "FAIL: strict agent boot cache side effect"; cat "$CC/err"; exit 1; fi
rm -rf "$CC"
# --- doctor on a host with no Node/dsh: fails with a clear error ---
ND="$RG_TMP/nodsh"
mkdir -p "$ND/home"
env -u RDSH_ORIG_BIN -u DSH_ORIG_BIN HOME="$ND/home" PATH="/nonexistent" "$BIN" doctor > "$ND/out" 2> "$ND/err"
code=$?
if [ "$code" = 1 ] && grep -q "original 'dsh' not found" "$ND/err"; then ok "doctor exits 1 when original dsh is missing"; else echo "FAIL(output): doctor missing-dsh error (exit $code)"; cat "$ND/err"; exit 1; fi
rm -rf "$ND"
# --- fallback discovery: an nvm install the non-interactive PATH never sees ---
FB="$RG_TMP/fallback"
mkdir -p "$FB/home/.nvm/versions/node/v22.10.0/bin" "$FB/empty"
printf '#!/bin/sh\necho stub-nvm-dsh "$@"\n' > "$FB/home/.nvm/versions/node/v22.10.0/bin/dsh"
chmod +x "$FB/home/.nvm/versions/node/v22.10.0/bin/dsh"
env -u RDSH_ORIG_BIN -u DSH_ORIG_BIN RDSH_LANG=en HOME="$FB/home" DSH_HOME="$FB/dsh" PATH="$FB/empty" "$BIN" doctor > "$FB/out" 2> "$FB/err"
code=$?
if [ "$code" = 0 ] && grep -q ".nvm/versions/node/v22.10.0/bin/dsh" "$FB/out"; then ok "doctor resolves dsh under ~/.nvm outside PATH"; else echo "FAIL(exit $code): nvm fallback"; cat "$FB/out" "$FB/err"; exit 1; fi
rm -rf "$FB"
# --- doctor: pnpm build-script policy and the command that resolves it ---
PN="$RG_TMP/pnpm-policy"
mkdir -p "$PN/home/.local/share/pnpm" "$PN/empty" "$PN/config/pnpm"
printf '#!/bin/sh\necho 10.32.0\n' > "$PN/home/.local/share/pnpm/pnpm"
chmod +x "$PN/home/.local/share/pnpm/pnpm"
RDSH_LANG=en HOME="$PN/home" DSH_HOME="$PN/dsh" XDG_CONFIG_HOME="$PN/config" PATH="$PN/empty" "$BIN" doctor > "$PN/out" 2> "$PN/err"
if grep -q "fix: pnpm approve-builds --all -g" "$PN/out"; then ok "doctor prints the pnpm build-script fix"; else echo "FAIL(output): pnpm ignored-builds fix"; cat "$PN/out" "$PN/err"; exit 1; fi
printf 'only-built-dependencies[]=sharp\n' > "$PN/config/pnpm/rc"
RDSH_LANG=en HOME="$PN/home" DSH_HOME="$PN/dsh" XDG_CONFIG_HOME="$PN/config" PATH="$PN/empty" "$BIN" doctor > "$PN/out" 2> "$PN/err"
if grep -q "build scripts allowed by the global config" "$PN/out"; then ok "doctor respects an approved pnpm policy"; else echo "FAIL(output): pnpm approved policy"; cat "$PN/out" "$PN/err"; exit 1; fi
rm -rf "$PN"
# --- sessions --tokens: exact size from zstd frame headers when recorded, zstd CLI only otherwise ---
ZS="$RG_TMP/zst"
mkdir -p "$ZS/dsh/sessions/p/s1" "$ZS/dsh/sessions/p/s2" "$ZS/shim"
# s1: one frame, single-segment, FCS=200 (0xC8), one raw last block of 200 bytes.
{ printf '\050\265\057\375\040\310\101\006\000'; head -c 200 /dev/zero; } > "$ZS/dsh/sessions/p/s1/a.zstd"
# s2: frame with no content size (window byte, no FCS), raw last block of 4 bytes.
{ printf '\050\265\057\375\000\000\041\000\000'; printf 'abcd'; } > "$ZS/dsh/sessions/p/s2/a.zstd"
# A zstd on PATH that logs its arguments and the bytes it receives on stdin:
# `--version` succeeds (the CLI counts as available), anything else fails. rdsh
# streams the already-opened file through stdin, so only the size-less s2 frame
# may ever reach `-dc`; the session path never appears in argv.
printf '#!/bin/sh\necho "$*" >> "%s/calls"\ncase "$1" in --version) echo "zstd shim"; exit 0 ;; esac\ncat >> "%s/stdin"\nexit 1\n' "$ZS" "$ZS" > "$ZS/shim/zstd"
chmod +x "$ZS/shim/zstd"
# RDSH_TOKENS_CACHE=0: results must come from the headers, not from a cache hit.
PATH="$ZS/shim:$PATH" RDSH_TOKENS_CACHE=0 DSH_HOME="$ZS/dsh" "$BIN" sessions --tokens --project p --limit 5 > "$ZS/out" 2> "$ZS/err"
if grep "p/s1" "$ZS/out" | grep -q "~50tok " && ! grep "p/s1" "$ZS/out" | grep -q "?"; then ok "sessions --tokens exact from FCS (no ? marker)"; else echo "FAIL(output): sessions --tokens FCS"; cat "$ZS/out"; exit 1; fi
if grep "p/s2" "$ZS/out" | grep -q "?"; then ok "sessions --tokens marks unknown size with ?"; else echo "FAIL(output): sessions --tokens ? marker"; cat "$ZS/out"; exit 1; fi
if grep -q -- "--version" "$ZS/calls" 2>/dev/null; then ok "sessions --tokens probes the zstd CLI"; else echo "FAIL(output): zstd shim never probed with --version"; exit 1; fi
# The piped bytes are the only identity a stdin-streamed child sees: they must
# equal the s2 frame exactly, which also proves s1 (with a content size) was
# never handed to `-dc`.
if [ "$(grep -c -- '^-dc$' "$ZS/calls")" = 1 ] && [ "$(grep -c -- '-dc' "$ZS/calls")" = 1 ]; then ok "one path-free zstd -dc call"; else echo "FAIL: expected one path-free zstd -dc call"; cat "$ZS/calls"; exit 1; fi
if [ -f "$ZS/stdin" ] && cmp -s "$ZS/stdin" "$ZS/dsh/sessions/p/s2/a.zstd"; then ok "zstd -dc streams only the frame without a content size"; else echo "FAIL: zstd -dc must stream exactly the size-less s2 frame"; cat "$ZS/calls" 2>/dev/null; exit 1; fi
if grep -q "zstd CLI not found" "$ZS/err"; then echo "FAIL: zstd note printed although the CLI is available"; exit 1; else ok "no zstd note when the CLI exists"; fi
rm -f "$ZS/shim/zstd"
PATH="$ZS/shim" RDSH_TOKENS_CACHE=0 DSH_HOME="$ZS/dsh" "$BIN" sessions --tokens --project p --limit 5 > "$ZS/out" 2> "$ZS/err"
if grep -q "zstd CLI not found" "$ZS/err" && grep "p/s1" "$ZS/out" | grep -q "~50tok "; then ok "zstd-missing note only when a fallback was needed"; else echo "FAIL(output): zstd missing note"; cat "$ZS/err"; exit 1; fi
rm -rf "$ZS/dsh/sessions/p/s2"
PATH="$ZS/shim" RDSH_TOKENS_CACHE=0 DSH_HOME="$ZS/dsh" "$BIN" sessions --tokens --project p --limit 5 > "$ZS/out" 2> "$ZS/err"
if grep -q "zstd CLI not found" "$ZS/err"; then echo "FAIL: zstd note printed although headers sufficed"; exit 1; else ok "no zstd note when headers suffice"; fi
rm -rf "$ZS"
# --- sessions --tokens cache: a `?` from a zstd-less run must not stick once zstd exists ---
# p (two sessions) takes the batch path, q (one session) the per-session path.
ZC="$RG_TMP/zcache"
mkdir -p "$ZC/dsh/sessions/p/s1" "$ZC/dsh/sessions/p/s2" "$ZC/dsh/sessions/q/s2" "$ZC/nozstd" "$ZC/ok" "$ZC/bad" "$ZC/cache"
{ printf '\050\265\057\375\040\310\101\006\000'; head -c 200 /dev/zero; } > "$ZC/dsh/sessions/p/s1/a.zstd"
for d in p q; do { printf '\050\265\057\375\000\000\041\000\000'; printf 'abcd'; } > "$ZC/dsh/sessions/$d/s2/a.zstd"; done
# ok: a working zstd for the 4-byte raw block; bad: present but `-dc` fails.
printf '#!/bin/sh\ncase "$1" in --version) exit 0 ;; -dc) printf abcd; exit 0 ;; esac\nexit 1\n' > "$ZC/ok/zstd"
printf '#!/bin/sh\ncase "$1" in --version) exit 0 ;; esac\nexit 1\n' > "$ZC/bad/zstd"
chmod +x "$ZC/ok/zstd" "$ZC/bad/zstd"
zc() { PATH="$1" XDG_CACHE_HOME="$ZC/cache" DSH_HOME="$ZC/dsh" "$BIN" sessions --tokens --project "$2" --limit 5 > "$ZC/out" 2> "$ZC/err"; }
for d in p q; do
  zc "$ZC/nozstd" $d
  if grep "$d/s2" "$ZC/out" | grep -q "?"; then ok "tokens cache: $d/s2 is ? without zstd"; else echo "FAIL(output): $d/s2 without zstd"; cat "$ZC/out"; exit 1; fi
  if grep -q '"decomp":null' "$ZC/cache/rdsh/sessions-tokens.json" 2>/dev/null; then echo "FAIL: zstd-less ? cached ($d)"; cat "$ZC/cache/rdsh/sessions-tokens.json"; exit 1; else ok "tokens cache: zstd-less ? not cached ($d)"; fi
  zc "$ZC/ok" $d
  if grep "$d/s2" "$ZC/out" | grep -q "~1tok " && ! grep "$d/s2" "$ZC/out" | grep -q "?"; then ok "tokens cache: $d/s2 resolves once zstd exists"; else echo "FAIL(output): $d/s2 stuck after zstd install"; cat "$ZC/out"; exit 1; fi
done
# Legacy cache (no `cli` field) holding null from an old zstd-less run: recomputed when zstd exists.
rm -rf "$ZC/cache"; mkdir -p "$ZC/cache"
zc "$ZC/bad" q
# Strip `cli` without assuming its position: serde_json emits the cache in
# insertion order, so `cli` may be the last field (no trailing comma) or sorted
# first. A `sed 's/"cli":true,//'` only matches the latter.
python3 - "$ZC/cache/rdsh/sessions-tokens.json" "$ZC/legacy" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    cache = json.load(fh)
for entry in cache.values():
    entry.pop("cli", None)
with open(sys.argv[2], "w", encoding="utf-8") as fh:
    json.dump(cache, fh, separators=(",", ":"))
PY
mv "$ZC/legacy" "$ZC/cache/rdsh/sessions-tokens.json"
if grep -q '"decomp":null' "$ZC/cache/rdsh/sessions-tokens.json" && ! grep -q '"cli"' "$ZC/cache/rdsh/sessions-tokens.json"; then :; else echo "FAIL(setup): legacy null cache"; cat "$ZC/cache/rdsh/sessions-tokens.json"; exit 1; fi
zc "$ZC/ok" q
if grep "q/s2" "$ZC/out" | grep -q "~1tok " && ! grep "q/s2" "$ZC/out" | grep -q "?"; then ok "tokens cache: legacy null entry rechecked with zstd"; else echo "FAIL(output): legacy null entry stuck"; cat "$ZC/out"; exit 1; fi
rm -rf "$ZC"
WB="$RG_TMP/wrapper"
mkdir -p $WB/.local/bin
printf '#!/bin/sh\nexec node "$(readlink -f "$(command -v dsh)")" --profile web\n' > $WB/.local/bin/dsh-web-local
if HOME="$WB" "$BIN" doctor 2>/dev/null | grep -q "dsh-web-local"; then ok "doctor flags node-on-dsh wrapper"; else echo "FAIL(output): doctor flags node-on-dsh wrapper"; exit 1; fi
rm -rf $WB
# Broken wrappers: a dangling dsh symlink or a wrapper pointing at a removed
# node/dsh path must be reported by doctor, and the warnings must not change
# doctor's exit status.
BB="$RR_SANDBOX/broken-bin"
mkdir -p $BB/.local/bin
ln -s "$BB/gone/dsh.js" $BB/.local/bin/dsh-broken
printf '#!/bin/sh\nexec /nonexistent-node/bin/node /nonexistent-dsh/lib/bin.js "$@"\n' > $BB/.local/bin/dsh-dead-node
chmod +x $BB/.local/bin/dsh-dead-node
bout="$(HOME="$BB" "$BIN" doctor 2>/dev/null)"
case "$bout" in *"dsh-broken is a broken symlink"*) ok "doctor flags broken dsh symlink";; *) echo "FAIL(output): broken dsh symlink"; echo "$bout"; exit 1;; esac
case "$bout" in *"dsh-dead-node references /nonexistent-node/bin/node"*) ok "doctor flags wrapper with a removed node/dsh path";; *) echo "FAIL(output): removed node/dsh path"; echo "$bout"; exit 1;; esac
if HOME="$BB" "$BIN" doctor >/dev/null 2>&1; then ok "broken wrapper warnings keep doctor exit 0"; else echo "FAIL(exit): broken wrapper warnings must not fail doctor"; exit 1; fi
rm -rf $BB
# Shadowed dsh without the dsh-orig backup install.sh --restore needs: warn once,
# and stay quiet as soon as the backup exists.
SH="$RR_SANDBOX/shadow-noorig"
mkdir -p $SH/bin $SH/home
cp "$BIN" $SH/bin/dsh
# doctor reports the resolved install dir, which is physical on macOS
# (/var is /private/var there), so accept either spelling of the same dir.
SH_PHYS="$(cd "$SH/bin" && pwd -P)"
sout="$(PATH="$SH/bin:$RR_SANDBOX/original:$PATH" HOME="$SH/home" $SH/bin/dsh doctor 2>/dev/null)"
case "$sout" in *"no dsh-orig backup in $SH/bin"*|*"no dsh-orig backup in $SH_PHYS"*) ok "doctor flags shadowed dsh without a backup";; *) echo "FAIL(output): missing dsh-orig backup"; echo "$sout"; exit 1;; esac
printf '#!/bin/sh\necho stub-dsh-orig\n' > $SH/bin/dsh-orig
chmod +x $SH/bin/dsh-orig
if PATH="$SH/bin:$RR_SANDBOX/original:$PATH" HOME="$SH/home" $SH/bin/dsh doctor 2>/dev/null | grep -q "no dsh-orig backup"; then echo "FAIL(output): an existing dsh-orig must not warn"; exit 1; else ok "doctor accepts an existing dsh-orig backup"; fi
rm -rf $SH
# Install ledger drift: ~/.config/rdsh/origin pointing at a removed backup.
LG="$RR_SANDBOX/ledger"
mkdir -p $LG/home/.config/rdsh
printf '%s\n' "$LG/gone-dsh-orig" > $LG/home/.config/rdsh/origin
if HOME="$LG/home" "$BIN" doctor 2>/dev/null | grep -q "install ledger.*no longer exists"; then ok "doctor flags a stale origin ledger"; else echo "FAIL(output): stale origin ledger"; exit 1; fi
rm -rf $LG
AB="$RR_SANDBOX/auth"
mkdir -p $AB/home/.codex $AB/home/.local/share/opencode $AB/dsh
printf '%s' '{"tokens":{"access_token":"a","refresh_token":"r","account_id":"1"}}' > $AB/home/.codex/auth.json
printf '%s' '{"openai":{"type":"oauth","refresh":"r2","access":"a2","expires":1991708802841,"accountId":"9"}}' > $AB/home/.local/share/opencode/auth.json
if HOME="$AB/home" DSH_HOME="$AB/dsh" "$BIN" auth 2>/dev/null | grep -q "openai-codex"; then ok "auth detects opencode login"; else echo "FAIL(output): auth detects opencode login"; exit 1; fi
if HOME="$AB/home" DSH_HOME="$AB/dsh" "$BIN" auth --import >/dev/null 2>&1; then echo "FAIL: auth import without selection"; exit 1; else ok "auth import requires selection"; fi
if HOME="$AB/home" DSH_HOME="$AB/dsh" "$BIN" --dry-run auth --select opencode:openai-codex --import --json > "${RR_SANDBOX}/rr-out" 2>/dev/null && grep -q '"dry_run":true' "${RR_SANDBOX}/rr-out" && [ ! -f "$AB/dsh/.credentials.yaml" ] && [ ! -f "$AB/dsh/rdsh-auth-sharing.json" ]; then ok "auth sharing preview writes nothing"; else echo "FAIL(output): auth sharing preview"; exit 1; fi
if HOME="$AB/home" DSH_HOME="$AB/dsh" "$BIN" auth --select opencode:openai-codex --import >/dev/null 2>&1 && grep -q "llm-pi-ai/openai-codex" "$AB/dsh/.credentials.yaml"; then ok "auth selected import writes record"; else echo "FAIL(output): auth selected import writes record"; exit 1; fi
if HOME="$AB/home" DSH_HOME="$AB/dsh" "$BIN" auth 2>/dev/null | grep -q "already recognized"; then ok "auth import recognized"; else echo "FAIL(output): auth import recognized"; exit 1; fi
fmode="$(stat -c %a "$AB/dsh/.credentials.yaml" 2>/dev/null || stat -f "%Lp" "$AB/dsh/.credentials.yaml")"
if [ "$fmode" = "600" ]; then ok "auth file mode 600"; else echo "FAIL(mode): auth file mode"; exit 1; fi
if HOME="$AB/home" DSH_HOME="$AB/dsh" "$BIN" setup --json 2>/dev/null | grep -q "\"needed\":false"; then ok "setup connected"; else echo "FAIL(output): setup connected"; exit 1; fi
SB2="$RG_TMP/setup"
mkdir -p $SB2/home $SB2/dsh
if env -u DEEPSEEK_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY HOME="$SB2/home" DSH_HOME="$SB2/dsh" "$BIN" setup --json 2>/dev/null | grep -q "\"needed\":true"; then ok "setup needed on first run"; else echo "FAIL(output): setup needed on first run"; exit 1; fi
# Delegated agent tools default to normal file access; the strict boundary is
# opt-in (--share-file, features.agent_tool_sandbox, or RDSH_SECURITY=1).
if env -u DEEPSEEK_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY HOME="$SB2/home" DSH_HOME="$SB2/dsh" DSH_ORIG_BIN="$SB/orig/dsh" "$SB/bin/dsh" --profile tui 2>&1 | grep -q "RDSH_SECURITY"; then echo "FAIL(output): default delegation must not be refused"; exit 1; else ok "agent tools default to normal file access"; fi
if env -u DEEPSEEK_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY HOME="$SB2/home" DSH_HOME="$SB2/dsh" RDSH_SECURITY=1 DSH_ORIG_BIN="$SB/orig/dsh" "$SB/bin/dsh" --profile tui 2>&1 | grep -q "RDSH_SECURITY"; then ok "strict mode refuses unsupported runtime"; else echo "FAIL(output): strict mode refuses unsupported runtime"; exit 1; fi
rm -rf $SB2
if bash ./tests/installer-release-integrity.sh; then ok "installer release integrity"; else echo "FAIL: installer release integrity"; exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then SUM="sha256sum"; else SUM="shasum -a 256"; fi
if bash tests/rustup-init-pin.sh; then ok "rustup-init pinned checksum"; else echo "FAIL(output): rustup-init pinned checksum"; exit 1; fi
# --- libc asset selection: pinned file:// archives, never release sidecars ---
MS="$RG_TMP/musl"
mkdir -p "$MS/shim" "$MS/rel/download/v9.9.9" "$MS/gnu" "$MS/musl" "$MS/home" "$MS/dsh"
printf '#!/bin/sh\necho "rdsh fixture gnu"\n' > "$MS/gnu/rdsh"
printf '#!/bin/sh\necho "rdsh fixture musl"\n' > "$MS/musl/rdsh"
chmod +x "$MS/gnu/rdsh" "$MS/musl/rdsh"
for a in rdsh-linux-x64 rdsh-linux-x64-musl rdsh-macos-arm64 rdsh-macos-x64; do
  pkg="$MS/gnu"; [ "$a" != rdsh-linux-x64-musl ] || pkg="$MS/musl"
  tar -czf "$MS/rel/download/v9.9.9/$a.tar.gz" -C "$pkg" rdsh
done
{
  printf 'latest v9.9.9\n'
  for a in rdsh-linux-x64 rdsh-linux-x64-musl rdsh-macos-arm64 rdsh-macos-x64; do
    digest="$($SUM "$MS/rel/download/v9.9.9/$a.tar.gz" | awk '{print $1}')"
    printf 'v9.9.9 %s.tar.gz %s\n' "$a" "$digest"
  done
} > "$MS/release-digests.tsv"
printf '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) exec /usr/bin/uname "$@" ;; esac\n' > "$MS/shim/uname"
# Any unexpected network request fails locally instead of contacting GitHub.
cat > "$MS/shim/curl" <<'CURL_PICK_EOF'
#!/bin/sh
out=""; prev=""; url=""
for arg in "$@"; do [ "$prev" != -o ] || out="$arg"; prev="$arg"; case "$arg" in file://*) url="$arg" ;; esac; done
[ -n "$out" ] && [ -n "$url" ] || exit 22
cp "${url#file://}" "$out"
CURL_PICK_EOF
chmod +x "$MS/shim/uname" "$MS/shim/curl"
pick() {
  printf '#!/bin/sh\n%s\n' "$1" > "$MS/shim/getconf"
  printf '#!/bin/sh\n%s\n' "$2" > "$MS/shim/ldd"
  chmod +x "$MS/shim/getconf" "$MS/shim/ldd"
  shift 2
  PATH="$MS/shim:$PATH" HOME="$MS/home" DSH_HOME="$MS/dsh" RDSH_NO_CHECKSUM=0 RDSH_RELEASE_DIGESTS="$MS/release-digests.tsv" RDSH_RELEASE_BASE="file://$MS/rel" bash ./install.sh --from-release --prefix="$MS/prefix" "$@" > "$MS/install.log" 2>&1 || { echo "FAIL(exit): install.sh pick"; tail -n 8 "$MS/install.log"; exit 1; }
  "$MS/prefix/rdsh"
}
# install.sh checks native musl loaders before the getconf/ldd shims. Keep the
# GNU controls on GNU hosts and verify that native musl wins on Alpine, etc.
MS_NEW_GLIBC=gnu
if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then MS_NEW_GLIBC=musl; fi
r="$(pick 'echo "glibc 2.41"' 'exit 1')"
if [ "$r" = "rdsh fixture $MS_NEW_GLIBC" ]; then ok "install: getconf fallback glibc 2.41 picks $MS_NEW_GLIBC"; else echo "FAIL: glibc 2.41 picked $r (want $MS_NEW_GLIBC)"; exit 1; fi
r="$(pick 'echo "glibc 2.31"' 'exit 1')"
if [ "$r" = 'rdsh fixture musl' ]; then ok "install: getconf fallback glibc 2.31 picks musl"; else echo "FAIL: glibc 2.31 picked $r"; exit 1; fi
r="$(pick 'exit 1' 'echo "ldd (Debian GLIBC 2.36-9) 2.36"')"
if [ "$r" = 'rdsh fixture musl' ]; then ok "install: ldd glibc 2.36 below the release floor picks musl"; else echo "FAIL: ldd 2.36 picked $r"; exit 1; fi
r="$(pick 'exit 1' 'echo "ldd (GNU libc) 2.41"')"
if [ "$r" = "rdsh fixture $MS_NEW_GLIBC" ]; then ok "install: ldd glibc 2.41 picks $MS_NEW_GLIBC"; else echo "FAIL: ldd 2.41 picked $r (want $MS_NEW_GLIBC)"; exit 1; fi
r="$(pick 'echo "glibc 2.41"' 'exit 1' --musl)"
if [ "$r" = 'rdsh fixture musl' ]; then ok "install: --musl forces musl"; else echo "FAIL: --musl picked $r"; exit 1; fi
rm -rf "$MS"
printf "version: 1\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: api-key\n    key: sk-user-key\n" > "$AB/dsh/.credentials.yaml"
if HOME="$AB/home" DSH_HOME="$AB/dsh" "$BIN" auth --import --provider openai-codex >/dev/null 2>&1 && grep -q "kind: api-key" "$AB/dsh/.credentials.yaml" && HOME="$AB/home" DSH_HOME="$AB/dsh" "$BIN" auth 2>/dev/null | grep -q "left alone"; then ok "auth keeps api-key records"; else echo "FAIL(output): auth keeps api-key records"; exit 1; fi
# sync-dsh.sh release self-update against a file:// release with npm/node shims.
# The script runs from a copy (no tests/regress.sh or target/ next to it), so it
# does not recurse into this suite.
# Issue #303: the expected digest comes from the pinned repository registry,
# served here by a curl shim, and the release base holds no .sha256 at all.
if bash ./tests/sync-release-integrity.sh; then ok "sync-dsh release integrity"; else echo "FAIL: sync-dsh release integrity"; exit 1; fi
FS="$RR_SANDBOX/sync-release"
rm -rf $FS
mkdir -p $FS/pkg $FS/rel/download/v9.9.9 $FS/repo $FS/shim $FS/home/.local/bin $FS/npmroot/@deepseek-ai/dsh $FS/bin
cp "$BIN" $FS/pkg/rdsh
cp ./sync-dsh.sh $FS/repo/sync-dsh.sh
for a in rdsh-linux-x64 rdsh-linux-x64-musl rdsh-macos-arm64 rdsh-macos-x64; do
  # Distinct payloads expose accidental reuse of one platform's checksum,
  # including on GNU tar hosts where repeated archives can be identical.
  printf '%s\n' "$a" > "$FS/pkg/fixture-platform.txt"
  tar -czf "$FS/rel/download/v9.9.9/$a.tar.gz" -C "$FS/pkg" rdsh fixture-platform.txt
done
printf '{"version":"1.0.0"}\n' > $FS/npmroot/@deepseek-ai/dsh/package.json
printf '#!/bin/sh\ncase "$1" in root) echo "%s" ;; view) echo "[\\"1.0.0\\"]" ;; *) exit 1 ;; esac\n' "$FS/npmroot" > $FS/npm
NODE_REAL="$(node -p 'process.execPath')" || exit 1
ln -s "$NODE_REAL" "$FS/home/.local/bin/rdsh-test-node"
printf '#!/bin/sh\ncase "$1" in -p) echo 1.0.0 ;; *) exec "$(dirname "$0")/rdsh-test-node" "$@" ;; esac\n' > $FS/home/.local/bin/node
CURL_BIN="$(command -v curl)"
cat > $FS/shim/curl <<CURL_EOF
#!/bin/sh
out=""; prev=""; url=""
for arg in "\$@"; do
  [ "\$prev" = "-o" ] && out="\$arg"
  prev="\$arg"; url="\$arg"
done
if [ -n "\$out" ] && [ "\$url" = "https://raw.githubusercontent.com/jimoto-no-llm/rustdsh/main/release-digests.tsv" ]; then
  cp "$FS/release-digests.tsv" "\$out"; exit 0
fi
exec "$CURL_BIN" "\$@"
CURL_EOF
chmod +x $FS/shim/curl $FS/npm $FS/home/.local/bin/node
manifest() {
  {
    printf 'latest v9.9.9\n'
    for a in rdsh-linux-x64 rdsh-linux-x64-musl rdsh-macos-arm64 rdsh-macos-x64; do
      if [ "$#" -gt 0 ]; then
        digest="$1"
      else
        digest="$($SUM "$FS/rel/download/v9.9.9/$a.tar.gz" | awk '{print $1}')"
      fi
      printf 'v9.9.9 %s.tar.gz %s\n' "$a" "$digest"
    done
  } > "$FS/release-digests.tsv"
}
manifest
# RDSH_SYNC_SELF_UPDATE=0: these cases pin the script copy under test, so it
# must not fetch a newer copy of itself from the origin.
fs_sync() { env -u RDSH_SYNC_FROM_SOURCE -u RDSH_MUSL RDSH_SYNC_SELF_UPDATE=0 HOME="$FS/home" NPM_BIN="$FS/npm" PREFIX_BIN="$1" RDSH_RELEASE_BASE="file://$FS/rel" RDSH_TEST_INSECURE_BASE=1 RDSH_SYNC_VERSION="${3:-latest}" PATH="$FS/shim:$PATH" sh $FS/repo/sync-dsh.sh > "$2" 2>&1; }
fs_sync "$FS/bin" $FS/sync-ok.log
if grep -q "checksum ok" $FS/sync-ok.log && grep -q "rdsh updated OK via release binary" $FS/sync-ok.log && "$FS/bin/rdsh" --version 2>/dev/null | grep -q "rdsh"; then ok "sync-dsh release update with pinned digest"; else echo "FAIL(output): sync-dsh release update with pinned digest"; tail -n 8 $FS/sync-ok.log; exit 1; fi
# A no-op check must not masquerade as a new update and restart notification time.
printf '{"updated":true,"kind":"DUMMY","to":"previous","at":1}\n' > "$FS/home/.local/share/rdsh/update-state.json"
cp "$FS/home/.local/share/rdsh/update-state.json" "$FS/state-noop.json"
fs_sync "$FS/bin" "$FS/sync-noop.log"
if grep -q "checksum ok" "$FS/sync-noop.log" && grep -q "rdsh up to date (release binary unchanged)" "$FS/sync-noop.log" && cmp -s "$FS/state-noop.json" "$FS/home/.local/share/rdsh/update-state.json"; then ok "sync-dsh unchanged release preserves notification state"; else echo "FAIL(output): unchanged release rewrote notification state"; exit 1; fi
# Version labels alone cannot identify rebuilt payloads; different bytes still update.
SYNC_VERSION="$("$FS/pkg/rdsh" --version)"
printf '#!/bin/sh\nprintf "%%s\\n" "%s"\n' "$SYNC_VERSION" > "$FS/bin/rdsh"
chmod +x "$FS/bin/rdsh"
fs_sync "$FS/bin" "$FS/sync-rebuilt.log"
if grep -q "rdsh updated OK via release binary" "$FS/sync-rebuilt.log" && cmp -s "$FS/pkg/rdsh" "$FS/bin/rdsh" && ! cmp -s "$FS/state-noop.json" "$FS/home/.local/share/rdsh/update-state.json"; then ok "sync-dsh changed payload updates even with the same version label"; else echo "FAIL(output): rebuilt release was suppressed by its version label"; exit 1; fi
# A registry pin that does not match the bytes refuses the update.
manifest "$(printf '%064d' 0)"
printf 'old\n' > $FS/bin/rdsh
# This scenario checks a selected pin independently of automatic version
# comparison: the deliberately invalid installed marker has no SemVer.
fs_sync "$FS/bin" $FS/sync-bad.log v9.9.9
if grep -q "CHECKSUM MISMATCH" $FS/sync-bad.log && grep -q "binaries untouched" $FS/sync-bad.log && [ "$(cat $FS/bin/rdsh)" = "old" ]; then ok "sync-dsh refuses mismatched pinned digest"; else echo "FAIL(output): sync-dsh refuses mismatched pinned digest"; tail -n 8 $FS/sync-bad.log; exit 1; fi
# A version without a registry row is refused; there is no sidecar fallback.
manifest
fs_sync "$FS/bin" $FS/sync-none.log v9.9.8
if grep -q "no pinned checksum for release v9.9.8" $FS/sync-none.log && grep -q "binaries untouched" $FS/sync-none.log && [ "$(cat $FS/bin/rdsh)" = "old" ]; then ok "sync-dsh refuses a release without a pinned digest"; else echo "FAIL(output): sync-dsh refuses a release without a pinned digest"; tail -n 8 $FS/sync-none.log; exit 1; fi
# An unparsable registry refuses the update instead of falling back to the base.
: > $FS/release-digests.tsv
fs_sync "$FS/bin" $FS/sync-empty.log
if grep -q "trusted release digest registry is invalid" $FS/sync-empty.log && grep -q "binaries untouched" $FS/sync-empty.log && [ "$(cat $FS/bin/rdsh)" = "old" ]; then ok "sync-dsh refuses an invalid digest registry"; else echo "FAIL(output): sync-dsh refuses an invalid digest registry"; tail -n 8 $FS/sync-empty.log; exit 1; fi
rm -rf $FS
SW="$RR_SANDBOX/setupweb"
mkdir -p $SW/home $SW/dsh
HOME="$SW/home" DSH_HOME="$SW/dsh" "$BIN" setup --web --port 38082 >/dev/null 2>"$SW/setup.log" & SRV=$!
SETUP_TOKEN=""
SETUP_TOKEN_FILE=""
i=0
while [ -z "$SETUP_TOKEN" ] && [ "$i" -lt 10 ]; do
  sleep 1
  SETUP_TOKEN_FILE=$(sed -n 's/^\[rdsh setup\] token handoff file: //p' "$SW/setup.log" | head -n 1)
  if [ -n "$SETUP_TOKEN_FILE" ] && [ -f "$SETUP_TOKEN_FILE" ]; then SETUP_TOKEN=$(cat "$SETUP_TOKEN_FILE"); fi
  kill -0 "$SRV" 2>/dev/null || break
  i=$((i+1))
done
if [ -z "$SETUP_TOKEN" ] || grep -q '#key=' "$SW/setup.log"; then echo "FAIL(output): setup --web token handoff"; kill $SRV 2>/dev/null; exit 1; fi
HANDOFF_MODE=$(stat -c '%a' "$SETUP_TOKEN_FILE" 2>/dev/null || stat -f '%Lp' "$SETUP_TOKEN_FILE")
if [ "$HANDOFF_MODE" != "600" ]; then echo "FAIL(mode): setup token handoff file is not 0600"; kill $SRV 2>/dev/null; exit 1; fi
if [ "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:38082/api/status)" = "401" ]; then ok "setup --web status requires key"; else echo "FAIL(output): setup --web unauthed status"; kill $SRV 2>/dev/null; exit 1; fi
if curl -fsS --max-time 5 -H "X-RDSH-Token: $SETUP_TOKEN" http://127.0.0.1:38082/api/status 2>/dev/null | grep -q "\"needed\":true"; then ok "setup --web status"; else echo "FAIL(output): setup --web status"; kill $SRV 2>/dev/null; exit 1; fi
cat > "$SW/dsh/.credentials.yaml" <<'YAML'
version: 1
refs:
  EXISTING_KEY: 'existing-value'
records:
  llm-pi-ai/existing:
    kind: grant
    payload:
      access: 'saved-token'
YAML
if printf "%s" "{\"name\":\"DEEPSEEK_API_KEY\",\"value\":\"true\"}" | curl -fsS --max-time 5 -X POST -H "Content-Type: application/json" -H "X-RDSH-Token: $SETUP_TOKEN" --data-binary "@-" http://127.0.0.1:38082/api/key 2>/dev/null | grep -q "\"stored\":true" && grep -q "^  DEEPSEEK_API_KEY: 'true'$" "$SW/dsh/.credentials.yaml" && grep -q "EXISTING_KEY: 'existing-value'" "$SW/dsh/.credentials.yaml" && grep -q "access: 'saved-token'" "$SW/dsh/.credentials.yaml"; then ok "setup --web stores YAML string and preserves existing credentials"; else echo "FAIL(output): setup --web key store"; kill $SRV 2>/dev/null; exit 1; fi
curl -fsS --max-time 5 -X POST -H "X-RDSH-Token: $SETUP_TOKEN" --data-binary '{}' http://127.0.0.1:38082/api/done >/dev/null 2>&1
wait $SRV 2>/dev/null || true
if [ -e "$SETUP_TOKEN_FILE" ]; then echo "FAIL(cleanup): setup token handoff file remains after server exit"; exit 1; fi
rm -rf $SW
SWB="$RR_SANDBOX/searchweb"
mkdir -p $SWB
printf "%s" "<html><body><article class=\"result\"><h3><a href=\"https://example.com/a\">Alpha result</a></h3><p class=\"content\">first snippet</p></article><article class=\"result\"><h3><a href=\"https://example.com/b\">Beta result</a></h3></article></body></html>" > $SWB/fixture.html
python3 - "$SWB/fixture.html" "$SWB/port" <<PYEOF >"$SWB/server.out" 2>"$SWB/server.err" &
import http.server, socketserver, sys
page = open(sys.argv[1], "rb").read()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = page if self.path.startswith("/search") else b"nope"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True
    def log_message(self, *a):
        pass
# Keep this loopback fixture independent of reverse DNS availability.
class S(http.server.HTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]
server = S(("127.0.0.1", 0), H)
with open(sys.argv[2], "w") as portfile:
    portfile.write(str(server.server_address[1]))
server.serve_forever()
PYEOF
HTTPSRV=$!
i=0
until [ -s "$SWB/port" ]; do
  i=$((i+1)); [ "$i" -ge 10 ] && break
  kill -0 "$HTTPSRV" 2>/dev/null || break
  sleep 1
done
if [ ! -s "$SWB/port" ] || ! kill -0 "$HTTPSRV" 2>/dev/null; then
  echo "FAIL: search-web fixture did not start"; cat "$SWB/server.err"; kill "$HTTPSRV" 2>/dev/null; exit 1
fi
SWB_PORT="$(cat "$SWB/port")"
if ! curl -fsS --max-time 2 "http://127.0.0.1:$SWB_PORT/" >/dev/null 2>&1; then
  echo "FAIL: search-web fixture is not ready"; cat "$SWB/server.err"; kill "$HTTPSRV" 2>/dev/null; exit 1
fi
if "$BIN" search-web "hello world" 2>&1 | grep -q "disabled by default"; then ok "search-web refused while extra off"; else echo "FAIL(output): extras gate"; kill $HTTPSRV 2>/dev/null; exit 1; fi
"$BIN" settings set extras.enable search-web >/dev/null 2>&1
if SEARXNG_URL="http://127.0.0.1:$SWB_PORT" "$BIN" search-web "hello world" --limit 5 >"$SWB/search.out" 2>"$SWB/search.err" && grep -q "Alpha result" "$SWB/search.out"; then ok "search-web via fixture"; else echo "FAIL(output): search-web via fixture"; cat "$SWB/search.err" "$SWB/server.err"; kill $HTTPSRV 2>/dev/null; exit 1; fi
kill $HTTPSRV 2>/dev/null
wait $HTTPSRV 2>/dev/null || true
rm -rf $SWB
if bash ./install.sh --help 2>/dev/null | grep -q -- "--musl"; then ok "install.sh documents --musl"; else echo "FAIL(output): install.sh documents --musl"; exit 1; fi
if grep -q "RDSH_SYNC_FROM_SOURCE" ./sync-dsh.sh && grep -q "sandboxed_regress" ./sync-dsh.sh; then ok "sync-dsh release-first + sandboxed regress"; else echo "FAIL(output): sync-dsh release-first + sandboxed regress"; exit 1; fi
if [ "${RDSH_REGRESS_SANDBOXED:-}" = 1 ] && [ -n "${RR_SANDBOX:-}" ] && [ "$HOME" = "$RR_SANDBOX/home" ] && [ "$DSH_HOME" = "$RR_SANDBOX/dsh" ]; then ok "regress sandboxed HOME"; else echo "FAIL(output): regress sandboxed HOME"; exit 1; fi
rm -rf $AB
rm -rf $SB "$RG_TMP/rr-in.txt" "$RG_TMP/rr-out" "$RG_TMP/rr-err"
echo "ALL PASS ($pass checks)"
