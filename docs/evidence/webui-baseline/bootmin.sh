#!/bin/bash
set -u
OUT=/tmp/bootbench
DSH=/home/sahen/.local/bin/dsh-orig
PORT=39205

# Minimal DSH_HOME: core packages only, no user plugins/MCP/sessions.
MIN=/tmp/dsh-min
rm -rf "$MIN"; mkdir -p "$MIN"

run_min() {
  local label="$1"; local cc="$2"; local S R P i
  S=$(date +%s.%N)
  if [ -n "$cc" ]; then
    timeout 150 env NODE_COMPILE_CACHE="$cc" NODE_OPTIONS=--max-old-space-size=1536 DSH_HOME="$MIN" \
      "$DSH" --profile web -- --host 127.0.0.1 --port $PORT --no-open > "$OUT/${label}.log" 2>&1 &
  else
    timeout 150 env NODE_OPTIONS=--max-old-space-size=1536 DSH_HOME="$MIN" \
      "$DSH" --profile web -- --host 127.0.0.1 --port $PORT --no-open > "$OUT/${label}.log" 2>&1 &
  fi
  P=$!; R=""
  for i in $(seq 1 400); do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null; then R=$(date +%s.%N); break; fi
    if ! kill -0 $P 2>/dev/null; then R="DEAD"; break; fi
    sleep 0.2
  done
  if [ "$R" = "DEAD" ]; then echo "$label FAILED"; else
    echo "$label $(echo "$R - $S" | bc)"
  fi
  kill -TERM $P 2>/dev/null; sleep 2; kill -9 $P 2>/dev/null; wait $P 2>/dev/null; sleep 1
}

echo "### minimal DSH_HOME runs: $(date -Is)"
for i in 1 2 3; do run_min M_cold_$i ""; done
rm -rf /tmp/nodecc_m; mkdir -p /tmp/nodecc_m
run_min M_warmup /tmp/nodecc_m
for i in 1 2 3; do run_min M_warm_$i /tmp/nodecc_m; done
echo "### DONE"
