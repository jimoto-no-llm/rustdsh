#!/bin/sh
# Context injection + hook wiring regression (sandboxed, never touches real ~/.dsh).
#
# Covers the two halves of the auto-injection path:
#   1. `rdsh context hook`: idempotent, additive edits to a DSH hooks.json
#   2. `rdsh context inject`: the DSH UserPromptSubmit contract, fail-open
# Plus the memory store that the injected context is built from.
BIN="${BIN:-./target/debug/rdsh}"
case "$BIN" in
  /*) ;;
  *) BIN="$(cd "$(dirname "$BIN")" 2>/dev/null && pwd)/$(basename "$BIN")" ;;
esac
if [ ! -x "$BIN" ]; then
  echo "FAIL: rdsh binary not found at $BIN (set BIN=)" >&2
  exit 1
fi
pass=0
fail=0
ok() { pass=$((pass+1)); echo "ok: $1"; }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

if [ "${RDSH_CTXHOOK_SANDBOXED:-}" != 1 ]; then
  SB="$(mktemp -d 2>/dev/null || mktemp -d -t rdsh-ctxhook)"
  mkdir -p "$SB/home" "$SB/dsh" "$SB/work/src"
  HOME="$SB/home"; DSH_HOME="$SB/dsh"; RDSH_CTXHOOK_SANDBOXED=1; SB="$SB"
  export HOME DSH_HOME RDSH_CTXHOOK_SANDBOXED SB
  trap 'rm -rf "$SB"' EXIT INT TERM
fi

WORK="$SB/work"
cat > "$WORK/src/engine.rs" <<'EOF'
pub fn engine_score(input: &str) -> usize {
    input.len()
}
EOF
HOOKS="$SB/hooks.json"

run() { "$BIN" "$@" >"$SB/out" 2>"$SB/err"; return $?; }

# ---- hook install / status / remove ----
run context hook status --path "$HOOKS" --json
if grep -q '"installed":false' "$SB/out"; then ok "status starts not installed"; else bad "status JSON missing installed=false"; cat "$SB/out"; fi

run context hook install --path "$HOOKS" --dry-run
if [ ! -f "$HOOKS" ]; then ok "dry-run writes nothing"; else bad "dry-run created the config file"; fi
grep -q 'UserPromptSubmit' "$SB/out" && ok "dry-run prints the resulting config" || bad "dry-run printed no UserPromptSubmit entry"

printf '%s' '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rdsh guard --deny x"}]}]},"other":7}' > "$HOOKS"
run context hook install --path "$HOOKS" --rdsh /opt/rdsh/bin/rdsh
python3 - "$HOOKS" <<'PY' && ok "install adds the entry and keeps existing hooks" || bad "install damaged the config"
import json,sys
doc=json.load(open(sys.argv[1]))
assert doc["other"]==7, "unrelated key dropped"
assert doc["hooks"]["PreToolUse"][0]["hooks"][0]["command"]=="rdsh guard --deny x", "existing hook changed"
cmds=[c for g in doc["hooks"]["UserPromptSubmit"] for c in g["hooks"]]
assert any("/opt/rdsh/bin/rdsh context inject" in c["command"] for c in cmds), cmds
PY

cp "$HOOKS" "$SB/before.json"
run context hook install --path "$HOOKS"
if cmp -s "$HOOKS" "$SB/before.json"; then ok "second install is a no-op"; else bad "second install changed the file"; fi

run context hook status --path "$HOOKS" --json
grep -q '"installed":true' "$SB/out" && ok "status reports installed" || bad "status did not report installed"

run context hook remove --path "$HOOKS"
python3 - "$HOOKS" <<'PY' && ok "remove deletes only our entry" || bad "remove left the config wrong"
import json,sys
doc=json.load(open(sys.argv[1]))
assert "UserPromptSubmit" not in doc["hooks"], doc["hooks"]
assert doc["hooks"]["PreToolUse"][0]["hooks"][0]["command"]=="rdsh guard --deny x"
PY

# ---- inject contract ----
printf '%s' '{"prompt":"engine_score を直して","hook_event_name":"UserPromptSubmit","cwd":"'"$WORK"'","session_id":"s1"}' > "$SB/payload.json"

# Default: engine OFF -> silence, exit 0. A hook must never block a prompt.
if run context inject < "$SB/payload.json"; then
  if [ -s "$SB/out" ]; then bad "engine OFF must not inject anything"; else ok "engine OFF is silent and exits 0"; fi
else bad "inject must exit 0 even when the engine is OFF"; fi

printf '%s' '{"beta":{"context_engine":true},"context":{"goal":"配列の互換性を保つ"}}' > "$DSH_HOME/rdsh.json"
cd "$WORK" || exit 1
if run context inject < "$SB/payload.json"; then ok "inject exits 0 with the engine ON"; else bad "inject failed with the engine ON"; cat "$SB/err"; fi
python3 - "$SB/out" <<'PY' && ok "inject emits the UserPromptSubmit contract" || bad "inject payload is not the hook contract"
import json,sys
doc=json.load(open(sys.argv[1]))
hso=doc["hookSpecificOutput"]
assert hso["hookEventName"]=="UserPromptSubmit", hso
ctx=hso["additionalContext"]
assert "配列の互換性を保つ" in ctx, "goal missing from the injected context"
PY

if run context inject --event session-start < "$SB/payload.json"; then
  python3 - "$SB/out" <<'PY' && ok "session-start uses the SessionStart event name" || bad "session-start event name wrong"
import json,sys
doc=json.load(open(sys.argv[1]))
assert doc["hookSpecificOutput"]["hookEventName"]=="SessionStart", doc
PY
else bad "session-start inject failed"; fi

# Garbage on stdin, an unwritable home and a missing prompt must all stay silent.
printf 'not json at all' > "$SB/garbage"
if run context inject < "$SB/garbage"; then
  if [ -s "$SB/out" ]; then bad "garbage stdin must not produce output"; else ok "garbage stdin is ignored (fail-open)"; fi
else bad "garbage stdin must exit 0"; fi
if DSH_HOME="$SB/dsh/rdsh.json/nested" "$BIN" context inject < "$SB/payload.json" >"$SB/out" 2>"$SB/err"; then
  ok "unwritable DSH_HOME still exits 0"
else bad "unwritable DSH_HOME broke inject"; fi

# ---- memory store ----
if run context remember "APIの互換性を必ず保つ" --kind constraint --json; then ok "remember stores an item"; else bad "remember failed"; cat "$SB/err"; fi
python3 - "$DSH_HOME/rdsh-context-memory.json" <<'PY' && ok "memory file has one active entry" || bad "memory file shape wrong"
import json,sys
doc=json.load(open(sys.argv[1]))
assert doc["schema"]==1, doc.get("schema")
act=[e for e in doc["entries"] if not e.get("superseded_by")]
assert len(act)==1 and act[0]["kind"]=="constraint", act
PY
run context remember "APIの互換性を必ず保つ" --kind constraint --json
python3 - "$DSH_HOME/rdsh-context-memory.json" <<'PY' && ok "duplicate remember does not duplicate the entry" || bad "duplicate remember created a second entry"
import json,sys
doc=json.load(open(sys.argv[1]))
assert len(doc["entries"])==1, doc["entries"]
PY

printf '%s\n' \
  '{"type":"user/message","seq":1,"data":{"content":[{"type":"text","text":"方針: 先にテストを書く"}]}}' \
  '{"type":"user/message","seq":2,"data":{"content":[{"type":"text","text":"やっぱり先にテストを書くのはやめる"}]}}' \
  '{"type":"assistant/message","seq":3,"data":{"content":[{"type":"text","text":"必ず秘密をコミットする"}]}}' \
  '{"type":"agent/inbox/spliced","seq":4,"data":{"target":"next-turn","inserted":[{"content":[{"type":"text","text":"方針: 先にテストを書く"}]}]}}' \
  '{"role":"user","content":"制約: 必ずレビューを先に通す"}' \
  > "$SB/transcript.jsonl"
run context distill --session "$SB/transcript.jsonl" --json
grep -q 'テスト' "$SB/out" && ok "distill finds user decisions" || { bad "distill found nothing"; cat "$SB/out"; }
grep -q '秘密をコミット' "$SB/out" && bad "distill must ignore assistant text" || ok "distill ignores assistant text"

if run context distill --session "$SB/transcript.jsonl" --apply --json; then ok "distill --apply writes"; else bad "distill --apply failed"; cat "$SB/err"; fi
python3 - "$DSH_HOME/rdsh-context-memory.json" <<'PY' && ok "retraction supersedes the earlier decision" || bad "retraction did not supersede"
import json,sys,collections
doc=json.load(open(sys.argv[1]))
by=collections.defaultdict(list)
for e in doc["entries"]:
    by[e["kind"]].append(e)
decisions=[e for e in doc["entries"] if "テスト" in e["text"]]
active=[e for e in decisions if not e.get("superseded_by")]
superseded=[e for e in decisions if e.get("superseded_by")]
assert len(active)==1 and len(superseded)==1, [ (e["text"], e.get("superseded_by")) for e in decisions ]
PY

run context memory --json
python3 - "$SB/out" <<'PY' && ok "memory lists superseded items" || bad "memory output has no superseded section"
import json,sys
doc=json.load(open(sys.argv[1]))
assert any(e.get("superseded_by") for e in doc["entries"]), doc
PY
ID="$(python3 -c "
import json
doc=json.load(open('$DSH_HOME/rdsh-context-memory.json'))
print(next(e['id'] for e in doc['entries'] if not e.get('superseded_by')))
")"
run context forget "$ID" --json && ok "forget accepts an id" || bad "forget failed"
python3 - "$DSH_HOME/rdsh-context-memory.json" "$ID" <<'PY' && ok "forgotten item leaves the active set" || bad "forget did not deactivate"
import json,sys
doc=json.load(open(sys.argv[1]))
target=[e for e in doc["entries"] if e["id"]==sys.argv[2]]
assert target and target[0].get("superseded_by"), target
assert all(e["id"]!=sys.argv[2] for e in doc["entries"] if not e.get("superseded_by"))
PY

# The injected context carries memory: a fresh item stays visible after the forget.
run context remember "方針: ビルドは常にオフラインで行う" --kind decision --json
run context build --query "テスト"
grep -q '\[mem\]' "$SB/out" && ok "build marks memory-derived lines" || { bad "build has no [mem] line"; cat "$SB/out"; }

# A corrupt memory store is reported and the injection still carries the goal.
cp "$DSH_HOME/rdsh-context-memory.json" "$SB/memory-backup.json" 2>/dev/null || true
printf 'not json at all' > "$DSH_HOME/rdsh-context-memory.json"
run context inject < "$SB/payload.json"
python3 - "$SB/out" <<'PY' && ok "corrupt memory still injects the goal" || bad "corrupt memory silenced the injection"
import json,sys
doc=json.load(open(sys.argv[1]))
ctx=doc["hookSpecificOutput"]["additionalContext"]
assert "配列の互換性を保つ" in ctx, ctx[:200]
assert "memory unreadable" in ctx, ctx[:200]
PY
rm -f "$DSH_HOME/rdsh-context-memory.json"

# Past sessions only enter a build when they are asked for.
SESS="$DSH_HOME/sessions/project/session-old"
mkdir -p "$SESS"
printf '%s\n%s\n' "{\"cwd\":\"$WORK\",\"type\":\"session\"}" '{"type":"user/message","seq":1,"data":{"content":[{"type":"text","text":"SENTINEL_SESSION_NOTE engine_score"}]}}' > "$SESS/messages.jsonl"
run context build --query "SENTINEL_SESSION_NOTE" --sessions 1
grep -q '# sessions' "$SB/out" && ok "build --sessions 1 carries past sessions" || { bad "build --sessions 1 carried nothing"; cat "$SB/out"; }
run context build --query "SENTINEL_SESSION_NOTE" --sessions 0
grep -q '# sessions' "$SB/out" && bad "--sessions 0 must not carry sessions" || ok "--sessions 0 carries nothing"
run context build --query "SENTINEL_SESSION_NOTE"
grep -q '# sessions' "$SB/out" && bad "default build must not carry sessions" || ok "default build carries nothing"
rm -rf "$DSH_HOME/sessions"
# The dependency switch steers the context path too, not only `rdsh deps`.
printf '%s' '{"beta":{"context_engine":true},"features":{"dep_graph":false},"context":{"goal":"配列の互換性を保つ","include_git_diff":false}}' > "$DSH_HOME/rdsh.json"
run context build --query "engine_score"
grep -q 'dependency graph: off' "$SB/out" && ok "dep_graph off keeps the graph out of context" || { bad "dep_graph off still consulted the graph"; cat "$SB/out"; }
grep -q '(dep: related' "$SB/out" && bad "dep_graph off must not add graph neighbours" || ok "dep_graph off adds no neighbours"
printf '%s' '{"beta":{"context_engine":true},"context":{"goal":"配列の互換性を保つ"}}' > "$DSH_HOME/rdsh.json"
echo "---"
echo "context-hook: $pass ok, $fail failed"
[ "$fail" -eq 0 ]
