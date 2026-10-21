#!/usr/bin/env bash
# webui-bench.sh — measured boot + payload benchmark for the DSH web UI.
#
# Reproduces docs/WEBUI-PERFORMANCE.md. Every run boots a throwaway dsh web
# instance on its own port, waits for the HTTP listener, and records the
# elapsed time. The production service (default 127.0.0.1:3080) is never
# touched.
#
# Usage:
#   scripts/webui-bench.sh boot [--n 6] [--port 39200] [--cache DIR]
#   scripts/webui-bench.sh payload [--port 3080] [--token-file FILE]
#   scripts/webui-bench.sh profile [--n 1]
#
# Environment:
#   DSH_ORIG  path to the dsh launcher (default: dsh-orig next to rdsh)
set -euo pipefail

N=6
PORT=39200
CACHE=""
MODE=${1:-boot}
shift || true
while [ $# -gt 0 ]; do
    case "$1" in
        --n) N="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --cache) CACHE="$2"; shift 2 ;;
        --token-file) TOKEN_FILE="$2"; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

DSH_ORIG=${DSH_ORIG:-$(command -v dsh-orig || echo /home/sahen/.local/bin/dsh-orig)}

# boot_median: N isolated boots, each on its own port, printing every sample.
boot_median() {
    local base="$PORT" i
    for i in $(seq 0 $((N - 1))); do
        local p=$((base + i))
        local start end
        start=$(date +%s.%N)
        if [ -n "$CACHE" ]; then
            env NODE_COMPILE_CACHE="$CACHE" NODE_OPTIONS="--max-old-space-size=1536" \
                "$DSH_ORIG" --profile web -- --host 127.0.0.1 --port "$p" --no-open \
                > "/tmp/webui-bench-$p.log" 2>&1 &
        else
            env NODE_OPTIONS="--max-old-space-size=1536" \
                "$DSH_ORIG" --profile web -- --host 127.0.0.1 --port "$p" --no-open \
                > "/tmp/webui-bench-$p.log" 2>&1 &
        fi
        local pid=$!
        local ready=""
        for _ in $(seq 1 400); do
            if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$p/" 2>/dev/null; then
                ready=$(date +%s.%N); break
            fi
            kill -0 "$pid" 2>/dev/null || { echo "port $p: process died" >&2; break; }
            sleep 0.2
        done
        if [ -n "$ready" ]; then
            echo "$ready - $start" | bc
        else
            echo "port $p: timeout" >&2
        fi
        kill -TERM "$pid" 2>/dev/null || true
        sleep 1.5
        kill -9 "$pid" 2>/dev/null || true
    done
}

case "$MODE" in
    boot)
        echo "# boot samples (seconds), n=$N cache=${CACHE:-none}"
        boot_median | tee /tmp/webui-boot-samples.txt
        python3 - <<'PY'
import statistics
vals=[]
for line in open('/tmp/webui-boot-samples.txt'):
    line=line.strip()
    try: vals.append(float(line))
    except ValueError: pass
if vals:
    print("# median=%.3f mean=%.3f min=%.3f max=%.3f n=%d" % (
        statistics.median(vals), statistics.mean(vals), min(vals), max(vals), len(vals)))
PY
        ;;
    payload)
        echo "# HTTP payload sizes"
        base="http://127.0.0.1:$PORT"
        for a in assets/index-CN7NIWNw.js assets/vendor-DcuzkuQH.js \
                 assets/vendor-DV2921Zo.css assets/index-BxpfOGf3.css; do
            curl -s -H "Accept-Encoding: gzip" -o /dev/null \
                -w "$a gzip=%{size_download} bytes t=%{time_total}s\n" "$base/$a"
        done
        ;;
    profile)
        echo "# CPU profile of one boot (main-thread hotspots)"
        rm -rf /tmp/dsh-prof && mkdir -p /tmp/dsh-prof
        env NODE_OPTIONS="--max-old-space-size=1536 --cpu-prof --cpu-prof-dir=/tmp/dsh-prof" \
            "$DSH_ORIG" --profile web -- --host 127.0.0.1 --port "$PORT" --no-open \
            > /tmp/webui-prof.log 2>&1 &
        pid=$!
        for _ in $(seq 1 400); do
            curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null && break
            sleep 0.2
        done
        sleep 3
        kill -TERM "$pid" 2>/dev/null || true; sleep 2; kill -9 "$pid" 2>/dev/null || true
        echo "profiles written to /tmp/dsh-prof ($(ls /tmp/dsh-prof | wc -l) files)"
        ;;
    *)
        echo "usage: $0 {boot|payload|profile} [--n N] [--port P] [--cache DIR]" >&2
        exit 2
        ;;
esac
