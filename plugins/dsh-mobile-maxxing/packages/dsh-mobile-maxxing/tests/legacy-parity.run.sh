#!/usr/bin/env bash
# Reproducible baseline/unified browser parity runner.
#
#   BASELINE_REPO=/path/to/DSH-PWA \
#   MOBILE_UI=/path/to/rdsh-mobile-ui \
#   packages/dsh-mobile-maxxing/tests/legacy-parity.run.sh
#
# Starts two throwaway DSH homes (mktemp, never an existing home), one with the
# legacy split packages and one with this worktree, on localhost-only ports,
# then runs tests/legacy-parity.e2e.mjs. This script only kills processes it
# started after checking /proc/<pid>/{cmdline,environ} for the exact DSH home,
# port and entrypoint; it never kills whatever happens to listen on a port.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIFIED_REPO="${UNIFIED_REPO:-$(cd "$HERE/../../.." && pwd)}"
: "${BASELINE_REPO:?set BASELINE_REPO to the legacy DSH-PWA checkout}"
BASELINE_REPO="$(realpath "$BASELINE_REPO")"

BASELINE_PORT="${BASELINE_PORT:-3197}"
UNIFIED_PORT="${UNIFIED_PORT:-3196}"
CDP_PORT="${CDP_PORT:-9466}"
CHROME="${CHROME:-google-chrome}"
NODE="${NODE:-$(command -v node)}"
if [ -x "$HOME/.nvm/versions/node/v22.22.2/bin/node" ]; then
	NODE="$HOME/.nvm/versions/node/v22.22.2/bin/node"
fi
DSH_BIN="${DSH_BIN:-$HOME/.dsh/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js}"
WEB_MODULES="${WEB_MODULES:-$HOME/.dsh/profiles/web/node_modules}"
MOBILE_UI="${MOBILE_UI:-$WEB_MODULES/rdsh-mobile-ui}"

if [ -n "${QA_ROOT:-}" ]; then
	mkdir -p "$QA_ROOT"
	QA_ROOT="$(realpath "$QA_ROOT")"
	case "$QA_ROOT" in
		/|"$HOME"|"$HOME/.dsh"|"$HOME/.dsh/"*) echo "refusing QA_ROOT=$QA_ROOT" >&2; exit 2 ;;
	esac
else
	QA_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-ui-parity.XXXXXX")"
fi
RUN_DIR="$(mktemp -d "$QA_ROOT/run.XXXXXX")"
mkdir -p "$RUN_DIR/logs" "$RUN_DIR/shots"
BASELINE_HOME="$RUN_DIR/home-baseline"
UNIFIED_HOME="$RUN_DIR/home-unified"
BASELINE_PID=""
UNIFIED_PID=""
CLEANED=0

owns_server() {
	local pid="$1" home="$2" port="$3"
	[ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] || return 1
	tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Fq -- "$DSH_BIN" || return 1
	tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Fq -- "--port $port" || return 1
	[ -r "/proc/$pid/environ" ] || return 1
	tr '\0' '\n' < "/proc/$pid/environ" | grep -Fxq -- "DSH_HOME=$home" || return 1
	return 0
}

kill_owned() {
	local pid="$1" home="$2" port="$3" signal="$4"
	if ! kill -0 "$pid" 2>/dev/null; then
		return 0
	fi
	if ! owns_server "$pid" "$home" "$port"; then
		echo "WARNING: pid $pid on :$port is not the process this run started; leaving it alone" >&2
		return 1
	fi
	local pgid
	pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
	if [ -n "$pgid" ] && [ "$pgid" = "$pid" ]; then
		kill "-$signal" -- "-$pgid" 2>/dev/null || true
	else
		kill "-$signal" "$pid" 2>/dev/null || true
	fi
}

cleanup() {
	[ "$CLEANED" = "1" ] && return
	CLEANED=1
	kill_owned "$BASELINE_PID" "$BASELINE_HOME" "$BASELINE_PORT" TERM || true
	kill_owned "$UNIFIED_PID" "$UNIFIED_HOME" "$UNIFIED_PORT" TERM || true
	sleep 1
	kill_owned "$BASELINE_PID" "$BASELINE_HOME" "$BASELINE_PORT" KILL || true
	kill_owned "$UNIFIED_PID" "$UNIFIED_HOME" "$UNIFIED_PORT" KILL || true
}
trap cleanup EXIT INT TERM

for port in "$BASELINE_PORT" "$UNIFIED_PORT" "$CDP_PORT"; do
	if ss -ltn 2>/dev/null | grep -q ":$port "; then
		echo "refusing to start: 127.0.0.1:$port is already in use" >&2
		exit 2
	fi
done

