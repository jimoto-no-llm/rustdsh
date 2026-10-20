#!/bin/bash
set -u
OUT=/tmp/bootbench
DSH=/home/sahen/.local/bin/dsh-orig
PORT=39207

# Measure RSS after server is up and settles, full profile vs minimal.
measure() {
  local label="$1"; local home="$2"; local cc="$3"; local P i
  if [ -n "$cc" ]; then
    timeout 150 env NODE_COMPILE_CACHE="$cc" NODE_OPTIONS=--max-old-space-size=1536 DSH_HOME="$home" \
      "$DSH" --profile web -- --host 127.0.0.1 --port $PORT --no-open > "$OUT/mem_${label}.log" 2>&1 &
  else
    timeout 150 env NODE_OPTIONS=--max-old-space-size=1536 DSH_HOME="$home" \
      "$DSH" --profile web -- --host 127.0.0.1 --port $PORT --no-open > "$OUT/mem_${label}.log" 2>&1 &
  fi
  P=$!
  for i in $(seq 1 400); do
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null && break
    kill -0 $P 2>/dev/null || break
    sleep 0.2
  done
  sleep 12   # let MCP children spawn and settle
  local main_rss children_rss nchild
  main_rss=$(ps -o rss= -p $P 2>/dev/null | tr -d " ")
  # children of P (direct + transitive via process group)
  nchild=$(pgrep -P $P 2>/dev/null | wc -l)
  children_rss=$(ps -o rss= --ppid $P 2>/dev/null | awk "{s+=\$1} END{print s+0}")
  echo "${label} main_rss_kb=${main_rss:-NA} direct_children=${nchild} children_rss_kb=${children_rss}"
  kill -TERM $P 2>/dev/null; sleep 2; kill -9 $P 2>/dev/null; wait $P 2>/dev/null; sleep 1
}

echo "### memory measurement $(date -Is)"
measure full_profile /home/sahen/.dsh ""
measure minimal_home /tmp/dsh-min ""
echo "### DONE"
