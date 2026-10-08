#!/bin/sh
# Sync .github/labels.yml to the repo using the gh CLI.
# Usage: sh scripts/sync-labels.sh   (needs: gh auth login, repo scope)
set -eu
cd "$(dirname "$0")/.."
REPO="${REPO:-jimoto-no-llm/rustdsh}"
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. See https://cli.github.com/" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found." >&2
  exit 1
fi
python3 - ".github/labels.yml" "$REPO" <<'PYEOF'
import subprocess, sys
try:
    import yaml
except ImportError:
    sys.exit("pyyaml not found: pip install pyyaml")
path, repo = sys.argv[1], sys.argv[2]
with open(path) as f:
    labels = yaml.safe_load(f)
for lb in labels:
    name, color, desc = lb["name"], lb["color"].lstrip("#"), lb.get("description", "")
    subprocess.run(["gh", "label", "create", name, "--repo", repo, "--force",
                    "--color", color, "--description", desc], check=True)
print(f"synced {len(labels)} labels to {repo}")
PYEOF
