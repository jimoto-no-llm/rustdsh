#!/bin/sh
# Install/refresh filesystem skills into $DSH_HOME/skills.
# Usage: [DSH_HOME=~/.dsh] [FORCE=1] [DRY_RUN=1] ./plugins/install-skills.sh
set -eu
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DRY_RUN="${DRY_RUN:-0}"
FORCE="${FORCE:-0}"
REF="${REF:-main}"
PONYTAIL_REPO="${PONYTAIL_REPO:-https://github.com/DietrichGebert/ponytail}"
SKILLS="$DSH_HOME/skills"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RDSH_DOCS_SOURCE="$SCRIPT_DIR/skills/rdsh-docs"
ok=0
skip=0

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need git

put_dir() {
  src="$1"; name="$2"
  dst="$SKILLS/$name"
  if [ "$DRY_RUN" = "1" ]; then
    if { [ -e "$dst" ] || [ -L "$dst" ]; } && [ "$FORCE" != "1" ]; then
      echo "keep: $name (FORCE=1 to refresh)"
      skip=$((skip + 1))
    else
      echo "install: $name"
      ok=$((ok + 1))
    fi
    return
  fi
  if [ ! -d "$src" ] || [ ! -f "$src/SKILL.md" ]; then
    echo "missing skill source: $src/SKILL.md" >&2
    return 1
  fi
  if { [ -e "$dst" ] || [ -L "$dst" ]; } && [ "$FORCE" != "1" ]; then
    echo "keep: $name (FORCE=1 to refresh)"
    skip=$((skip + 1))
    return
  fi

  mkdir -p "$DSH_HOME" "$SKILLS"
  stage=$(mktemp -d "$DSH_HOME/.rdsh-skill-$name.XXXXXX")
  if ! cp -R "$src"/. "$stage"/; then
    rm -rf "$stage"
    echo "failed to stage skill: $name" >&2
    return 1
  fi

  backup=""
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    backup_root="$DSH_HOME/skill-backups/$name"
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    if ! mkdir -p "$backup_root"; then
      rm -rf "$stage"
      echo "failed to create backup directory: $backup_root" >&2
      return 1
    fi
    backup="$backup_root/$stamp-$$"
    suffix=1
    while [ -e "$backup" ] || [ -L "$backup" ]; do
      backup="$backup_root/$stamp-$$-$suffix"
      suffix=$((suffix + 1))
    done
    if ! mv "$dst" "$backup"; then
      rm -rf "$stage"
      echo "failed to preserve existing skill: $dst" >&2
      return 1
    fi
    echo "backup: $name -> $backup"
  fi

  if ! mv "$stage" "$dst"; then
    if [ -n "$backup" ] && { [ -e "$backup" ] || [ -L "$backup" ]; } && [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
      mv "$backup" "$dst" || echo "restore failed; preserved backup at $backup" >&2
    fi
    rm -rf "$stage"
    echo "failed to install skill: $name" >&2
    return 1
  fi
  echo "installed: $name"
  ok=$((ok + 1))
}

[ -f "$RDSH_DOCS_SOURCE/SKILL.md" ] || { echo "missing rdsh-docs skill: $RDSH_DOCS_SOURCE/SKILL.md" >&2; exit 1; }
if [ "$DRY_RUN" = "1" ]; then
  put_dir "$RDSH_DOCS_SOURCE" "rdsh-docs"
  for n in ponytail ponytail-audit ponytail-debt ponytail-gain ponytail-help ponytail-review; do
    put_dir x "$n"
  done
else
  put_dir "$RDSH_DOCS_SOURCE" "rdsh-docs"
  need mktemp
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/rdsh-skills.XXXXXX")
  trap 'rm -rf "$TMP"' EXIT
  trap 'exit 1' HUP INT TERM
  git clone --depth 1 --branch "$REF" "$PONYTAIL_REPO" "$TMP" >&2
  for d in "$TMP"/.openclaw/skills/ponytail*; do
    [ -d "$d" ] || continue
    put_dir "$d" "$(basename "$d")"
  done
fi

if command -v rtk >/dev/null 2>&1; then
  echo "rtk binary: $(rtk --version 2>/dev/null)"
else
  echo "rtk binary: MISSING (install from https://github.com/rtk-ai/rtk)" >&2
fi
if [ -f "$SKILLS/rtk/SKILL.md" ]; then
  echo "rtk skill: present"
else
  echo "rtk skill: MISSING in $SKILLS (kept as-is; place SKILL.md manually)" >&2
fi

echo "done: $ok installed, $skip kept (skills: $SKILLS)"
