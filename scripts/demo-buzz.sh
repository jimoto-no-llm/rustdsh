#!/usr/bin/env bash
# buzz demo: 15秒で見せる rdsh の速さ (合成データのみ, 利用者データ不使用)
# usage: ./scripts/demo-buzz.sh [--bin target/release/rdsh]
set -euo pipefail
BIN="${1:-target/release/rdsh}"
if [[ "$1" == --bin ]]; then BIN="$2"; fi
echo "== 1/3 起動比較 =="
"$BIN" bench --n 5 || "$BIN" --version
echo ""
echo "== 2/3 トークン見積り =="
TMPDIR_DEMO="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_DEMO"' EXIT
printf "hello rdsh\n%.0s" $(seq 1 200) > "$TMPDIR_DEMO/sample.txt"
"$BIN" tokens "$TMPDIR_DEMO/sample.txt"
echo ""
echo "== 3/3 検索 =="
mkdir -p "$TMPDIR_DEMO/proj"
for i in $(seq 1 20); do echo "TODO item $i" > "$TMPDIR_DEMO/proj/f$i.txt"; done
echo "README 3行目相当" > "$TMPDIR_DEMO/proj/hit.txt"
"$BIN" search TODO --dir "$TMPDIR_DEMO/proj" --max 5
 echo ""
 echo "done: この数字をそのまま投稿に使えます"
