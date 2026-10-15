#!/bin/sh
# Detect merge conflicts with the base branch before pushing or opening a PR.
#
#   sh scripts/check-conflicts.sh                 # HEAD vs freshly fetched origin/main
#   sh scripts/check-conflicts.sh --no-fetch      # use the local origin/main ref as is
#   sh scripts/check-conflicts.sh --base upstream/main
#   sh scripts/check-conflicts.sh --open-prs      # also list open PRs touching the same files (gh)
#   sh scripts/check-conflicts.sh --require-fetch # fail (exit 2) instead of using a stale ref
#   sh scripts/check-conflicts.sh --head <rev>    # check a commit other than HEAD (pre-push)
#
# Exit status: 0 clean, 1 conflicts found, 2 usage or environment error.
# Only committed work is compared; the working tree is never modified.
set -eu

base=origin/main
fetch=1
require_fetch=0
open_prs=0
head=HEAD
behind_warn="${RDSH_BEHIND_WARN:-30}"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || { usage >&2; exit 2; }; base="$2"; shift 2 ;;
    --base=*) base="${1#--base=}"; shift ;;
    --head) [ $# -ge 2 ] || { usage >&2; exit 2; }; head="$2"; shift 2 ;;
    --no-fetch) fetch=0; shift ;;
    --require-fetch) require_fetch=1; shift ;;
    --open-prs) open_prs=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "check-conflicts: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

git rev-parse --git-dir >/dev/null 2>&1 || { echo "check-conflicts: not a git repository" >&2; exit 2; }

fetched=0
if [ "$fetch" = 1 ]; then
  case "$base" in
    */*)
      remote="${base%%/*}"; branch="${base#*/}"
      if git remote get-url "$remote" >/dev/null 2>&1; then
        if git fetch --quiet "$remote" "$branch" 2>/dev/null; then
          fetched=1
        else
          echo "check-conflicts: warning: could not fetch $base; using the local ref" >&2
        fi
      fi ;;
  esac
fi
if [ "$require_fetch" = 1 ] && [ "$fetched" = 0 ]; then
  echo "check-conflicts: --require-fetch: $base could not be fetched" >&2
  exit 2
fi

git rev-parse --verify --quiet "$base^{commit}" >/dev/null \
  || { echo "check-conflicts: base '$base' not found (try: git fetch origin main)" >&2; exit 2; }
git rev-parse --verify --quiet "$head^{commit}" >/dev/null \
  || { echo "check-conflicts: revision '$head' not found" >&2; exit 2; }

behind=$(git rev-list --count "$head..$base")
ahead=$(git rev-list --count "$base..$head")
echo "check-conflicts: $head is $ahead ahead / $behind behind $base"
if [ "$behind" -ge "$behind_warn" ]; then
  echo "check-conflicts: warning: $behind commits behind; update the branch early to keep conflicts small" >&2
fi

status=0
if ! out=$(git merge-tree --write-tree --name-only --no-messages "$base" "$head" 2>&1); then
  # Exit 1 means conflicts; anything else (e.g. git < 2.38) is an environment error.
  if ! printf '%s\n' "$out" | head -n 1 | grep -Eq '^[0-9a-f]{40,64}$'; then
    echo "check-conflicts: git merge-tree --write-tree failed (requires git >= 2.38):" >&2
    printf '%s\n' "$out" >&2
    exit 2
  fi
  echo "check-conflicts: CONFLICT with $base in:"
  printf '%s\n' "$out" | tail -n +2 | sed '/^$/d' | sort -u | sed 's/^/  /'
  echo "Resolve now: git merge $base   (or: git rebase $base)"
  status=1
else
  echo "check-conflicts: no conflicts with $base"
fi

if [ "$open_prs" = 1 ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "check-conflicts: --open-prs needs the gh CLI" >&2
    exit 2
  fi
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t rdsh-conflicts)
  trap 'rm -rf "$tmp"' EXIT INT TERM
  # Real UTF-8 paths (no quotePath escapes), matching the names GitHub returns.
  git -c core.quotePath=false diff --name-only -z "$base...$head" | tr '\0' '\n' | sort -u > "$tmp/mine"
  if [ ! -s "$tmp/mine" ]; then
    echo "check-conflicts: no committed changes to compare with open PRs"
  else
    # This branch's own PR, identified by number (branch names repeat across forks).
    self=""
    [ "$head" = HEAD ] && self=$(gh pr view --json number --jq .number 2>/dev/null || true)
    # Lines: F\t<number>\t<title>\t<file>, or T\t<number>\t<title> when gh returned
    # only the first 100 files of that PR.
    # shellcheck disable=SC2016 # $p is a jq variable
    gh pr list --state open --limit 200 --json number,title,files,changedFiles --jq '.[] | . as $p
      | if ($p.changedFiles > ($p.files | length)) then ["T", $p.number, $p.title] | @tsv
        else ($p.files[] | ["F", $p.number, $p.title, .path] | @tsv) end' > "$tmp/prs" \
      || { echo "check-conflicts: gh pr list failed" >&2; exit 2; }
    incomplete=""
    awk -F '\t' '$1 == "T" { print $2 "\t" $3 }' "$tmp/prs" > "$tmp/truncated"
    while IFS="$(printf '\t')" read -r n title; do
      if gh api --paginate "repos/{owner}/{repo}/pulls/$n/files" --jq '.[].filename' > "$tmp/files" 2>/dev/null; then
        awk -v n="$n" -v t="$title" '{ printf "F\t%s\t%s\t%s\n", n, t, $0 }' "$tmp/files" >> "$tmp/prs"
      else
        incomplete="$incomplete #$n"
      fi
    done < "$tmp/truncated"
    overlap=$(awk -F '\t' -v self="$self" '
      NR == FNR { mine[$0] = 1; next }
      $1 == "F" && $2 != self && ($4 in mine) { hit[$2] = hit[$2] "\n    " $4; title[$2] = $3 }
      END { for (p in hit) printf "  #%s %s%s\n", p, title[p], hit[p] }' "$tmp/mine" "$tmp/prs")
    if [ -n "$overlap" ]; then
      echo "check-conflicts: open PRs that touch the same files (coordinate or land in order):"
      printf '%s\n' "$overlap"
    elif [ -z "$incomplete" ]; then
      echo "check-conflicts: no open PR touches the same files"
    fi
    if [ -n "$incomplete" ]; then
      echo "check-conflicts: could not list every file of:$incomplete; overlap with them is unknown" >&2
      [ "$status" = 0 ] && status=2
    fi
  fi
fi

exit "$status"
