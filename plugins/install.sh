#!/bin/sh
# Install dsh plugins into a profile (idempotent per package).
#
# The catalog has two tiers:
#   Essential   - installed on every run and listed first: the upstream tools
#                 plus the bundled settings UI, phone-width layout, answer
#                 guard, and the Web release banner.
#   Recommended - convenience plugins the operator opts into. Non-interactive
#                 runs keep the historical per-profile defaults, so CI and
#                 existing scripts are unchanged.
#
# Usage: [PROFILE=headless] [DRY_RUN=1] [SOUND=0] [GITVIEW=0] [COMPUTE=1]
#        [EASY_WORK=1] [SUBAGENTS=1] [UI_COMFORT=1] [INTELLIGENT_UI=1]
#        [RECOMMENDED=all|none|list|id,...]
#        ./plugins/install.sh [--recommended=all|none|list|id,...] [--list]
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
# One further third-party browser plugin is opt-in only and never part of the
# defaults: visual answers (cwd514/dsh-intelligent-ui, MIT) with
# INTELLIGENT_UI=1 or --recommended=intelligent-ui.
set -u
PROFILE="${PROFILE:-headless}"
DRY_RUN="${DRY_RUN:-0}"
case "$PROFILE" in web|desktop) BROWSER_PLUGINS_DEFAULT=1 ;; *) BROWSER_PLUGINS_DEFAULT=0 ;; esac
SOUND="${SOUND:-$BROWSER_PLUGINS_DEFAULT}"
GITVIEW="${GITVIEW:-$BROWSER_PLUGINS_DEFAULT}"
COMPUTE="${COMPUTE:-0}"
EASY_WORK="${EASY_WORK:-0}"
SUBAGENTS="${SUBAGENTS:-0}"
UI_COMFORT="${UI_COMFORT:-0}"
INTELLIGENT_UI="${INTELLIGENT_UI:-0}"
TRANSLATION="${TRANSLATION:-$BROWSER_PLUGINS_DEFAULT}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RECOMMENDED_IDS="translation compute easy-work subagents ui-comfort sound gitview intelligent-ui"

usage() {
  cat <<EOF
Usage: [PROFILE=...] [DRY_RUN=1] ./plugins/install.sh [--recommended=SPEC] [--list]
  --recommended=all       install every recommended plugin
  --recommended=none      install the essential plugins only
  --recommended=list      print the essential and recommended catalog, then exit
  --recommended=id,id     install exactly the listed recommended plugins
  --list                  alias for --recommended=list
  ids: $RECOMMENDED_IDS
Env: PROFILE DRY_RUN SOUND GITVIEW COMPUTE EASY_WORK SUBAGENTS UI_COMFORT INTELLIGENT_UI TRANSLATION
     RECOMMENDED (same values as --recommended)
EOF
}

# The catalog is printed with the essential tier first so an operator reads the
# always-installed set before the optional one.
print_plugin_catalog() {
  cat <<'EOF'
Essential plugins (always installed, listed first)
  @deepseek-ai/dsh-tool-present             final deliverables as file cards
  @deepseek-ai/dsh-tool-ask-user            ask the user mid-run
  @deepseek-ai/dsh-tool-str-replace-editor  view/create/str_replace editor tool
  @deepseek-ai/dsh-skill-office             Word/PowerPoint/Excel and PDF conversion
  @deepseek-ai/dsh-hooks-claude-code        reuse an existing Claude Code hooks.json
  @deepseek-ai/dsh-tool-bash-persistent     shell with cwd/env/jobs across calls
  @deepseek-ai/dsh-mcp-client               tools from external MCP servers
  rdsh-settings                             rdsh section in DSH settings
  rdsh-mobile-ui                            phone-width Web layout
  rdsh-answer-guard                         restate reasoning-only replies as text
  rdsh-update-banner                        Web release banner (PROFILE=web only)

Recommended plugins (optional; choose with --recommended)
  translation  rdsh-translation              Japanese translation settings and preview
  compute      rdsh-compute                  compute bridge
  easy-work    rdsh-easy-work                guided workflow entry points
  subagents    rdsh-subagent-optimizer       subagent prompt shaping
  ui-comfort   rdsh-ui-comfort               deliberate Enter in the Web chat
  sound        github:cwd514/dsh-sound-notifications   effect sounds and desktop notifications
  gitview      github:yugapor/dsh-gitview    Web sidebar Git panel
  intelligent-ui github:cwd514/dsh-intelligent-ui   interactive visual answers (render_ui)
EOF
}

