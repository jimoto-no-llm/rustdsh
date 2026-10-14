#!/bin/sh
# Dependency graph + impact regression (sandboxed, never touches real ~/.dsh).
#
# Covers src/deps.rs: index build, persistence, incremental reuse, symbol
# lookup, and change-impact output. The fixtures are tiny synthetic trees so a
# failure points at rdsh, not at this repository's contents.
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

if [ "${RDSH_DEPS_SANDBOXED:-}" != 1 ]; then
  SB="$(mktemp -d 2>/dev/null || mktemp -d -t rdsh-deps)"
  mkdir -p "$SB/home" "$SB/dsh"
  HOME="$SB/home"; DSH_HOME="$SB/dsh"; RDSH_DEPS_SANDBOXED=1; SB="$SB"
  export HOME DSH_HOME RDSH_DEPS_SANDBOXED SB
  trap 'rm -rf "$SB"' EXIT INT TERM
fi

REPO="$SB/repo"
mkdir -p "$REPO/src" "$REPO/tests"
cat > "$REPO/src/core.rs" <<'EOF'
pub struct Engine {
    pub speed: u32,
}

pub fn engine_score(input: &str) -> usize {
    input.len()
}

pub fn engine_run(engine: &Engine) -> usize {
    engine_score("run")
}
EOF
cat > "$REPO/src/lib.rs" <<'EOF'
mod core;

pub fn start() -> usize {
    let engine = core::Engine { speed: 1 };
    core::engine_run(&engine)
}
EOF
cat > "$REPO/tests/core_test.rs" <<'EOF'
use rdsh_fixture::start;

#[test]
fn start_works() {
    assert_eq!(start(), 3);
}
EOF
cat > "$REPO/src/tool.py" <<'EOF'
from core import engine_run


def main():
    return engine_run(None)
EOF

# impact and query resolve the target against the repository of the current
# directory, so every command runs from inside the fixture.
cd "$REPO" || exit 1
run() { "$BIN" "$@" >"$SB/out" 2>"$SB/err"; return $?; }

if run deps build --root "$REPO" --json; then ok "deps build runs"; else bad "deps build failed"; cat "$SB/err"; fi
grep -q '"files"' "$SB/out" && ok "build reports files" || bad "build JSON has no files key"
IDX="$(find "$DSH_HOME/rdsh-index" -name '*.json' 2>/dev/null | head -1)"
if [ -n "$IDX" ]; then ok "index persisted under DSH_HOME"; else bad "no index file under DSH_HOME/rdsh-index"; fi

# A second build reuses unchanged files instead of re-parsing them.
if run deps build --root "$REPO" --json; then
  if python3 - "$SB/out" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
build=doc.get("build",{})
assert build.get("reused",0) >= 3, f"expected reuse of the 4 fixture files, got {build}"
assert build.get("parsed",9) <= 1, f"nothing should be re-parsed, got {build}"
PY
  then ok "second build reuses unchanged files"; else bad "no incremental reuse reported"; cat "$SB/out"; fi
else bad "second deps build failed"; fi

# --force re-parses everything.
if run deps build --root "$REPO" --force --json; then
  if python3 - "$SB/out" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
assert doc.get("build",{}).get("parsed",0) >= 4, doc.get("build")
PY
  then ok "--force re-parses every file"; else bad "--force did not re-parse"; cat "$SB/out"; fi
else bad "deps build --force failed"; fi

# Symbol lookup finds the defining file.
if run deps query engine_run --json; then
  grep -q 'core.rs' "$SB/out" && ok "query finds the defining file" || { bad "query output lacks core.rs"; cat "$SB/out"; }
else bad "deps query failed for a known symbol"; fi
if run deps query definitely_not_a_symbol_xyz; then bad "unknown symbol must exit non-zero"; else ok "unknown symbol exits non-zero"; fi

# Impact: callers + affected tests, and an explicit unresolved count.
if run deps impact src/core.rs --json; then
  if python3 - "$SB/out" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
assert doc.get("kind")=="file", doc.get("kind")
direct=set(doc.get("direct",[]))
assert "src/lib.rs" in direct, f"lib.rs should depend on core.rs ({direct})"
tests=set(doc.get("tests",[]))
assert "tests/core_test.rs" in tests, f"affected tests missing ({tests})"
assert isinstance(doc.get("unresolved"),int), "unresolved edge count must be reported"
assert doc.get("index",{}).get("files",0) >= 4, doc.get("index")
PY
  then ok "impact lists dependents, tests and unresolved"; else bad "impact JSON incomplete"; cat "$SB/out"; fi
else bad "deps impact failed"; fi

# Determinism: the analysis part of the JSON is byte-stable across runs.
strip() {
  python3 - "$1" "$2" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
json.dump(doc,open(sys.argv[2],"w"),sort_keys=True)
PY
}
run deps impact src/core.rs --json && strip "$SB/out" "$SB/first.json"
run deps impact src/core.rs --json && strip "$SB/out" "$SB/second.json"
if cmp -s "$SB/first.json" "$SB/second.json"; then ok "impact output is deterministic"; else bad "impact output differs between runs"; fi

# A corrupt index is ignored and rebuilt, never fatal.
if [ -n "$IDX" ]; then
  printf 'not json at all' > "$IDX"
  if run deps build --root "$REPO" --json; then ok "corrupt index is rebuilt"; else bad "corrupt index broke the build"; fi
fi

# Unknown roots and unknown targets fail closed with a message.
if run deps build --root "$SB/does-not-exist"; then bad "missing root must fail"; else ok "missing root fails"; fi
if run deps impact src/not-there.rs; then bad "unknown target must exit non-zero"; else ok "unknown target exits non-zero"; fi

echo "---"
echo "deps: $pass ok, $fail failed"
[ "$fail" -eq 0 ]
