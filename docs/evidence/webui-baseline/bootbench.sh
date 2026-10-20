#!/bin/bash
# Boot benchmark for dsh web, isolated port + isolated DSH_HOME.
# Never touches dsh-web.service (127.0.0.1:3080).
set -u
OUT=/tmp/bootbench
mkdir -p "$OUT"
DSH=/home/sahen/.local/bin/dsh-orig
PORT=39201

run_one() {
  local label="$1"; shift
  local home="$1"; shift
  local cc="$1"; shift
  local S R P i
  S=$(date +%s.%N)
  if [ -n "$cc" ]; then
    timeout 150 env NODE_COMPILE_CACHE="$cc" NODE_OPTIONS=--max-old-space-size=1536 \
      DSH_HOME="$home" "$DSH" --profile web -- --host 127.0.0.1 --port $PORT --no-open \
      > "$OUT/${label}.log" 2>&1 &
  else
    timeout 150 env NODE_OPTIONS=--max-old-space-size=1536 \
      DSH_HOME="$home" "$DSH" --profile web -- --host 127.0.0.1 --port $PORT --no-open \
      > "$OUT/${label}.log" 2>&1 &
  fi
  P=$!
  R=""
  for i in $(seq 1 400); do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null; then R=$(date +%s.%N); break; fi
    if ! kill -0 $P 2>/dev/null; then R="DEAD"; break; fi
    sleep 0.2
  done
  if [ "$R" = "DEAD" ]; then
    echo "$label FAILED(process died)"
  else
    echo "$label $(echo "$R - $S" | bc)"
  fi
  kill -TERM $P 2>/dev/null
  sleep 2
  kill -9 $P 2>/dev/null
  wait $P 2>/dev/null
  sleep 1
}

echo "### host: $(uname -n) $(uname -r) ; $(nproc) cpus"
echo "### date: $(date -Is)"
echo "### free before: $(free -m | sed -n 2p)"
echo "### dsh: $($DSH --version 2>&1 | head -1)"

for i in 1 2 3; do run_one A_cold_$i /home/sahen/.dsh ""; done

rm -rf /tmp/nodecc_a; mkdir -p /tmp/nodecc_a
run_one B_warmup /home/sahen/.dsh /tmp/nodecc_a
for i in 1 2 3; do run_one B_warm_$i /home/sahen/.dsh /tmp/nodecc_a; done

echo "### DONE"
