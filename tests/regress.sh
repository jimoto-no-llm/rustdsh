#!/bin/sh
# rdsh CLI regression. Fails on first mismatch (set -e + explicit checks).
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
need_grep "rdsh" "version string" $BIN --version
need_ok "doctor" $BIN doctor
printf "hello world, this is a token test" | $BIN tokens > "$RG_TMP/rr-out" 2>/dev/null
if grep -q "\"tokens\": 9" "$RG_TMP/rr-out"; then ok "tokens stdin"; else echo "FAIL(output): tokens stdin"; exit 1; fi
need_ok "search" $BIN search estimate_tokens --dir src --max 5
need_ok "profiles" $BIN profiles
need_ok "skills" $BIN skills
need_ok "logs" $BIN logs --tail 3
need_ok "sessions" $BIN sessions --limit 2
need_ok "dump-native" $BIN dump-config --profile tui --native
need_ok "boot dry-run" $BIN --dry-run tui
printf "ls /tmp" | $BIN guard --deny "zzz-no-match" > /dev/null
if [ $? -eq 0 ]; then ok "guard allow"; else echo "FAIL: guard allow"; exit 1; fi
printf "run this" | $BIN guard --deny "run*" > /dev/null 2>&1
if [ $? -eq 2 ]; then ok "guard block"; else echo "FAIL: guard block"; exit 1; fi
need_exit 2 "reject desktop" $BIN desktop
need_exit 2 "reject double profile" $BIN --profile a --profile b
need_exit 2 "reject dump with args" $BIN --profile tui --dump-config --foo
need_exit 2 "reject plugin w/o args" $BIN plugin --profile tui
need_grep "plugin" "plugin delegation dry-run" $BIN --dry-run plugin --profile web add ./dsh-notify-push
need_grep "smart-dsh" "doctor reports smart-dsh" $BIN doctor
python3 -c "print(5791 * 4)" | $BIN tokens > /dev/null
printf "FROMSTDIN" > "$RG_TMP/rr-in.txt"
need_ok "compact noop" $BIN compact "$RG_TMP/rr-in.txt" --max-tokens 8000
SB="$RG_TMP/delegate"
mkdir -p $SB/bin $SB/orig
cat > $SB/orig/dsh << FAKEEOF
#!/bin/sh
echo FAKE-ORIG
FAKEEOF
chmod +x $SB/orig/dsh
cp "$BIN" $SB/bin/dsh
if RDSH_AUTH_AUTOSYNC=0 PATH="$SB/bin:$SB/orig:$PATH" DSH_ORIG_BIN="$SB/orig/dsh" $SB/bin/dsh --version | grep -q FAKE-ORIG; then ok "dsh-mode delegates"; else echo "FAIL: dsh-mode delegates"; exit 1; fi
if RDSH_AUTH_AUTOSYNC=0 PATH="$SB/bin:$SB/orig:$PATH" DSH_ORIG_BIN="$SB/orig/dsh" $SB/bin/dsh doctor | grep -q rdsh; then ok "dsh-mode native"; else echo "FAIL: dsh-mode native"; exit 1; fi
if RDSH_AUTH_AUTOSYNC=0 PATH="$SB/bin:$SB/orig:$PATH" RDSH_ORIG_BIN="$SB/orig/dsh" $SB/bin/dsh --version | grep -q FAKE-ORIG; then ok "RDSH_ORIG_BIN primary"; else echo "FAIL: RDSH_ORIG_BIN primary"; exit 1; fi
# --- default profile: dsh >= 0.2.0 no longer ships `tui` ---
DP=$RG_TMP/dp
mkdir -p "$DP/empty" "$DP/withtui/profiles/tui"
dp_dry() { env -u RDSH_DEFAULT_PROFILE DSH_ORIG_BIN="$SB/orig/dsh" "$@"; }
dp_dry DSH_HOME="$DP/empty" $BIN --dry-run boot >"$DP/out" 2>"$DP/err"; code=$?
if [ "$code" = 1 ] && grep -q "no profile specified" "$DP/err" && grep -q "headless" "$DP/err" && grep -q "RDSH_DEFAULT_PROFILE=" "$DP/err"; then ok "no profile + no tui dir: guided error"; else echo "FAIL(exit $code want 1): no default profile guidance"; cat "$DP/err"; exit 1; fi
dp_dry DSH_HOME="$DP/empty" $BIN dump-config --native >"$DP/out" 2>"$DP/err"; code=$?
if [ "$code" = 1 ] && grep -q "no profile specified" "$DP/err"; then ok "dump-config without profile: guided error"; else echo "FAIL(exit $code want 1): dump-config default"; cat "$DP/err"; exit 1; fi
if dp_dry DSH_HOME="$DP/empty" RDSH_DEFAULT_PROFILE=web $BIN --dry-run boot 2>/dev/null | grep -q '"--profile" "web"'; then ok "RDSH_DEFAULT_PROFILE=web dry-run shows --profile web"; else echo "FAIL(output): RDSH_DEFAULT_PROFILE"; exit 1; fi
if dp_dry DSH_HOME="$DP/withtui" $BIN --dry-run boot 2>/dev/null | grep -q '"--profile" "tui"'; then ok "local tui profile dir keeps tui as default"; else echo "FAIL(output): tui dir default"; exit 1; fi
if dp_dry DSH_HOME="$DP/withtui" RDSH_DEFAULT_PROFILE=headless $BIN --dry-run boot 2>/dev/null | grep -q '"--profile" "headless"'; then ok "RDSH_DEFAULT_PROFILE beats local tui dir"; else echo "FAIL(output): env beats tui dir"; exit 1; fi
# general.default_profile (rdsh.json under DSH_HOME): beats the local tui dir, loses to the env var.
mkdir -p "$DP/cfg/profiles/tui"
DSH_HOME="$DP/cfg" $BIN settings set general.default_profile headless >/dev/null 2>&1
if dp_dry DSH_HOME="$DP/cfg" $BIN --dry-run boot 2>/dev/null | grep -q '"--profile" "headless"'; then ok "general.default_profile beats local tui dir"; else echo "FAIL(output): settings default_profile beats tui dir"; exit 1; fi
if dp_dry DSH_HOME="$DP/cfg" RDSH_DEFAULT_PROFILE=web $BIN --dry-run boot 2>/dev/null | grep -q '"--profile" "web"'; then ok "RDSH_DEFAULT_PROFILE beats general.default_profile"; else echo "FAIL(output): env beats settings default_profile"; exit 1; fi
if dp_dry DSH_HOME="$DP/empty" $BIN --dry-run --profile tui 2>/dev/null | grep -q '"--profile" "tui"' && dp_dry DSH_HOME="$DP/empty" $BIN --dry-run tui 2>/dev/null | grep -q '"--profile" "tui"'; then ok "explicit tui passes through verbatim"; else echo "FAIL(output): explicit tui passthrough"; exit 1; fi
# --- slim: Node compile cache (the part of slim that really speeds up Node boot) ---
# Default dir is $HOME/.cache/rdsh-node-compile-cache (XDG_CACHE_HOME is not consulted).
CC="$RG_TMP/cc"
mkdir -p "$CC/home" "$CC/dsh" "$CC/home-pt"
cat > "$CC/envdsh" << 'ENVEOF'
#!/bin/sh
echo "CACHE=${NODE_COMPILE_CACHE:-unset} HINT=${RDSH_SLIM:-unset}"
ENVEOF
chmod +x "$CC/envdsh"
CCDEF="$CC/home/.cache/rdsh-node-compile-cache"
if env -u NODE_COMPILE_CACHE -u RDSH_NODE_COMPILE_CACHE HOME="$CC/home" DSH_ORIG_BIN="$SB/orig/dsh" $BIN --dry-run tui 2>/dev/null | grep -q "NODE_COMPILE_CACHE=\"$CCDEF\""; then ok "slim dry-run shows NODE_COMPILE_CACHE"; else echo "FAIL(output): slim dry-run shows NODE_COMPILE_CACHE"; exit 1; fi
if env -u NODE_COMPILE_CACHE HOME="$CC/home-pt" DSH_ORIG_BIN="$SB/orig/dsh" $BIN --dry-run --passthrough tui 2>/dev/null | grep -q "NODE_COMPILE_CACHE\|RDSH_SLIM"; then echo "FAIL: --passthrough must add no env"; exit 1; else ok "passthrough adds no env"; fi
if [ ! -e "$CC/home-pt/.cache" ]; then ok "passthrough does not create the cache dir"; else echo "FAIL: passthrough created the cache dir"; exit 1; fi
if env -u NODE_COMPILE_CACHE HOME="$CC/home" RDSH_PASSTHROUGH=1 DSH_ORIG_BIN="$SB/orig/dsh" $BIN --dry-run tui 2>/dev/null | grep -q "NODE_COMPILE_CACHE"; then echo "FAIL: RDSH_PASSTHROUGH=1 must add no env"; exit 1; else ok "RDSH_PASSTHROUGH=1 adds no cache env"; fi
if env -u NODE_COMPILE_CACHE HOME="$CC/home" RDSH_NODE_COMPILE_CACHE=0 DSH_ORIG_BIN="$SB/orig/dsh" $BIN --dry-run tui 2>/dev/null | grep -q 'NODE_COMPILE_CACHE="'; then echo "FAIL: RDSH_NODE_COMPILE_CACHE=0 opt-out ignored"; exit 1; else ok "RDSH_NODE_COMPILE_CACHE=0 opts out"; fi
# A value the user already exports is left alone: rdsh adds nothing to the exec line.
if NODE_COMPILE_CACHE=/tmp/rdsh-mine HOME="$CC/home" DSH_ORIG_BIN="$SB/orig/dsh" $BIN --dry-run tui 2>/dev/null | grep "would exec" | grep -q 'NODE_COMPILE_CACHE='; then echo "FAIL: user NODE_COMPILE_CACHE must not be overridden (dry-run)"; exit 1; else ok "user NODE_COMPILE_CACHE respected (dry-run)"; fi
if NODE_COMPILE_CACHE=/tmp/rdsh-mine HOME="$CC/home" DSH_HOME="$CC/dsh" DSH_ORIG_BIN="$CC/envdsh" "$SB/bin/dsh" --version 2>/dev/null | grep -q "CACHE=/tmp/rdsh-mine "; then ok "metadata exec passes the user's NODE_COMPILE_CACHE through"; else echo "FAIL(output): metadata exec must keep the user's NODE_COMPILE_CACHE"; exit 1; fi
# Real exec (not dry-run): the child sees the default value and the directory exists.
# (The dry-runs above already made it, so start from a clean slate.)
rm -rf "$CC/home/.cache"
if env -u NODE_COMPILE_CACHE HOME="$CC/home" DSH_HOME="$CC/dsh" DSH_ORIG_BIN="$CC/envdsh" "$SB/bin/dsh" --version 2>/dev/null | grep -q "CACHE=$CCDEF " && [ -d "$CCDEF" ]; then ok "metadata exec exports NODE_COMPILE_CACHE and creates the dir"; else echo "FAIL(output): metadata exec exports NODE_COMPILE_CACHE"; exit 1; fi
rm -rf "$CC/home/.cache"
if env -u NODE_COMPILE_CACHE HOME="$CC/home" DSH_HOME="$CC/dsh" DSH_ORIG_BIN="$CC/envdsh" $BIN tui > "$CC/out" 2> "$CC/err"; then echo "FAIL: unsupported agent runtime executed"; exit 1; elif grep -q "RDSH_SECURITY" "$CC/err" && [ ! -d "$CCDEF" ]; then ok "unsupported agent boot refuses before creating a cache"; else echo "FAIL: unsupported agent boot cache side effect"; cat "$CC/err"; exit 1; fi
rm -rf "$CC"
# --- doctor on a host with no Node/dsh: fails with a clear error ---
ND="$RG_TMP/nodsh"
mkdir -p "$ND/home"
env -u RDSH_ORIG_BIN -u DSH_ORIG_BIN HOME="$ND/home" PATH="/nonexistent" $BIN doctor > "$ND/out" 2> "$ND/err"
code=$?
if [ "$code" = 1 ] && grep -q "original 'dsh' not found" "$ND/err"; then ok "doctor exits 1 when original dsh is missing"; else echo "FAIL(output): doctor missing-dsh error (exit $code)"; cat "$ND/err"; exit 1; fi
rm -rf "$ND"
# --- sessions --tokens: exact size from zstd frame headers when recorded, zstd CLI only otherwise ---
ZS="$RG_TMP/zst"
mkdir -p "$ZS/dsh/sessions/p/s1" "$ZS/dsh/sessions/p/s2" "$ZS/shim"
# s1: one frame, single-segment, FCS=200 (0xC8), one raw last block of 200 bytes.
{ printf '\050\265\057\375\040\310\101\006\000'; head -c 200 /dev/zero; } > "$ZS/dsh/sessions/p/s1/a.zstd"
# s2: frame with no content size (window byte, no FCS), raw last block of 4 bytes.
{ printf '\050\265\057\375\000\000\041\000\000'; printf 'abcd'; } > "$ZS/dsh/sessions/p/s2/a.zstd"
# A zstd on PATH that logs its arguments: `--version` succeeds (the CLI counts as
# available), anything else fails. Only the size-less s2 may be handed to `-dc`.
printf '#!/bin/sh\necho "$*" >> "%s/calls"\ncase "$1" in --version) echo "zstd shim"; exit 0 ;; esac\nexit 1\n' "$ZS" > "$ZS/shim/zstd"
chmod +x "$ZS/shim/zstd"
# RDSH_TOKENS_CACHE=0: results must come from the headers, not from a cache hit.
PATH="$ZS/shim:$PATH" RDSH_TOKENS_CACHE=0 DSH_HOME="$ZS/dsh" $BIN sessions --tokens --project p --limit 5 > "$ZS/out" 2> "$ZS/err"
if grep "p/s1" "$ZS/out" | grep -q "~50tok " && ! grep "p/s1" "$ZS/out" | grep -q "?"; then ok "sessions --tokens exact from FCS (no ? marker)"; else echo "FAIL(output): sessions --tokens FCS"; cat "$ZS/out"; exit 1; fi
if grep "p/s2" "$ZS/out" | grep -q "?"; then ok "sessions --tokens marks unknown size with ?"; else echo "FAIL(output): sessions --tokens ? marker"; cat "$ZS/out"; exit 1; fi
if grep -q -- "--version" "$ZS/calls" 2>/dev/null; then ok "sessions --tokens probes the zstd CLI"; else echo "FAIL(output): zstd shim never probed with --version"; exit 1; fi
if grep -- "-dc" "$ZS/calls" | grep -q "/p/s1/"; then echo "FAIL: zstd -dc spawned for a frame with a content size"; cat "$ZS/calls"; exit 1; else ok "no zstd -dc for frames with a content size"; fi
if grep -- "-dc" "$ZS/calls" | grep -q "/p/s2/"; then ok "zstd -dc only for the frame without a content size"; else echo "FAIL: zstd -dc not used for s2"; cat "$ZS/calls" 2>/dev/null; exit 1; fi
if grep -q "zstd CLI not found" "$ZS/err"; then echo "FAIL: zstd note printed although the CLI is available"; exit 1; else ok "no zstd note when the CLI exists"; fi
rm -f "$ZS/shim/zstd"
PATH="$ZS/shim" RDSH_TOKENS_CACHE=0 DSH_HOME="$ZS/dsh" $BIN sessions --tokens --project p --limit 5 > "$ZS/out" 2> "$ZS/err"
if grep -q "zstd CLI not found" "$ZS/err" && grep "p/s1" "$ZS/out" | grep -q "~50tok "; then ok "zstd-missing note only when a fallback was needed"; else echo "FAIL(output): zstd missing note"; cat "$ZS/err"; exit 1; fi
rm -rf "$ZS/dsh/sessions/p/s2"
PATH="$ZS/shim" RDSH_TOKENS_CACHE=0 DSH_HOME="$ZS/dsh" $BIN sessions --tokens --project p --limit 5 > "$ZS/out" 2> "$ZS/err"
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
zc() { PATH="$1" XDG_CACHE_HOME="$ZC/cache" DSH_HOME="$ZC/dsh" $BIN sessions --tokens --project "$2" --limit 5 > "$ZC/out" 2> "$ZC/err"; }
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
sed 's/"cli":true,//g' "$ZC/cache/rdsh/sessions-tokens.json" > "$ZC/legacy" && mv "$ZC/legacy" "$ZC/cache/rdsh/sessions-tokens.json"
if grep -q '"decomp":null' "$ZC/cache/rdsh/sessions-tokens.json" && ! grep -q '"cli"' "$ZC/cache/rdsh/sessions-tokens.json"; then :; else echo "FAIL(setup): legacy null cache"; cat "$ZC/cache/rdsh/sessions-tokens.json"; exit 1; fi
zc "$ZC/ok" q
if grep "q/s2" "$ZC/out" | grep -q "~1tok " && ! grep "q/s2" "$ZC/out" | grep -q "?"; then ok "tokens cache: legacy null entry rechecked with zstd"; else echo "FAIL(output): legacy null entry stuck"; cat "$ZC/out"; exit 1; fi
rm -rf "$ZC"
WB="$RG_TMP/wrapper"
mkdir -p $WB/.local/bin
printf '#!/bin/sh\nexec node "$(readlink -f "$(command -v dsh)")" --profile web\n' > $WB/.local/bin/dsh-web-local
if HOME="$WB" $BIN doctor 2>/dev/null | grep -q "dsh-web-local"; then ok "doctor flags node-on-dsh wrapper"; else echo "FAIL(output): doctor flags node-on-dsh wrapper"; exit 1; fi
rm -rf $WB
AB="$RG_TMP/auth"
mkdir -p $AB/home/.codex $AB/home/.local/share/opencode $AB/dsh
printf '%s' '{"tokens":{"access_token":"a","refresh_token":"r","account_id":"1"}}' > $AB/home/.codex/auth.json
printf '%s' '{"openai":{"type":"oauth","refresh":"r2","access":"a2","expires":1991708802841,"accountId":"9"}}' > $AB/home/.local/share/opencode/auth.json
if HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN auth 2>/dev/null | grep -q "openai-codex"; then ok "auth detects opencode login"; else echo "FAIL(output): auth detects opencode login"; exit 1; fi
if HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN auth --import --provider openai-codex >/dev/null 2>&1 && grep -q "llm-pi-ai/openai-codex" "$AB/dsh/.credentials.yaml"; then ok "auth import writes record"; else echo "FAIL(output): auth import writes record"; exit 1; fi
if HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN auth 2>/dev/null | grep -q "already recognized"; then ok "auth import recognized"; else echo "FAIL(output): auth import recognized"; exit 1; fi
fmode="$(stat -c %a "$AB/dsh/.credentials.yaml" 2>/dev/null || stat -f "%Lp" "$AB/dsh/.credentials.yaml")"
if [ "$fmode" = "600" ]; then ok "auth file mode 600"; else echo "FAIL(mode): auth file mode"; exit 1; fi
if HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN setup --json 2>/dev/null | grep -q "\"needed\":false"; then ok "setup connected"; else echo "FAIL(output): setup connected"; exit 1; fi
SB2="$RG_TMP/setup"
mkdir -p $SB2/home $SB2/dsh
if env -u DEEPSEEK_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY HOME="$SB2/home" DSH_HOME="$SB2/dsh" $BIN setup --json 2>/dev/null | grep -q "\"needed\":true"; then ok "setup needed on first run"; else echo "FAIL(output): setup needed on first run"; exit 1; fi
if env -u DEEPSEEK_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY HOME="$SB2/home" DSH_HOME="$SB2/dsh" DSH_ORIG_BIN="$SB/orig/dsh" $SB/bin/dsh --profile tui 2>&1 | grep -q "RDSH_SECURITY"; then ok "unsupported runtime refused"; else echo "FAIL(output): unsupported runtime refused"; exit 1; fi
rm -rf $SB2
FR="$RR_SANDBOX/release"
mkdir -p $FR/pkg $FR/bin $FR/latest/download
cp "$BIN" $FR/pkg/rdsh
for a in rdsh-linux-x64 rdsh-macos-arm64 rdsh-macos-x64; do tar -czf "$FR/latest/download/$a.tar.gz" -C $FR/pkg rdsh; done
if command -v sha256sum >/dev/null 2>&1; then SUM="sha256sum"; else SUM="shasum -a 256"; fi
for a in rdsh-linux-x64 rdsh-macos-arm64 rdsh-macos-x64; do (cd "$FR/latest/download" && $SUM "$a.tar.gz" > "$a.tar.gz.sha256"); done
# NOTE: install.sh needs bash (pipefail); `sh` is dash on Ubuntu CI.
if RDSH_RELEASE_BASE="file://$FR" DSH_HOME="$FR/dsh" bash ./install.sh --from-release --prefix="$FR/bin" >$FR/install.log 2>&1 && "$FR/bin/rdsh" --version 2>/dev/null | grep -q "rdsh"; then ok "from-release install"; else echo "FAIL(output): from-release install"; tail -n 8 $FR/install.log; exit 1; fi
tar -czf "$FR/latest/download/rdsh-linux-x64-musl.tar.gz" -C $FR/pkg rdsh
(cd "$FR/latest/download" && $SUM "rdsh-linux-x64-musl.tar.gz" > "rdsh-linux-x64-musl.tar.gz.sha256")
if RDSH_RELEASE_BASE="file://$FR" DSH_HOME="$FR/dsh" bash ./install.sh --from-release --musl --prefix="$FR/bin-musl" >$FR/install-musl.log 2>&1 && "$FR/bin-musl/rdsh" --version 2>/dev/null | grep -q "rdsh"; then ok "from-release musl install"; else echo "FAIL(output): from-release musl install"; tail -n 8 $FR/install-musl.log; exit 1; fi
# --- install.sh asset selection (Linux/x86_64 via PATH shims; file:// release fixtures) ---
MS="$RG_TMP/musl"
rm -rf $MS
mkdir -p $MS/shim $MS/rel/latest/download $MS/gnu $MS/musl
printf '#!/bin/sh\necho fake-gnu\n' > $MS/gnu/rdsh
printf '#!/bin/sh\necho fake-musl\n' > $MS/musl/rdsh
chmod +x $MS/gnu/rdsh $MS/musl/rdsh
tar -czf $MS/rel/latest/download/rdsh-linux-x64.tar.gz -C $MS/gnu rdsh
tar -czf $MS/rel/latest/download/rdsh-linux-x64-musl.tar.gz -C $MS/musl rdsh
# install.sh refuses a release asset without its .sha256 sidecar.
for a in rdsh-linux-x64 rdsh-linux-x64-musl; do (cd "$MS/rel/latest/download" && $SUM "$a.tar.gz" > "$a.tar.gz.sha256"); done
printf '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) exec /usr/bin/uname "$@" ;; esac\n' > $MS/shim/uname
chmod +x $MS/shim/uname
# install.sh asks ldd first and falls back to getconf, so "ldd exit 1" cases exercise the getconf fallback.
# pick NAME GETCONF_BODY LDD_BODY [install flags...] -> which fake binary got installed
pick() {
  rm -rf $MS/prefix
  printf '#!/bin/sh\n%s\n' "$2" > $MS/shim/getconf
  printf '#!/bin/sh\n%s\n' "$3" > $MS/shim/ldd
  chmod +x $MS/shim/getconf $MS/shim/ldd
  shift 3
  PATH="$MS/shim:$PATH" HOME="$MS/home" RDSH_RELEASE_BASE="file://$MS/rel" bash ./install.sh --from-release --prefix="$MS/prefix" "$@" >$MS/install.log 2>&1 || { echo "FAIL(exit): install.sh pick"; tail -n 8 $MS/install.log; exit 1; }
  "$MS/prefix/rdsh"
}
mkdir -p $MS/home
r="$(pick x 'echo "glibc 2.41"' 'exit 1')"
if [ "$r" = fake-gnu ]; then ok "install: getconf fallback glibc 2.41 picks gnu"; else echo "FAIL: glibc 2.41 picked $r"; exit 1; fi
r="$(pick x 'echo "glibc 2.31"' 'exit 1')"
if [ "$r" = fake-musl ]; then ok "install: getconf fallback glibc 2.31 picks musl"; else echo "FAIL: glibc 2.31 picked $r"; exit 1; fi
r="$(pick x 'exit 1' 'echo "ldd (Debian GLIBC 2.36-9) 2.36"')"
if [ "$r" = fake-gnu ]; then ok "install: ldd glibc 2.36 picks gnu"; else echo "FAIL: ldd 2.36 picked $r"; exit 1; fi
r="$(pick x 'echo "glibc 2.41"' 'exit 1' --musl)"
if [ "$r" = fake-musl ]; then ok "install: --musl forces musl"; else echo "FAIL: --musl picked $r"; exit 1; fi
rm -rf $MS
printf "version: 1\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: api-key\n    key: sk-user-key\n" > "$AB/dsh/.credentials.yaml"
if HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN auth --import --provider openai-codex >/dev/null 2>&1 && grep -q "kind: api-key" "$AB/dsh/.credentials.yaml" && HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN auth 2>/dev/null | grep -q "left alone"; then ok "auth keeps api-key records"; else echo "FAIL(output): auth keeps api-key records"; exit 1; fi
for t in "$FR"/latest/download/*.tar.gz; do printf "tampered" >> "$t"; done
if RDSH_RELEASE_BASE="file://$FR" DSH_HOME="$FR/dsh" bash ./install.sh --from-release --prefix="$FR/bin-evil" >$FR/install-evil.log 2>&1; then echo "FAIL(output): tampered release refused"; exit 1; else ok "tampered release refused"; fi
rm -rf $FR
# sync-dsh.sh release self-update against a file:// release with npm/node shims.
# The script runs from a copy (no tests/regress.sh or target/ next to it), so it
# does not recurse into this suite.
FS="$RR_SANDBOX/sync-release"
rm -rf $FS
mkdir -p $FS/pkg $FS/rel/latest/download $FS/repo $FS/home/.local/bin $FS/npmroot/@deepseek-ai/dsh $FS/bin
cp "$BIN" $FS/pkg/rdsh
cp ./sync-dsh.sh $FS/repo/sync-dsh.sh
for a in rdsh-linux-x64 rdsh-linux-x64-musl rdsh-macos-arm64 rdsh-macos-x64; do tar -czf "$FS/rel/latest/download/$a.tar.gz" -C $FS/pkg rdsh; (cd "$FS/rel/latest/download" && $SUM "$a.tar.gz" > "$a.tar.gz.sha256"); done
printf '{"version":"1.0.0"}\n' > $FS/npmroot/@deepseek-ai/dsh/package.json
printf '#!/bin/sh\ncase "$1" in root) echo "%s" ;; view) echo "[\\"1.0.0\\"]" ;; *) exit 1 ;; esac\n' "$FS/npmroot" > $FS/npm
printf '#!/bin/sh\necho 1.0.0\n' > $FS/home/.local/bin/node
chmod +x $FS/npm $FS/home/.local/bin/node
fs_sync() { env -u RDSH_SYNC_FROM_SOURCE -u RDSH_SYNC_VERSION -u RDSH_MUSL HOME="$FS/home" NPM_BIN="$FS/npm" PREFIX_BIN="$1" RDSH_RELEASE_BASE="file://$FS/rel" sh $FS/repo/sync-dsh.sh > "$2" 2>&1; }
fs_sync "$FS/bin" $FS/sync-ok.log
if grep -q "checksum ok" $FS/sync-ok.log && grep -q "rdsh updated OK via release binary" $FS/sync-ok.log && "$FS/bin/rdsh" --version 2>/dev/null | grep -q "rdsh"; then ok "sync-dsh release update with valid sha256"; else echo "FAIL(output): sync-dsh release update with valid sha256"; tail -n 8 $FS/sync-ok.log; exit 1; fi
for c in "$FS"/rel/latest/download/*.sha256; do printf '%064d  x.tar.gz\n' 0 > "$c"; done
printf 'old\n' > $FS/bin/rdsh
fs_sync "$FS/bin" $FS/sync-bad.log
if grep -q "CHECKSUM MISMATCH" $FS/sync-bad.log && grep -q "binaries untouched" $FS/sync-bad.log && [ "$(cat $FS/bin/rdsh)" = "old" ]; then ok "sync-dsh refuses bad sha256"; else echo "FAIL(output): sync-dsh refuses bad sha256"; tail -n 8 $FS/sync-bad.log; exit 1; fi
rm -f "$FS"/rel/latest/download/*.sha256
fs_sync "$FS/bin" $FS/sync-none.log
if grep -q "no checksum sidecar" $FS/sync-none.log && grep -q "binaries untouched" $FS/sync-none.log && [ "$(cat $FS/bin/rdsh)" = "old" ]; then ok "sync-dsh refuses missing sha256"; else echo "FAIL(output): sync-dsh refuses missing sha256"; tail -n 8 $FS/sync-none.log; exit 1; fi
for a in rdsh-linux-x64 rdsh-linux-x64-musl rdsh-macos-arm64 rdsh-macos-x64; do : > "$FS/rel/latest/download/$a.tar.gz.sha256"; done
fs_sync "$FS/bin" $FS/sync-empty.log
if grep -q "empty checksum sidecar" $FS/sync-empty.log && grep -q "binaries untouched" $FS/sync-empty.log && [ "$(cat $FS/bin/rdsh)" = "old" ]; then ok "sync-dsh refuses empty sha256"; else echo "FAIL(output): sync-dsh refuses empty sha256"; tail -n 8 $FS/sync-empty.log; exit 1; fi
rm -rf $FS
SW="$RR_SANDBOX/setupweb"
mkdir -p $SW/home $SW/dsh
HOME="$SW/home" DSH_HOME="$SW/dsh" $BIN setup --web --port 38082 >/dev/null 2>"$SW/setup.log" & SRV=$!
SETUP_TOKEN=""
i=0
while [ -z "$SETUP_TOKEN" ] && [ "$i" -lt 10 ]; do
  sleep 1
  SETUP_TOKEN=$(sed -n 's/.*#key=\([0-9a-f]*\).*/\1/p' "$SW/setup.log" | head -n 1)
  kill -0 "$SRV" 2>/dev/null || break
  i=$((i+1))
