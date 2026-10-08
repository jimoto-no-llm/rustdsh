#!/bin/sh
# rdsh CLI regression. Fails on first mismatch (set -e + explicit checks).
BIN="${BIN:-./target/release/rdsh}"
pass=0
ok() { pass=$((pass+1)); echo "ok: $1"; }
# Sandboxed HOME/DSH_HOME: this suite must never write to the real ~/.dsh
# (issue #85 item 8). Tests that need fixtures override HOME/DSH_HOME explicitly.
if [ "${RDSH_REGRESS_SANDBOXED:-}" != 1 ]; then
  RR_SANDBOX="$(mktemp -d 2>/dev/null || mktemp -d -t rdsh-regress)"
  mkdir -p "$RR_SANDBOX/home" "$RR_SANDBOX/dsh"
  HOME="$RR_SANDBOX/home"; DSH_HOME="$RR_SANDBOX/dsh"; RDSH_REGRESS_SANDBOXED=1
  export HOME DSH_HOME RDSH_REGRESS_SANDBOXED RR_SANDBOX
  trap 'rm -rf "$RR_SANDBOX"' EXIT INT TERM
fi
need_ok() {
  desc="$1"; shift
  if "$@" >/tmp/rr-out 2>/tmp/rr-err; then ok "$desc"; else echo "FAIL(exit): $desc"; cat /tmp/rr-err; exit 1; fi
}
need_exit() {
  want="$1"; desc="$2"; shift 2
  "$@" >/tmp/rr-out 2>/tmp/rr-err
  code=$?
  if [ "$code" = "$want" ]; then ok "$desc"; else echo "FAIL(exit $code want $want): $desc"; exit 1; fi
}
need_grep() {
  pat="$1"; desc="$2"; shift 2
  "$@" >/tmp/rr-out 2>/tmp/rr-err
  if grep -q "$pat" /tmp/rr-out; then ok "$desc"; else echo "FAIL(output): $desc"; exit 1; fi
}
need_grep "rdsh" "version string" $BIN --version
need_ok "doctor" $BIN doctor
printf "hello world, this is a token test" | $BIN tokens > /tmp/rr-out 2>/dev/null
if grep -q "\"tokens\": 9" /tmp/rr-out; then ok "tokens stdin"; else echo "FAIL(output): tokens stdin"; exit 1; fi
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
printf "FROMSTDIN" > /tmp/rr-in.txt
need_ok "compact noop" $BIN compact /tmp/rr-in.txt --max-tokens 8000
SB=/tmp/rdsh-regress-$$
mkdir -p $SB/bin $SB/orig
cat > $SB/orig/dsh << FAKEEOF
#!/bin/sh
echo FAKE-ORIG
FAKEEOF
chmod +x $SB/orig/dsh
cp "$BIN" $SB/bin/dsh
if PATH="$SB/bin:$SB/orig:$PATH" DSH_ORIG_BIN="$SB/orig/dsh" $SB/bin/dsh --version | grep -q FAKE-ORIG; then ok "dsh-mode delegates"; else echo "FAIL: dsh-mode delegates"; exit 1; fi
if PATH="$SB/bin:$SB/orig:$PATH" DSH_ORIG_BIN="$SB/orig/dsh" $SB/bin/dsh doctor | grep -q rdsh; then ok "dsh-mode native"; else echo "FAIL: dsh-mode native"; exit 1; fi
if PATH="$SB/bin:$SB/orig:$PATH" RDSH_ORIG_BIN="$SB/orig/dsh" $SB/bin/dsh --version | grep -q FAKE-ORIG; then ok "RDSH_ORIG_BIN primary"; else echo "FAIL: RDSH_ORIG_BIN primary"; exit 1; fi
# --- sessions --tokens cache: a `?` from a zstd-less run must not stick once zstd exists ---
# p (two sessions) takes the batch path, q (one session) the per-session path.
ZC=/tmp/rdsh-zcache-$$
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
WB=/tmp/rdsh-wrapper-$$
mkdir -p $WB/.local/bin
printf '#!/bin/sh\nexec node "$(readlink -f "$(command -v dsh)")" --profile web\n' > $WB/.local/bin/dsh-web-local
if HOME="$WB" $BIN doctor 2>/dev/null | grep -q "dsh-web-local"; then ok "doctor flags node-on-dsh wrapper"; else echo "FAIL(output): doctor flags node-on-dsh wrapper"; exit 1; fi
rm -rf $WB
AB=/tmp/rdsh-auth-AA
mkdir -p $AB/home/.codex $AB/home/.local/share/opencode $AB/dsh
printf '%s' '{"tokens":{"access_token":"a","refresh_token":"r","account_id":"1"}}' > $AB/home/.codex/auth.json
printf '%s' '{"openai":{"type":"oauth","refresh":"r2","access":"a2","expires":1991708802841,"accountId":"9"}}' > $AB/home/.local/share/opencode/auth.json
if HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN auth 2>/dev/null | grep -q "openai-codex"; then ok "auth detects opencode login"; else echo "FAIL(output): auth detects opencode login"; exit 1; fi
if HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN auth --import >/dev/null 2>&1 && grep -q "llm-pi-ai/openai-codex" "$AB/dsh/.credentials.yaml"; then ok "auth import writes record"; else echo "FAIL(output): auth import writes record"; exit 1; fi
if HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN auth 2>/dev/null | grep -q "already recognized"; then ok "auth import recognized"; else echo "FAIL(output): auth import recognized"; exit 1; fi
fmode="$(stat -c %a "$AB/dsh/.credentials.yaml" 2>/dev/null || stat -f "%Lp" "$AB/dsh/.credentials.yaml")"
if [ "$fmode" = "600" ]; then ok "auth file mode 600"; else echo "FAIL(mode): auth file mode"; exit 1; fi
if HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN setup --json 2>/dev/null | grep -q "\"needed\":false"; then ok "setup connected"; else echo "FAIL(output): setup connected"; exit 1; fi
SB2=/tmp/rdsh-setup-AA
mkdir -p $SB2/home $SB2/dsh
if env -u DEEPSEEK_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY HOME="$SB2/home" DSH_HOME="$SB2/dsh" $BIN setup --json 2>/dev/null | grep -q "\"needed\":true"; then ok "setup needed on first run"; else echo "FAIL(output): setup needed on first run"; exit 1; fi
if env -u DEEPSEEK_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY HOME="$SB2/home" DSH_HOME="$SB2/dsh" DSH_ORIG_BIN="$SB/orig/dsh" $SB/bin/dsh --profile tui 2>&1 | grep -q "rdsh setup"; then ok "first-boot banner"; else echo "FAIL(output): first-boot banner"; exit 1; fi
rm -rf $SB2
FR=/tmp/rdsh-fr-AA
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
printf "version: 1\nrecords:\n  llm-pi-ai/openai-codex:\n    kind: api-key\n    key: sk-user-key\n" > "$AB/dsh/.credentials.yaml"
if HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN auth --import >/dev/null 2>&1 && grep -q "kind: api-key" "$AB/dsh/.credentials.yaml" && HOME="$AB/home" DSH_HOME="$AB/dsh" $BIN auth 2>/dev/null | grep -q "left alone"; then ok "auth keeps api-key records"; else echo "FAIL(output): auth keeps api-key records"; exit 1; fi
for t in "$FR"/latest/download/*.tar.gz; do printf "tampered" >> "$t"; done
if RDSH_RELEASE_BASE="file://$FR" DSH_HOME="$FR/dsh" bash ./install.sh --from-release --prefix="$FR/bin-evil" >$FR/install-evil.log 2>&1; then echo "FAIL(output): tampered release refused"; exit 1; else ok "tampered release refused"; fi
rm -rf $FR
# sync-dsh.sh release self-update against a file:// release with npm/node shims.
# The script runs from a copy (no tests/regress.sh or target/ next to it), so it
# does not recurse into this suite.
FS=/tmp/rdsh-fs-AA
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
SW=/tmp/rdsh-setupweb-AA
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
SWB=/tmp/rdsh-searchweb-AA
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
rm -rf $SB /tmp/rr-in.txt /tmp/rr-out /tmp/rr-err
echo "ALL PASS ($pass checks)"
