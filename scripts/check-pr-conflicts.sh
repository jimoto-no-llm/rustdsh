#!/usr/bin/env bash
# check-pr-conflicts.sh: one table of every open PR's merge state.
#
# `gh pr list` refreshes GitHub's own mergeability verdict, so this stays
# current without fetching or rebasing anything locally. "AHEAD/BEHIND" is
# measured against the PR's base branch when that head ref is already present
# under refs/remotes/origin/ *and* origin is the repository being listed; it is
# "-" otherwise. This script never fetches, never checks a branch out and never
# writes to the repository.
#
#   scripts/check-pr-conflicts.sh                    # every open PR
#   scripts/check-pr-conflicts.sh --conflicting-only # only CONFLICTING
#   scripts/check-pr-conflicts.sh --mergeable-only   # only MERGEABLE
#   scripts/check-pr-conflicts.sh --json             # machine-readable
#
# Exit status: 0 no CONFLICTING PRs in the selection, 3 some, 2 usage/gh error.
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 2; }

usage() {
  cat <<'USAGE'
usage: scripts/check-pr-conflicts.sh [--mergeable-only | --conflicting-only]
                                     [--json] [--limit N] [--repo OWNER/REPO]

  --mergeable-only     list only PRs GitHub reports as MERGEABLE
  --conflicting-only   list only PRs GitHub reports as CONFLICTING
  --json               emit a JSON object instead of the table
  --limit N            how many open PRs to inspect (default 200)
  --repo OWNER/REPO    override the repository (default: the current one)
  -h, --help           show this message

Exit status is 0 when the selected PRs contain no CONFLICTING entry, 3 when
they do (so the command can gate a script), and 2 on a usage or gh failure.
With --repo, AHEAD/BEHIND is only computed when origin is that repository.
USAGE
}

filter="all"
json=0
limit=200
repo=""

