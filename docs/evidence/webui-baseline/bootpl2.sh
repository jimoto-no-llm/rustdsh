#!/bin/bash
set -u
DSH=/home/sahen/.local/bin/dsh-orig
PORT=39217
OUT=/tmp/bootbench
JAR=/tmp/bootbench/cj2.txt
DL=/tmp/bootbench/payload2
rm -rf /tmp/dsh-hdr2 "$DL"; mkdir -p /tmp/dsh-hdr2 "$DL"; rm -f "$JAR"
timeout 150 env NODE_OPTIONS=--max-old-space-size=1536 DSH_HOME=/tmp/dsh-hdr2 \
  "$DSH" --profile web -- --host 127.0.0.1 --port $PORT --no-open > $OUT/pl2.log 2>&1 &
P=$!
for i in $(seq 1 400); do curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null && break; kill -0 $P 2>/dev/null || break; sleep 0.2; done
sleep 2
TOK=$(grep -oE "token=[A-Za-z0-9_.-]+" $OUT/pl2.log | head -1)
curl -s -c "$JAR" -o /dev/null -L --max-time 10 "http://127.0.0.1:$PORT/?$TOK"
for A in assets/index-CN7NIWNw.js assets/vendor-DcuzkuQH.js assets/index-BxpfOGf3.css assets/vendor-DV2921Zo.css; do
  B=$(echo "$A" | tr "/" "_")
  CODE=$(curl -s -b "$JAR" -o "$DL/$B" -w "%{http_code}" -D "$DL/$B.h" --max-time 60 -H "Accept-Encoding: gzip, br" "http://127.0.0.1:$PORT/$A")
  W=$(stat -c%s "$DL/$B")
  ENC=$(grep -i "^content-encoding" "$DL/$B.h" | tr -d "\r" | cut -d" " -f2)
  RAW=$(gzip -dc "$DL/$B" 2>/dev/null | wc -c)
  printf "%-28s http=%s enc=%-6s wire=%-9s raw=%-9s\n" "$A" "$CODE" "${ENC:-none}" "$W" "$RAW"
done
echo
echo "=== also fetch with gzip only (no br) to see if br changes anything ==="
for A in assets/index-CN7NIWNw.js assets/vendor-DcuzkuQH.js; do
  B=$(echo "$A" | tr "/" "_")
  W=$(curl -s -b "$JAR" -o /dev/null -w "%{size_download}" --max-time 60 -H "Accept-Encoding: gzip" "http://127.0.0.1:$PORT/$A")
  W2=$(curl -s -b "$JAR" -o /dev/null -w "%{size_download}" --max-time 60 -H "Accept-Encoding: br" "http://127.0.0.1:$PORT/$A")
  W3=$(curl -s -b "$JAR" -o /dev/null -w "%{size_download}" --max-time 60 -H "Accept-Encoding: identity" "http://127.0.0.1:$PORT/$A")
  echo "$A gzip=$W br=$W2 identity=$W3"
done
kill -TERM $P 2>/dev/null; sleep 2; kill -9 $P 2>/dev/null; wait $P 2>/dev/null