# --- argument parsing --------------------------------------------------------
# Existing callers only set environment variables; arguments are additive and an
# unknown one is reported without failing the install.
RECOMMENDED_SPEC="${RECOMMENDED:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --recommended=*) RECOMMENDED_SPEC="${1#--recommended=}" ;;
    --recommended)
      shift
      if [ $# -eq 0 ]; then
        echo "plugins/install.sh: --recommended needs a value (all, none, list, or ids)" >&2
        exit 2
      fi
      RECOMMENDED_SPEC="$1"
      ;;
    --list) RECOMMENDED_SPEC="list" ;;
    --help|-h) usage; exit 0 ;;
    *) echo "plugins/install.sh: ignoring unknown argument: $1" >&2 ;;
  esac
  shift
done

if [ "$RECOMMENDED_SPEC" = "list" ]; then
  print_plugin_catalog
  exit 0
fi

# --- recommended selection ---------------------------------------------------
# Defaults reproduce the historical behavior exactly; an explicit
# --recommended/RECOMMENDED value replaces them.
rec_translation="$TRANSLATION"
rec_compute="$COMPUTE"
rec_easy_work="$EASY_WORK"
rec_subagents="$SUBAGENTS"
rec_ui_comfort="$UI_COMFORT"
rec_intelligent_ui="$INTELLIGENT_UI"
rec_sound="$SOUND"
rec_gitview="$GITVIEW"

recommended_all() {
  rec_translation=1; rec_compute=1; rec_easy_work=1; rec_subagents=1; rec_ui_comfort=1; rec_intelligent_ui=1; rec_sound=1; rec_gitview=1
}
recommended_none() {
  rec_translation=0; rec_compute=0; rec_easy_work=0; rec_subagents=0; rec_ui_comfort=0; rec_intelligent_ui=0; rec_sound=0; rec_gitview=0
}

apply_recommended_spec() {
  case "$1" in
    all) recommended_all ;;
    none) recommended_none ;;
    *)
      recommended_none
      for _id in $(printf '%s' "$1" | tr ',' ' '); do
        case "$_id" in
          translation|rdsh-translation) rec_translation=1 ;;
          compute|rdsh-compute) rec_compute=1 ;;
          easy-work|easy_work|rdsh-easy-work) rec_easy_work=1 ;;
          subagents|subagent|rdsh-subagent-optimizer) rec_subagents=1 ;;
          ui-comfort|ui_comfort|rdsh-ui-comfort) rec_ui_comfort=1 ;;
          intelligent-ui|intelligent_ui|dsh-intelligent-ui) rec_intelligent_ui=1 ;;
          sound|dsh-sound-notifications) rec_sound=1 ;;
          gitview|dsh-gitview) rec_gitview=1 ;;
          *)
            echo "plugins/install.sh: unknown recommended plugin '$_id' (ids: $RECOMMENDED_IDS)" >&2
            exit 2
            ;;
        esac
      done
      ;;
  esac
}

prompt_yes_no() { # $1 label, $2 current default (1 = yes)
  if [ "$2" = "1" ]; then _hint="Y/n"; else _hint="y/N"; fi
  printf '  install %s? [%s] ' "$1" "$_hint" >&2
  IFS= read -r _answer || _answer=""
  case "$_answer" in
    y|Y|yes|YES|1) return 0 ;;
    n|N|no|NO|0) return 1 ;;
    *) [ "$2" = "1" ] ;;
  esac
}

