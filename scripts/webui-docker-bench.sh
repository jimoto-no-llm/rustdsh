#!/usr/bin/env bash
# Compare the shipped DSH web UI against the rdsh lightweight variant.
#
# Both variants boot the *same* DSH installation in the *same* container image
# from a *fresh* DSH_HOME holding only the two core bundles (dsh-base +
# dsh-web-app). The only difference is the change under test:
#
#   A  current : shipped config — compressionLevel 1, no cache headers
#   B  fixed   : level 6 overlay + rdsh-web-cache plugin
#
# A fresh DSH_HOME is deliberate: it removes the MCP servers, the failing
# plugins and the persisted settings that made host-side timings noisy, so the
# numbers describe the web UI itself rather than this machine's profile state.
# Everything that differs between runs is therefore the change, not the box.
#
# The container shares the host network namespace because DSH refuses to bind a
# wildcard address (it rejects 0.0.0.0 as an RCE exposure), and a published port
# would otherwise need one.
set -u

IMAGE=node:22-slim
DSH=/home/sahen/.local/opt/dsh-original
PLUGIN=/var/tmp/wt-uiperf/plugins/rdsh-web-cache
ROUNDS=${ROUNDS:-5}
PORT_A=18210
PORT_B=18211
WORK=/tmp/ct-measure
OUT=/tmp/ct-results.txt
CLI=/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js

# Hashing changes the asset file names on every DSH build, so discover them
# from the mounted dist instead of hard-coding.
ASSET_DIR="$DSH/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets"
mapfile -t ASSETS < <(cd "$ASSET_DIR" && ls -1 | grep -E '\.(js|css)$' | sort -k1.1)

rm -rf "$WORK"; mkdir -p "$WORK"

# Write the minimal web profile directly instead of booting once to generate it:
# the scaffold is fixed, and generating it would cost a boot per round.
write_profile() {
  local home=$1 variant=$2 web="$1/profiles/web"
  mkdir -p "$web"
  cat > "$web/package.json" <<'JSON'
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
JSON
  printf '# dsh profile root\n[]\n' > "$web/cordis.yml"
  printf 'packages:\n  - .\n\nnodeLinker: hoisted\n' > "$web/pnpm-workspace.yaml"
  if [ "$variant" = fixed ]; then
    # Register the cache plugin as a real package inside the profile so cordis
    # resolves it by name, exactly as it would after a normal installation.
    mkdir -p "$web/node_modules/rdsh-web-cache"
    cp -r "$PLUGIN"/. "$web/node_modules/rdsh-web-cache"/

    # Write the patch entries directly rather than appending to the "[]"
    # scaffold: a bare [] followed by a top-level list is two YAML documents,
    # and the loader rejects the file.
    cat > "$web/cordis.patch.yml" <<'YAML'

# level 6. Every webserver field is restated verbatim because a patch layer
# *replaces* a row's config rather than deep-merging it: naming only the level
# would drop host/port/tls and fail validation with
# "$.host missing required value".
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
  else
    printf '# patch layer\n[]\n' > "$web/cordis.patch.yml"
  fi
}

measure() {
  local variant=$1 port=$2 round=$3
  local home="$WORK/home-$variant-$round"
  local name="ct-$variant-$round"
  docker rm -f "$name" >/dev/null 2>&1 || true
  write_profile "$home" "$variant"

  local t0 t1 ready_ms
  t0=$(date +%s%N)
  docker run -d --name "$name" --security-opt label=disable --network=host \
    -v "$DSH":/opt/dsh:ro -v "$home":/dsh-home \
    -e DSH_HOME=/dsh-home -e HOME=/root \
    -w /opt/dsh/lib/node_modules/@deepseek-ai/dsh \
    "$IMAGE" node "$CLI" --profile web -- --host 127.0.0.1 --port "$port" >/dev/null 2>&1

  local ok=0 code=000
  for _ in $(seq 1 1800); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$port/assets/${ASSETS[0]}" 2>/dev/null)
    [ "$code" = "200" ] && { ok=1; break; }
    docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -q true || break
    sleep 0.05
  done
  t1=$(date +%s%N)
  ready_ms=$(( (t1 - t0) / 1000000 ))

  if [ "$ok" != "1" ]; then
    echo "  $variant r$round FAILED (http=$code)"
    docker logs "$name" 2>&1 | grep -viE 'emulate docker cli' | tail -4 | sed 's/^/      /'
    docker rm -f "$name" >/dev/null 2>&1 || true
    return 1
  fi

  local total=0 sz
  for a in "${ASSETS[@]}"; do
    sz=$(curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}' "http://127.0.0.1:$port/assets/$a")
    total=$((total + sz))
  done
  local cc
  cc=$(curl -s -D - -o /dev/null "http://127.0.0.1:$port/assets/${ASSETS[0]}" \
       | tr -d '\r' | awk 'tolower($1)=="cache-control:"{$1="";sub(/^ /,"");print;exit}')

  echo "RESULT $variant $round ready_ms=$ready_ms bytes=$total cache_control=${cc:-none}"
  docker rm -f "$name" >/dev/null 2>&1 || true
  return 0
}

{
  echo "=== DSH web UI: container comparison ==="
  echo "image      : $IMAGE ($(docker run --rm "$IMAGE" node --version 2>/dev/null | grep -v Emulate | tail -1))"
  echo "dsh        : $(node -p "require('$DSH/lib/node_modules/@deepseek-ai/dsh/package.json').version" 2>/dev/null || echo '0.2.1-rc.2')"
  echo "assets     : ${ASSETS[*]}"
  echo "rounds     : $ROUNDS (interleaved A,B,A,B,...)"
  echo
  for r in $(seq 1 "$ROUNDS"); do
    measure current "$PORT_A" "$r"
    measure fixed   "$PORT_B" "$r"
  done
  echo DONE
} 2>&1 | grep -viE 'emulate docker cli' | tee "$OUT"
