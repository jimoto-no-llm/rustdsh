#!/bin/sh
# Install recommended dsh plugins into a profile (idempotent per package).
# Also installs the bundled rdsh plugins (rdsh settings UI) so they are
# available by default.
# Usage: [PROFILE=headless] [DRY_RUN=1] [SOUND=0] [GITVIEW=0] [COMPUTE=1] [EASY_WORK=1] [SUBAGENTS=1] ./plugins/install.sh
# PROFILE=desktop targets the Electron application's reserved profile: the npm
# dsh CLI refuses it, so the work is forwarded to the Desktop-installed command
# through `rdsh desktop install` (or you install the packages from the app's
# own Plugins page).
# Third-party Web UI plugins default on for web/desktop (both MIT, used with
# upstream permission; see Credits in README.md and plugins/recommended.md):
# - sound/desktop notifications (cwd514/dsh-sound-notifications, zero deps)
# - Git panel (yugapor/dsh-gitview).
# They are browser client plugins, so PROFILE=web is the intended target.
# Set SOUND=0 or GITVIEW=0 to skip one. Other profiles can opt in with =1.
set -u
PROFILE="${PROFILE:-headless}"
DRY_RUN="${DRY_RUN:-0}"
case "$PROFILE" in web|desktop) BROWSER_PLUGINS_DEFAULT=1 ;; *) BROWSER_PLUGINS_DEFAULT=0 ;; esac
SOUND="${SOUND:-$BROWSER_PLUGINS_DEFAULT}"
GITVIEW="${GITVIEW:-$BROWSER_PLUGINS_DEFAULT}"
COMPUTE="${COMPUTE:-0}"
EASY_WORK="${EASY_WORK:-0}"
SUBAGENTS="${SUBAGENTS:-0}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLED="rdsh-settings"
[ "$COMPUTE" = "1" ] && BUNDLED="$BUNDLED rdsh-compute"
[ "$EASY_WORK" = "1" ] && BUNDLED="$BUNDLED rdsh-easy-work"
[ "$SUBAGENTS" = "1" ] && BUNDLED="$BUNDLED rdsh-subagent-optimizer"

# SOUND/GITVIEW follow the browser-profile default; features.sound=false and
# features.gitview=false in rdsh.json are the vetoes. A missing/corrupt file,
# an absent id, or no node keeps the previous behavior, so the feature switch
# never removes an offer by surprise.
sound_enabled() {
  [ "$SOUND" = "1" ] || return 1
  command -v node >/dev/null 2>&1 || return 0
  settings="${DSH_HOME:-${HOME:-}/.dsh}/rdsh.json"
  node -e '
    const fs = require("node:fs");
    try {
      const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(doc && doc.features && doc.features.sound === false ? 1 : 0);
    } catch { process.exit(0); }
  ' "$settings" 2>/dev/null
}
gitview_enabled() {
  [ "$GITVIEW" = "1" ] || return 1
  command -v node >/dev/null 2>&1 || return 0
  settings="${DSH_HOME:-${HOME:-}/.dsh}/rdsh.json"
  node -e '
    const fs = require("node:fs");
    try {
      const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(doc && doc.features && doc.features.gitview === false ? 1 : 0);
    } catch { process.exit(0); }
  ' "$settings" 2>/dev/null
}
PKGS="
@deepseek-ai/dsh-tool-present
@deepseek-ai/dsh-tool-ask-user
@deepseek-ai/dsh-tool-str-replace-editor
@deepseek-ai/dsh-skill-office
@deepseek-ai/dsh-hooks-claude-code
@deepseek-ai/dsh-tool-bash-persistent
@deepseek-ai/dsh-mcp-client
"

# The Desktop profile is owned by the Electron application. The npm dsh CLI
# refuses to manage it, so every package goes through the Desktop-installed
# command, resolved and invoked by `rdsh desktop install`.
if [ "$PROFILE" = "desktop" ]; then
  RDSH="${RDSH_BIN:-rdsh}"
  if ! command -v "$RDSH" >/dev/null 2>&1; then
    echo "PROFILE=desktop needs the rdsh launcher on PATH (or set RDSH_BIN)" >&2
    echo "manual path: open DeepSeek Harness once, quit it, then add these" >&2
    echo "packages on the app's Plugins page:" >&2
    for p in $PKGS; do echo "  $p" >&2; done
    for p in $BUNDLED; do echo "  $REPO_ROOT/plugins/$p" >&2; done
    echo "  github:cwd514/dsh-sound-notifications (default; SOUND=0 to skip)" >&2
    echo "  github:yugapor/dsh-gitview (default; GITVIEW=0 to skip)" >&2
    exit 1
  fi
  set -- --no-bundled
  for p in $PKGS; do set -- "$@" --package "$p"; done
  for p in $BUNDLED; do set -- "$@" --package "$REPO_ROOT/plugins/$p"; done
  if sound_enabled; then set -- "$@" --package github:cwd514/dsh-sound-notifications; fi
  if gitview_enabled; then set -- "$@" --package github:yugapor/dsh-gitview; fi
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s ' "$RDSH" desktop install "$@"
    printf '\n'
    exit 0
  fi
  if "$RDSH" desktop install "$@"; then
    echo "done: Desktop profile plugins attached; reopen DeepSeek Harness"
    exit 0
  fi
  echo "FAILED: Desktop profile install (see the Desktop command output above)" >&2
  exit 1
fi

ok=0
fail=0
for p in $PKGS; do
  if [ "$DRY_RUN" = "1" ]; then
    echo "dsh plugin --profile $PROFILE add $p"
    ok=$((ok + 1))
  else
    if dsh plugin --profile "$PROFILE" add "$p"; then
      echo "installed: $p"
      ok=$((ok + 1))
    else
      echo "FAILED: $p" >&2
      fail=$((fail + 1))
    fi
  fi
done
for p in $BUNDLED; do
  if [ "$DRY_RUN" = "1" ]; then
    echo "dsh plugin --profile $PROFILE add $REPO_ROOT/plugins/$p"
    ok=$((ok + 1))
  else
    if dsh plugin --profile "$PROFILE" add "$REPO_ROOT/plugins/$p"; then
      echo "installed: $p (bundled)"
      ok=$((ok + 1))
    else
      echo "FAILED: $p" >&2
      fail=$((fail + 1))
    fi
  fi
done
if sound_enabled; then
  p="github:cwd514/dsh-sound-notifications"
  if [ "$DRY_RUN" = "1" ]; then
    echo "dsh plugin --profile $PROFILE add $p"
    ok=$((ok + 1))
  else
    if dsh plugin --profile "$PROFILE" add "$p"; then
      echo "installed: $p (third-party sound notifications)"
      ok=$((ok + 1))
    else
      echo "FAILED: $p" >&2
      fail=$((fail + 1))
    fi
  fi
fi
if gitview_enabled; then
  p="github:yugapor/dsh-gitview"
  if [ "$DRY_RUN" = "1" ]; then
    echo "dsh plugin --profile $PROFILE add $p"
    ok=$((ok + 1))
  else
    if dsh plugin --profile "$PROFILE" add "$p"; then
      echo "installed: $p (third-party git panel)"
      ok=$((ok + 1))
    else
      echo "FAILED: $p" >&2
      fail=$((fail + 1))
    fi
  fi
fi
echo "done: $ok ok, $fail failed (profile: $PROFILE)"
[ "$fail" -eq 0 ]
