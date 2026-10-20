#!/usr/bin/env bash
# Three-way container comparison of the DSH web UI delivery path.
#
#   A  current   shipped dsh        compressionLevel 1, no cache headers
#   B  gzip+hdrs shipped dsh + patch level 6 + rdsh-web-cache header tap
#   C  rust      rdsh-launched dsh  brotli/gzip precompressed by Rust at boot,
#                                   served by the plugin with immutable + ETag
#
# All three run in the SAME image (node:22-trixie) so the only differences are
# the changes under test. trixie is required because the rdsh binary links
# glibc 2.39+ and node:22-slim only has 2.36.
#
# Each variant keeps one DSH_HOME across rounds, which is how the tool is
# actually used: variant C pays the Rust compression cost on the first boot and
# hits its on-disk cache afterwards, and both phases are reported.
set -u

IMAGE=node:22-trixie
DSH=/home/sahen/.local/opt/dsh-original
RDSH=/var/tmp/wt-uiperf/target/release/rdsh
PLUGIN=/var/tmp/wt-uiperf/plugins/rdsh-web-cache
ROUNDS=${ROUNDS:-5}
WORK=/tmp/ct3
OUT=/tmp/ct3-results.txt
CLI=/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
ORIG=/opt/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
ASSET_DIR="$DSH/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets"
mapfile -t ASSETS < <(cd "$ASSET_DIR" && ls -1 *.js *.css 2>/dev/null | sort)

rm -rf "$WORK"; mkdir -p "$WORK"

write_profile() {
  local home=$1 variant=$2 web="$1/profiles/web"
  mkdir -p "$web"
  cat > "$web/package.json" <<'JSON'
{"name":"dsh-profile-web","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}
JSON
  printf '# root\n[]\n' > "$web/cordis.yml"
  printf 'packages:\n  - .\n\nnodeLinker: hoisted\n' > "$web/pnpm-workspace.yaml"
  printf '# patch\n[]\n' > "$web/cordis.patch.yml"

  case "$variant" in
    current) ;;
    gzip)
      mkdir -p "$web/node_modules/rdsh-web-cache"
      cp -r "$PLUGIN"/. "$web/node_modules/rdsh-web-cache"/
      cat > "$web/cordis.patch.yml" <<'YAML'
- id: webserver
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
    tls: !!js ctx.webStartup.tls
    compression: gzip
    compressionLevel: 6
    compressionThresholdBytes: 1024
- insert:
    - id: rdsh-web-cache
      name: "rdsh-web-cache"
      config: {}
YAML
      ;;
    rust)
      mkdir -p "$web/node_modules/rdsh-web-cache"
      cp -r "$PLUGIN"/. "$web/node_modules/rdsh-web-cache"/
      cat > "$web/cordis.patch.yml" <<'YAML'
- insert:
    - id: rdsh-web-cache
      name: "rdsh-web-cache"
      config: {}
YAML
      ;;
  esac
}

start() {
  local variant=$1 home=$2 port=$3 name=$4
  docker rm -f "$name" >/dev/null 2>&1 || true
  local common=(-d --name "$name" --security-opt label=disable --network=host
    -v "$DSH":/opt/dsh:ro -v "$home":/dsh-home
    -e DSH_HOME=/dsh-home -e HOME=/root
    -w /opt/dsh/lib/node_modules/@deepseek-ai/dsh)
  if [ "$variant" = rust ]; then
    # Invoked as "dsh" so rdsh takes its delegated-dsh path, and told where the
    # real dsh lives because the container has no ~/.local/bin.
    docker run "${common[@]}" -v "$RDSH":/usr/local/bin/dsh:ro \
      -e RDSH_ORIG_BIN="$CLI" \
      "$IMAGE" dsh --profile web -- --host 127.0.0.1 --port "$port" >/dev/null 2>&1
  else
    docker run "${common[@]}" "$IMAGE" \
      node "$CLI" --profile web -- --host 127.0.0.1 --port "$port" >/dev/null 2>&1
  fi
}

wait_ready() {
  local port=$1 name=$2 t0=$3
  local code=000
  for _ in $(seq 1 3000); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$port/assets/${ASSETS[0]}" 2>/dev/null)
    [ "$code" = "200" ] && break
    docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -q true || break
    sleep 0.05
  done
  echo "$code"
}

measure() {
  local variant=$1 port=$2 round=$3 label=${4:-}
  local home="$WORK/home-$variant"
  local name="ct3-$variant"
  start "$variant" "$home" "$port" "$name"
  local t0 t1 code
  t0=$(date +%s%N)
  code=$(wait_ready "$port" "$name" "$t0")
  t1=$(date +%s%N)
  local ready_ms=$(( (t1 - t0) / 1000000 ))

  if [ "$code" != "200" ]; then
    echo "RESULT $variant r$round FAILED http=$code"
    docker logs "$name" 2>&1 | grep -viE 'emulate docker' | tail -6 | sed 's/^/    /'
    docker rm -f "$name" >/dev/null 2>&1
    return 1
  fi

  local total=0 sz enc
  for a in "${ASSETS[@]}"; do
    sz=$(curl -s -H 'Accept-Encoding: br, gzip' -o /dev/null -w '%{size_download}' "http://127.0.0.1:$port/assets/$a")
    total=$((total + sz))
  done
  enc=$(curl -s -D - -o /dev/null -H 'Accept-Encoding: br, gzip' "http://127.0.0.1:$port/assets/${ASSETS[1]:-${ASSETS[0]}}" \
        | tr -d '\r' | awk 'tolower($1)=="content-encoding:"{print $2}')
  local cc
  cc=$(curl -s -D - -o /dev/null "http://127.0.0.1:$port/assets/${ASSETS[1]:-${ASSETS[0]}}" \
       | tr -d '\r' | awk 'tolower($1)=="cache-control:"{ $1=""; sub(/^ /,""); print; exit }')

  echo "RESULT $variant r$round${label:+ $label} ready_ms=$ready_ms bytes=$total encoding=${enc:-identity} cache_control=${cc:-none}"
  docker rm -f "$name" >/dev/null 2>&1
  return 0
}

{
  echo "=== DSH web UI: three-way container comparison ==="
  echo "image  : $IMAGE ($(docker run --rm "$IMAGE" node --version 2>/dev/null | grep -v Emulate | tail -1))"
  echo "assets : ${ASSETS[*]}"
  echo "rounds : $ROUNDS"
  echo
  for v in current gzip rust; do
    rm -rf "$WORK/home-$v"
    write_profile "$WORK/home-$v" "$v"
  done

  # Cold start for the rust variant: first boot builds the compression cache.
  echo "-- cold: rust builds its cache --"
  measure rust 18301 0 "(cold)"
  echo

  echo "-- warm rounds (cache present for rust) --"
  for r in $(seq 1 "$ROUNDS"); do
    measure current 18310 "$r"
    measure gzip    18311 "$r"
    measure rust    18312 "$r"
  done

  echo
  echo "=== cache dir produced by rdsh ==="
  find "$WORK/home-rust/webui" -maxdepth 2 -type d 2>/dev/null | head -3
  find "$WORK/home-rust/webui" -name manifest.json 2>/dev/null | head -2
  echo DONE
} 2>&1 | grep -viE 'emulate docker cli' | tee "$OUT"