select_recommended_individually() {
  if prompt_yes_no "rdsh-translation (Japanese translation)" "$rec_translation"; then rec_translation=1; else rec_translation=0; fi
  if prompt_yes_no "rdsh-compute (compute bridge)" "$rec_compute"; then rec_compute=1; else rec_compute=0; fi
  if prompt_yes_no "rdsh-easy-work (file organization)" "$rec_easy_work"; then rec_easy_work=1; else rec_easy_work=0; fi
  if prompt_yes_no "rdsh-subagent-optimizer (bounded subagents)" "$rec_subagents"; then rec_subagents=1; else rec_subagents=0; fi
  if prompt_yes_no "rdsh-ui-comfort (deliberate Enter in the Web chat)" "$rec_ui_comfort"; then rec_ui_comfort=1; else rec_ui_comfort=0; fi
  if prompt_yes_no "github:cwd514/dsh-sound-notifications" "$rec_sound"; then rec_sound=1; else rec_sound=0; fi
  if prompt_yes_no "github:yugapor/dsh-gitview" "$rec_gitview"; then rec_gitview=1; else rec_gitview=0; fi
  if prompt_yes_no "github:cwd514/dsh-intelligent-ui" "$rec_intelligent_ui"; then rec_intelligent_ui=1; else rec_intelligent_ui=0; fi
}

prompt_recommended() {
  printf '\nRecommended plugins (optional):\n' >&2
  printf '  rdsh-translation, rdsh-compute, rdsh-easy-work, rdsh-subagent-optimizer,\n' >&2
  printf '  rdsh-ui-comfort, github:cwd514/dsh-sound-notifications, github:yugapor/dsh-gitview,\n' >&2
  printf '  github:cwd514/dsh-intelligent-ui\n' >&2
  printf 'Install recommended plugins? [Y/n/a=all/s=select individually] ' >&2
  IFS= read -r _answer || _answer=""
  case "$_answer" in
    n|N|no|NO) recommended_none ;;
    a|A|all) recommended_all ;;
    s|S|select) select_recommended_individually ;;
    *) : ;; # Enter keeps the profile defaults
  esac
}

if [ -n "$RECOMMENDED_SPEC" ]; then
  apply_recommended_spec "$RECOMMENDED_SPEC"
elif [ -t 0 ]; then
  prompt_recommended
fi

