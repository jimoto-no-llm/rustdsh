#!/bin/sh
# Install recommended dsh plugins into a profile (idempotent per package).
# Also installs the bundled rdsh plugins (rdsh settings UI) so they are
# available by default.
# Usage: [PROFILE=headless] [DRY_RUN=1] [SOUND=1] ./plugins/install.sh
# SOUND=1 also installs the third-party Web UI sound/desktop notifications
# (MIT, cwd514/dsh-sound-notifications, zero dependencies). It is a browser
# client plugin, so PROFILE=web is the intended target.
set -u
PROFILE="${PROFILE:-headless}"
DRY_RUN="${DRY_RUN:-0}"
SOUND="${SOUND:-0}"

# SOUND=1 is this installer's own opt-in; features.sound=false in rdsh.json is
# the veto. A missing/corrupt file, an absent id, or no node keeps the previous
# behavior, so the feature switch never removes an offer by surprise.
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
PKGS="
@deepseek-ai/dsh-tool-present
@deepseek-ai/dsh-tool-ask-user
@deepseek-ai/dsh-tool-str-replace-editor
@deepseek-ai/dsh-skill-office
@deepseek-ai/dsh-hooks-claude-code
@deepseek-ai/dsh-tool-bash-persistent
@deepseek-ai/dsh-mcp-client
"
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
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for p in rdsh-settings; do
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
echo "done: $ok ok, $fail failed (profile: $PROFILE)"
[ "$fail" -eq 0 ]