while [ $# -gt 0 ]; do
  case "$1" in
    --mergeable-only) filter="mergeable" ;;
    --conflicting-only) filter="conflicting" ;;
    --json) json=1 ;;
    --limit)
      shift
      [ $# -gt 0 ] || die "--limit needs a number"
      case "$1" in ''|*[!0-9]*) die "--limit must be a number, got '$1'" ;; esac
      limit="$1"
      ;;
    --repo)
      shift
      [ $# -gt 0 ] || die "--repo needs OWNER/REPO"
      repo="$1"
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option '$1'" ;;
  esac
  shift
done

command -v gh >/dev/null 2>&1 ||
  die "gh CLI not found. Install it from https://cli.github.com/ before running this check."

if ! gh auth status >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: gh is not authenticated, so open PRs cannot be listed.

Fix it with one of:

  gh auth login
  GH_TOKEN=<token> scripts/check-pr-conflicts.sh

The token needs the `repo` scope to read pull requests.
EOF
  exit 2
fi

repo_args=()
[ -n "$repo" ] && repo_args=(--repo "$repo")

# `gh pr list` resolves the repository from the working directory, so fail with
# a message that says so instead of leaking its "not a git repository" error.
if [ -z "$repo" ] && ! git rev-parse --git-dir >/dev/null 2>&1; then
  die "not inside a Git repository: run this from the rustdsh checkout or pass --repo OWNER/REPO"
fi

if ! prs="$(gh pr list --state open --limit "$limit" \
  --json number,title,headRefName,baseRefName,mergeable ${repo_args[@]+"${repo_args[@]}"} 2>&1)"; then
  printf 'error: gh pr list failed:\n%s\n' "$prs" >&2
  exit 2
fi

# Reduce a remote URL or OWNER/REPO argument to "owner/repo" so the two can be
# compared. Anything without two path components only matches itself.
repo_slug() {
  printf '%s' "$1" | sed -e 's#\.git$##' -e 's#/+$##' \
    -e 's#^[A-Za-z][A-Za-z0-9+.-]*://##' -e 's#^[^/@]*@##' -e 's#:#/#' |
    awk -F/ '{ if (NF >= 2) print tolower($(NF-1) "/" $NF); else print "" }'
}

# Ahead/behind per PR, computed here because only the shell can ask Git about
# local refs. Missing refs yield "-" rather than a fetch, and so does a --repo
# that is not origin: refs/remotes/origin/* belong to another repository then.
ab_enabled=1
ab_note=""
if [ -n "$repo" ]; then
  origin_url="$(git remote get-url origin 2>/dev/null || printf '')"
  if [ -z "$origin_url" ] || [ "$(repo_slug "$origin_url")" != "$(repo_slug "$repo")" ]; then
    ab_enabled=0
    ab_note="origin is not $repo; AHEAD/BEHIND is shown as - for every PR"
  fi
fi
if [ -n "$ab_note" ]; then
  printf 'note: %s\n' "$ab_note" >&2
fi

ab_file="$(mktemp 2>/dev/null || mktemp -t rdsh-ab)" || die "cannot create a temp file"
trap 'rm -f "$ab_file"' EXIT INT TERM

printf '%s' "$prs" | python3 -c '
import json, sys
prs = json.load(sys.stdin)
for p in prs:
    print("%s\t%s\t%s" % (p.get("number"), p.get("headRefName", ""), p.get("baseRefName") or "main"))
' >"$ab_file" || die "could not parse the gh output as JSON"

ab_json=""
ab_json+="{"
first=1
while IFS="$(printf '\t')" read -r number head base; do
  [ -n "$number" ] || continue
  # Native Python on Windows writes CRLF; the record terminator is not a ref.
  base="${base%$'\r'}"
  value="-"
  if [ "$ab_enabled" -eq 1 ] &&
    git rev-parse --verify --quiet "refs/remotes/origin/$head" >/dev/null 2>&1 &&
    git rev-parse --verify --quiet "refs/remotes/origin/$base" >/dev/null 2>&1; then
    if counts="$(git rev-list --left-right --count \
      "refs/remotes/origin/$base...refs/remotes/origin/$head" 2>/dev/null)"; then
      value="+${counts##*[[:space:]]}/-${counts%%[[:space:]]*}"
    fi
  fi
  [ "$first" -eq 1 ] || ab_json+=","
  first=0
  ab_json+="\"$number\":\"$value\""
done <"$ab_file"
ab_json+="}"

printf '%s' "$prs" | python3 -c '
import json, sys

filter_mode, as_json, ab_raw = sys.argv[1], sys.argv[2] == "1", sys.argv[3]
raw = sys.stdin.read()
try:
    prs = json.loads(raw)
except ValueError:
    sys.stderr.write("error: could not parse the gh output as JSON\n" + raw[:400] + "\n")
    sys.exit(2)

try:
    ahead_behind = json.loads(ab_raw)
except ValueError:
    ahead_behind = {}

def state(pr):
    return (pr.get("mergeable") or "UNKNOWN").upper()

counts = {"CONFLICTING": 0, "MERGEABLE": 0, "UNKNOWN": 0}
for pr in prs:
    counts[state(pr)] = counts.get(state(pr), 0) + 1

if filter_mode == "conflicting":
    selected = [p for p in prs if state(p) == "CONFLICTING"]
elif filter_mode == "mergeable":
    selected = [p for p in prs if state(p) == "MERGEABLE"]
else:
    selected = list(prs)

rank = {"CONFLICTING": 2, "UNKNOWN": 1, "MERGEABLE": 0}
selected.sort(key=lambda p: (-rank.get(state(p), 1), -int(p.get("number", 0))))

conflicting = counts.get("CONFLICTING", 0)
# The gate follows the selection: --mergeable-only must exit 0 when none of
# the listed PRs conflicts, even if an unlisted one does.
selected_conflicting = sum(1 for p in selected if state(p) == "CONFLICTING")

if as_json:
    print(json.dumps({
        "summary": {
            "open": len(prs),
            "conflicting": conflicting,
            "mergeable": counts.get("MERGEABLE", 0),
            "unknown": counts.get("UNKNOWN", 0),
            "selected": len(selected),
            "selected_conflicting": selected_conflicting,
        },
        "prs": [
            {
                "number": p.get("number"),
                "mergeable": state(p),
                "ahead_behind": ahead_behind.get(str(p.get("number")), "-"),
                "title": p.get("title", ""),
                "head": p.get("headRefName", ""),
                "base": p.get("baseRefName", ""),
            }
            for p in selected
        ],
    }, ensure_ascii=False, indent=2))
    sys.exit(3 if selected_conflicting else 0)

if not selected:
    print("no PRs match the selected filter")
else:
    rows = [
        (str(p.get("number", "?")), state(p),
         ahead_behind.get(str(p.get("number")), "-"),
         (p.get("title") or "").replace("\n", " "))
        for p in selected
    ]
    w_num = max(len("PR") + 1, max(len(r[0]) + 1 for r in rows))
    w_state = max(len("MERGEABLE") + 1, max(len(r[1]) + 1 for r in rows))
    w_ab = max(len("AHEAD/BEHIND") + 1, max(len(r[2]) + 1 for r in rows))
    header = "%-*s%-*s%-*s%s" % (w_num, "PR", w_state, "MERGEABLE", w_ab, "AHEAD/BEHIND", "TITLE")
    print(header)
    print("-" * len(header))
    for num, st, ab, title in rows:
        print("%-*s%-*s%-*s%s" % (w_num, num, w_state, st, w_ab, ab, title))

summary = "open PRs: %d  CONFLICTING: %d  MERGEABLE: %d" % (
    len(prs), conflicting, counts.get("MERGEABLE", 0))
if counts.get("UNKNOWN"):
    summary += "  UNKNOWN: %d" % counts["UNKNOWN"]
if filter_mode != "all":
    summary += "  selected: %d (CONFLICTING: %d)" % (len(selected), selected_conflicting)
print()
print(summary)
sys.exit(3 if selected_conflicting else 0)
' "$filter" "$json" "$ab_json"