# Feature switches in rdsh.json are user settings; they veto a selected plugin
# but never add one. A missing/corrupt file, an absent id, or no node keeps the
# previous behavior, so a feature switch never removes an offer by surprise.
sound_feature_allowed() {
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
gitview_feature_allowed() {
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
if [ "$rec_sound" = "1" ] && ! sound_feature_allowed; then rec_sound=0; fi
if [ "$rec_gitview" = "1" ] && ! gitview_feature_allowed; then rec_gitview=0; fi

# Essential packages. The update banner is a Web client plugin whose bundle
# patch inserts itself into the profile; when the package is missing, the whole
# insert fails to import on every boot and no release notification appears
# (issue #5). pnpm also prunes links it does not manage, so the banner has to be
# installed through the same path as the settings UI.
PKGS="
@deepseek-ai/dsh-tool-present
@deepseek-ai/dsh-tool-ask-user
@deepseek-ai/dsh-tool-str-replace-editor
@deepseek-ai/dsh-skill-office
@deepseek-ai/dsh-hooks-claude-code
@deepseek-ai/dsh-tool-bash-persistent
@deepseek-ai/dsh-mcp-client
"
ESSENTIAL_BUNDLED="rdsh-settings rdsh-mobile-ui rdsh-answer-guard"
if [ "$PROFILE" = "web" ]; then
  ESSENTIAL_BUNDLED="$ESSENTIAL_BUNDLED rdsh-update-banner"
fi

RECOMMENDED_BUNDLED=""
if [ "$rec_translation" = "1" ]; then RECOMMENDED_BUNDLED="$RECOMMENDED_BUNDLED rdsh-translation"; fi
if [ "$rec_compute" = "1" ]; then RECOMMENDED_BUNDLED="$RECOMMENDED_BUNDLED rdsh-compute"; fi
if [ "$rec_easy_work" = "1" ]; then RECOMMENDED_BUNDLED="$RECOMMENDED_BUNDLED rdsh-easy-work"; fi
if [ "$rec_subagents" = "1" ]; then RECOMMENDED_BUNDLED="$RECOMMENDED_BUNDLED rdsh-subagent-optimizer"; fi
if [ "$rec_ui_comfort" = "1" ]; then RECOMMENDED_BUNDLED="$RECOMMENDED_BUNDLED rdsh-ui-comfort"; fi

# The Desktop profile is owned by the Electron application. The npm dsh CLI
# refuses to manage it, so every package goes through the Desktop-installed
# command, resolved and invoked by `rdsh desktop install`.
if [ "$PROFILE" = "desktop" ]; then
  RDSH="${RDSH_BIN:-rdsh}"
  if ! command -v "$RDSH" >/dev/null 2>&1; then
    echo "PROFILE=desktop needs the rdsh launcher on PATH (or set RDSH_BIN)" >&2
    echo "manual path: open DeepSeek Harness once, quit it, then add these" >&2
    echo "packages on the app's Plugins page:" >&2
    for p in $PKGS; do echo "  [essential] $p" >&2; done
    for p in $ESSENTIAL_BUNDLED; do echo "  [essential] $REPO_ROOT/plugins/$p" >&2; done
    for p in $RECOMMENDED_BUNDLED; do echo "  [recommended] $REPO_ROOT/plugins/$p" >&2; done
    if [ "$rec_sound" = "1" ]; then echo "  [recommended] github:cwd514/dsh-sound-notifications" >&2; fi
    if [ "$rec_gitview" = "1" ]; then echo "  [recommended] github:yugapor/dsh-gitview" >&2; fi
    if [ "$rec_intelligent_ui" = "1" ]; then echo "  [recommended] github:cwd514/dsh-intelligent-ui" >&2; fi
    exit 1
  fi
  set -- --no-bundled
  for p in $PKGS; do set -- "$@" --package "$p"; done
  for p in $ESSENTIAL_BUNDLED; do set -- "$@" --package "$REPO_ROOT/plugins/$p"; done
  for p in $RECOMMENDED_BUNDLED; do set -- "$@" --package "$REPO_ROOT/plugins/$p"; done
  if [ "$rec_sound" = "1" ]; then set -- "$@" --package github:cwd514/dsh-sound-notifications; fi
  if [ "$rec_gitview" = "1" ]; then set -- "$@" --package github:yugapor/dsh-gitview; fi
  if [ "$rec_intelligent_ui" = "1" ]; then set -- "$@" --package github:cwd514/dsh-intelligent-ui; fi
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
run_add() { # $1 package spec, $2 tier label
  if [ "$DRY_RUN" = "1" ]; then
    echo "dsh plugin --profile $PROFILE add $1  # $2"
    ok=$((ok + 1))
  elif dsh plugin --profile "$PROFILE" add "$1"; then
    echo "installed: $1 ($2)"
    ok=$((ok + 1))
  else
    echo "FAILED: $1" >&2
    fail=$((fail + 1))
  fi
}

for p in $PKGS; do run_add "$p" essential; done
for p in $ESSENTIAL_BUNDLED; do run_add "$REPO_ROOT/plugins/$p" essential; done
for p in $RECOMMENDED_BUNDLED; do run_add "$REPO_ROOT/plugins/$p" recommended; done
if [ "$rec_sound" = "1" ]; then
  run_add github:cwd514/dsh-sound-notifications "recommended third-party sound notifications"
fi
if [ "$rec_gitview" = "1" ]; then
  run_add github:yugapor/dsh-gitview "recommended third-party git panel"
fi
if [ "$rec_intelligent_ui" = "1" ]; then
  run_add github:cwd514/dsh-intelligent-ui "recommended third-party visual answers"
fi
echo "done: $ok ok, $fail failed (profile: $PROFILE)"
[ "$fail" -eq 0 ]