done
if [ -z "$SETUP_TOKEN" ]; then echo "FAIL(output): setup --web URL"; kill $SRV 2>/dev/null; exit 1; fi
if [ "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:38082/api/status)" = "401" ]; then ok "setup --web status requires key"; else echo "FAIL(output): setup --web unauthed status"; kill $SRV 2>/dev/null; exit 1; fi
if curl -fsS --max-time 5 -H "X-RDSH-Token: $SETUP_TOKEN" http://127.0.0.1:38082/api/status 2>/dev/null | grep -q "\"needed\":true"; then ok "setup --web status"; else echo "FAIL(output): setup --web status"; kill $SRV 2>/dev/null; exit 1; fi
if printf "%s" "{\"name\":\"DEEPSEEK_API_KEY\",\"value\":\"smoke-only-key\"}" | curl -fsS --max-time 5 -X POST -H "Content-Type: application/json" -H "X-RDSH-Token: $SETUP_TOKEN" --data-binary "@-" http://127.0.0.1:38082/api/key 2>/dev/null | grep -q "\"stored\":true"; then ok "setup --web key store"; else echo "FAIL(output): setup --web key store"; kill $SRV 2>/dev/null; exit 1; fi
curl -fsS --max-time 5 -X POST -H "X-RDSH-Token: $SETUP_TOKEN" --data-binary '{}' http://127.0.0.1:38082/api/done >/dev/null 2>&1
wait $SRV 2>/dev/null || true
rm -rf $SW
SWB="$RR_SANDBOX/searchweb"
mkdir -p $SWB
printf "%s" "<html><body><article class=\"result\"><h3><a href=\"https://example.com/a\">Alpha result</a></h3><p class=\"content\">first snippet</p></article><article class=\"result\"><h3><a href=\"https://example.com/b\">Beta result</a></h3></article></body></html>" > $SWB/fixture.html
python3 - "$SWB/fixture.html" 38083 <<PYEOF >/dev/null 2>&1 &
import http.server, sys
page = open(sys.argv[1], "rb").read()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = page if self.path.startswith("/search") else b"nope"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[2])), H).serve_forever()
PYEOF
HTTPSRV=$!
i=0
until curl -fsS --max-time 1 http://127.0.0.1:38083/ >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -ge 10 ] && break
  kill -0 "$HTTPSRV" 2>/dev/null || break
  sleep 1
