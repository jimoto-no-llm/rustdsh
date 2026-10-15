#!/bin/sh
# settings (rdsh.json schema v1) prototype checks.
# 実バイナリ($BIN)を sandbox の HOME/DSH_HOME で動かして検証する。
# BIN が無いと何も検証できないため FAIL にする（未ビルドのまま緑にしない）。
SRC="${SRC:-src/rdsh_config.rs}"
pass=0
ok() { pass=$((pass+1)); echo "ok: $1"; }
fail() { echo "FAIL: $1"; exit 1; }

[ -f "$SRC" ] || fail "src/rdsh_config.rs がありません"
grep -qF 'pub fn settings_path() -> String' "$SRC" || fail "公開API settings_path がありません"
grep -qF 'pub fn load() -> RdshSettings' "$SRC" || fail "公開API load がありません"
grep -qF 'pub fn save(&self) -> anyhow::Result<()>' "$SRC" || fail "公開API save がありません"
ok "公開API3件 (settings_path/load/save)"

# CLI wiring (Lead integration): sandboxed, never touches real ~/.dsh.
BIN="${BIN:-./target/debug/rdsh}"
if [ -x "$BIN" ]; then
  CSB="$(mktemp -d 2>/dev/null || mktemp -d -t rdsh-settings-cli)"
  if HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings init >/tmp/st-out 2>/tmp/st-err && grep -q "rdsh.json" /tmp/st-out; then ok "settings init"; else echo "FAIL: settings init"; cat /tmp/st-err; exit 1; fi
  if HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings show --json 2>/dev/null | grep -q '"schema"'; then ok "settings show"; else echo "FAIL: settings show"; exit 1; fi
  if HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings path 2>/dev/null | grep -q "rdsh.json"; then ok "settings path"; else echo "FAIL: settings path"; exit 1; fi
  if HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings init >/dev/null 2>&1; then echo "FAIL: second init should exit nonzero"; exit 1; else ok "settings init guards overwrite"; fi
  if HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings keys 2>/dev/null | grep -q "beta.context_engine"; then ok "settings keys"; else echo "FAIL: settings keys"; exit 1; fi
  if HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings get beta.context_engine 2>/dev/null | grep -q "false"; then ok "settings get default OFF"; else echo "FAIL: default OFF"; exit 1; fi
  if HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings set search.max 42 2>/dev/null | grep -q "42"; then ok "settings set"; else echo "FAIL: settings set"; exit 1; fi
  if HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings get search.max 2>/dev/null | grep -q "42"; then ok "settings get"; else echo "FAIL: settings get"; exit 1; fi
  if HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings set context.goal "hello-goal" >/dev/null 2>&1 && HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings get context.goal 2>/dev/null | grep -q "hello-goal"; then ok "settings set context.goal"; else echo "FAIL: set context.goal"; exit 1; fi
  if HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings unset search.max >/dev/null 2>&1 && HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings get search.max 2>/dev/null | grep -q "100"; then ok "settings unset"; else echo "FAIL: settings unset"; exit 1; fi
  if HOME="$CSB" DSH_HOME="$CSB/dsh" "$BIN" settings get unknown.key >/dev/null 2>&1; then echo "FAIL: unknown key should fail"; exit 1; else ok "settings get guards unknown"; fi
  rm -rf "$CSB"
fi

# Settings-as-defaults (Lead): sandboxed rdsh.json overrides CLI defaults.
if [ -x "$BIN" ]; then
  OSB="$(mktemp -d 2>/dev/null || mktemp -d -t rdsh-settings-override)"
  mkdir -p "$OSB/dsh" "$OSB/work"
  printf "%s" "{\"tokens\":{\"default_budget\":500}}" > "$OSB/dsh/rdsh.json"
  if python3 -c 'print("a " * 6000)' | HOME="$OSB" DSH_HOME="$OSB/dsh" "$BIN" prune 2>/dev/null | grep -q "pruned"; then ok "settings override prune budget"; else echo "FAIL: prune override"; exit 1; fi
  printf "hit\nhit\nhit\nhit\nhit\n" > "$OSB/work/a.txt"
  printf "%s" "{\"search\":{\"dir\":\"$OSB/work\",\"max\":2}}" > "$OSB/dsh/rdsh.json"
  if HOME="$OSB" DSH_HOME="$OSB/dsh" "$BIN" search hit --dir "$OSB/work" 2>/dev/null | grep -c "a.txt" | grep -q "^2$"; then ok "settings override search max"; else echo "FAIL: search max override"; exit 1; fi
  printf "%s" "{\"guard\":{\"deny\":[\"nope*\"]}}" > "$OSB/dsh/rdsh.json"
  if printf "nope-test" | HOME="$OSB" DSH_HOME="$OSB/dsh" "$BIN" guard >/dev/null 2>&1; then echo "FAIL: guard deny override"; exit 1; else ok "settings override guard deny"; fi
  printf "%s" "{\"beta\":{\"context_engine\":false}}" > "$OSB/dsh/rdsh.json"
  if HOME="$OSB" DSH_HOME="$OSB/dsh" "$BIN" context status >/dev/null 2>&1; then echo "FAIL: beta gate"; exit 1; else ok "beta gate disables context"; fi
  rm -rf "$OSB"
else
  fail "binary not found: $BIN (build it first: cargo build)"
fi

echo "settings-prototype: ALL PASS ($pass)"