provision() {
	local home="$1" plugin="$2" legacy="$3"
	mkdir -p "$home/profiles/parity/node_modules"
	ln -s "$WEB_MODULES/@deepseek-ai" "$home/profiles/parity/node_modules/@deepseek-ai"
	ln -s "$plugin" "$home/profiles/parity/node_modules/dsh-mobile-maxxing"
	if [ "$legacy" = "1" ]; then
		ln -s "$BASELINE_REPO/mobile-ux" "$home/profiles/parity/node_modules/rdsh-mobile-ux"
		ln -s "$MOBILE_UI" "$home/profiles/parity/node_modules/rdsh-mobile-ui"
	fi
	"$NODE" - "$home/profiles/parity/package.json" "$plugin" "$legacy" "$BASELINE_REPO/mobile-ux" "$MOBILE_UI" <<'EOF'
const fs = require("fs");
const [path, plugin, legacy, mobileUx, mobileUi] = process.argv.slice(2);
const dependencies = {
	"@deepseek-ai/dsh-base": "0.2.1-rc.2",
	"@deepseek-ai/dsh-web-app": "0.2.1-rc.2",
	"dsh-mobile-maxxing": `link:${plugin}`,
};
const bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
if (legacy === "1") {
	dependencies["rdsh-mobile-ux"] = `link:${mobileUx}`;
	dependencies["rdsh-mobile-ui"] = `link:${mobileUi}`;
	bundles.push("rdsh-mobile-ui");
}
bundles.push("dsh-mobile-maxxing");
if (legacy === "1") bundles.push("rdsh-mobile-ux");
fs.writeFileSync(path, `${JSON.stringify({
	name: "dsh-profile-parity",
	private: true,
	dependencies,
	dsh: { profile: { bundles, patchReload: "live" } },
}, null, 2)}\n`);
EOF
	printf '%s\n' '[]' > "$home/profiles/parity/cordis.yml"
	cat > "$home/profiles/parity/cordis.patch.yml" <<'EOF'
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
    fontSize: 14
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: en
EOF
}

provision "$BASELINE_HOME" "$BASELINE_REPO" 1
provision "$UNIFIED_HOME" "$UNIFIED_REPO/packages/dsh-mobile-maxxing" 0

start_server() {
	local home="$1" port="$2" log="$3" pidfile="$4"
	: > "$log"
	(
		cd "$RUN_DIR"
		DSH_HOME="$home" setsid "$NODE" "$DSH_BIN" --profile parity --host 127.0.0.1 --port "$port" --no-open \
			> "$log" 2>&1 &
		echo $! > "$pidfile"
	)
	local pid
	pid="$(cat "$pidfile")"
	for _ in $(seq 1 160); do
		if curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then
			if ! owns_server "$pid" "$home" "$port"; then
				echo "server on :$port (pid $pid) is not owned by this run" >&2
				tr '\0' ' ' < "/proc/$pid/cmdline" >&2 || true
				kill_owned "$pid" "$home" "$port" TERM || true
				return 1
			fi
			echo "$pid"
			return 0
		fi
		sleep 0.25
	done
	echo "server on :$port did not become ready (pid $pid)" >&2
	tail -40 "$log" >&2 || true
	kill_owned "$pid" "$home" "$port" TERM || true
	return 1
}

echo "starting baseline DSH on :$BASELINE_PORT (throwaway home $BASELINE_HOME)"
BASELINE_PID="$(start_server "$BASELINE_HOME" "$BASELINE_PORT" "$RUN_DIR/logs/baseline-server.log" "$RUN_DIR/logs/baseline-server.pid")" || exit 2
echo "starting unified DSH on :$UNIFIED_PORT (throwaway home $UNIFIED_HOME)"
UNIFIED_PID="$(start_server "$UNIFIED_HOME" "$UNIFIED_PORT" "$RUN_DIR/logs/unified-server.log" "$RUN_DIR/logs/unified-server.pid")" || exit 2

token_of() {
	awk 'match($0, /token=[A-Za-z0-9_-]+/) { print substr($0, RSTART + 6, RLENGTH - 6); exit }' "$1"
}
wait_token() {
	local log="$1" token=""
	for _ in $(seq 1 40); do
		token="$(token_of "$log")"
		[ -n "$token" ] && { echo "$token"; return 0; }
		sleep 0.25
	done
	return 1
}
BASELINE_TOKEN="$(wait_token "$RUN_DIR/logs/baseline-server.log")"
UNIFIED_TOKEN="$(wait_token "$RUN_DIR/logs/unified-server.log")"
if [ -z "$BASELINE_TOKEN" ] || [ -z "$UNIFIED_TOKEN" ]; then
	echo "could not read access tokens from the server logs" >&2
	exit 2
fi

echo "running parity scenarios (artifacts: $RUN_DIR)"
set +e
BASE_URL_BASELINE="http://127.0.0.1:$BASELINE_PORT/?token=$BASELINE_TOKEN" \
BASE_URL_UNIFIED="http://127.0.0.1:$UNIFIED_PORT/?token=$UNIFIED_TOKEN" \
QA_OUT="$RUN_DIR" CDP_PORT="$CDP_PORT" CHROME="$CHROME" \
	"$NODE" "$UNIFIED_REPO/packages/dsh-mobile-maxxing/tests/legacy-parity.e2e.mjs"
STATUS=$?
set -e

cleanup
trap - EXIT INT TERM
for port in "$BASELINE_PORT" "$UNIFIED_PORT" "$CDP_PORT"; do
	if ss -ltn 2>/dev/null | grep -q ":$port "; then
		echo "LEFTOVER: 127.0.0.1:$port is still listening after cleanup" >&2
		STATUS=3
	fi
done
echo "done (status $STATUS); logs: $RUN_DIR/logs, screenshots: $RUN_DIR/shots"
exit "$STATUS"