done
if $BIN search-web "hello world" 2>&1 | grep -q "disabled by default"; then ok "search-web refused while extra off"; else echo "FAIL(output): extras gate"; kill $HTTPSRV 2>/dev/null; exit 1; fi
$BIN settings set extras.enable search-web >/dev/null 2>&1
if SEARXNG_URL="http://127.0.0.1:38083" $BIN search-web "hello world" --limit 5 2>/dev/null | grep -q "Alpha result"; then ok "search-web via fixture"; else echo "FAIL(output): search-web via fixture"; kill $HTTPSRV 2>/dev/null; exit 1; fi
kill $HTTPSRV 2>/dev/null
wait $HTTPSRV 2>/dev/null || true
rm -rf $SWB
if bash ./install.sh --help 2>/dev/null | grep -q -- "--musl"; then ok "install.sh documents --musl"; else echo "FAIL(output): install.sh documents --musl"; exit 1; fi
if grep -q "RDSH_SYNC_FROM_SOURCE" ./sync-dsh.sh && grep -q "sandboxed_regress" ./sync-dsh.sh; then ok "sync-dsh release-first + sandboxed regress"; else echo "FAIL(output): sync-dsh release-first + sandboxed regress"; exit 1; fi
if [ "${RDSH_REGRESS_SANDBOXED:-}" = 1 ] && [ -n "${RR_SANDBOX:-}" ] && [ "$HOME" = "$RR_SANDBOX/home" ] && [ "$DSH_HOME" = "$RR_SANDBOX/dsh" ]; then ok "regress sandboxed HOME"; else echo "FAIL(output): regress sandboxed HOME"; exit 1; fi
rm -rf $AB
rm -rf $SB "$RG_TMP/rr-in.txt" "$RG_TMP/rr-out" "$RG_TMP/rr-err"
echo "ALL PASS ($pass checks)"
