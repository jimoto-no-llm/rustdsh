#!/bin/sh
# Label open PRs that conflict with their base and unlabel them once resolved.
# Used by .github/workflows/conflicts.yml; also runnable with an authenticated gh.
#
#   sh scripts/label-conflicts.sh             # every open PR
#   sh scripts/label-conflicts.sh 123 456     # only these PRs
#
# Environment: REPO (owner/repo, default: current gh repo), LABEL (needs-rebase),
# ROUNDS (6) and WAIT (15 seconds) for GitHub's lazily computed mergeability,
# DRY_RUN=1 prints the actions without changing anything.
set -eu

label="${LABEL:-needs-rebase}"
rounds="${ROUNDS:-6}"
wait_s="${WAIT:-15}"
repo="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
marker='<!-- rdsh:needs-rebase -->'

act() {
  if [ "${DRY_RUN:-}" = 1 ]; then echo "dry-run: $*"; else "$@"; fi
}

comment_body() {
  cat <<EOF
$marker
This PR now conflicts with \`$1\`. Update the branch and push again:
\`git fetch origin && git merge origin/$1\` (or rebase).
\`sh scripts/check-conflicts.sh --base origin/$1\` lists the conflicting files. The \`$label\` label is removed automatically once it merges cleanly.

\`$1\` との間でコンフリクトが発生しました。上記の手順でブランチを更新して push してください。
解消されるとラベルは自動で外れます。
EOF
}

if [ $# -gt 0 ]; then
  pending="$*"
else
  # Capture first: a failing gh must not look like "no open PRs".
  numbers=$(gh api --paginate "repos/$repo/pulls?state=open&per_page=100" --jq '.[].number')
  pending=$(printf '%s\n' "$numbers" | tr '\n' ' ')
fi
[ -n "${pending# }" ] || { echo "label-conflicts: no open PRs"; exit 0; }

# The label is managed in .github/labels.yml; create it only if the sync has not run yet.
# --force: the labels workflow may create it concurrently (same definition).
if ! gh api "repos/$repo/labels/$label" >/dev/null 2>&1; then
  act gh label create "$label" --repo "$repo" --color "e99695" --force \
    --description "Conflicts with the base branch; update the PR branch"
fi

round=1
while [ -n "${pending# }" ] && [ "$round" -le "$rounds" ]; do
  next=""
  for n in $pending; do
    # <mergeable>\t<has label>\t<base branch>
    info=$(gh pr view "$n" --repo "$repo" --json mergeable,labels,baseRefName \
      --jq "[.mergeable, ([.labels[].name] | index(\"$label\") != null), .baseRefName] | @tsv")
    state=$(printf '%s' "$info" | cut -f1)
    has=$(printf '%s' "$info" | cut -f2)
    base=$(printf '%s' "$info" | cut -f3)
    case "$state:$has" in
      CONFLICTING:false|CONFLICTING:true)
        # Check notification and label independently: either write can fail or be retried.
        notified=$(gh api --paginate "repos/$repo/issues/$n/comments" \
          --jq '.[] | select((.body // "") | startswith("<!-- rdsh:needs-rebase -->")) | .id')
        if [ -z "$notified" ]; then
          echo "#$n conflicts with $base: commenting"
          act gh pr comment "$n" --repo "$repo" --body "$(comment_body "$base")"
        fi
        if [ "$has" = false ]; then
          echo "#$n conflicts with $base: adding $label"
          act gh pr edit "$n" --repo "$repo" --add-label "$label"
        fi ;;
      MERGEABLE:true)
        echo "#$n merges cleanly: removing $label"
        act gh pr edit "$n" --repo "$repo" --remove-label "$label" ;;
      MERGEABLE:false) echo "#$n ok" ;;
      *) next="$next $n" ;;
    esac
  done
  pending="$next"
  if [ -n "${pending# }" ] && [ "$round" -lt "$rounds" ]; then
    echo "label-conflicts: mergeability not computed yet for:$pending; retrying in ${wait_s}s"
    sleep "$wait_s"
  fi
  round=$((round+1))
done

[ -z "${pending# }" ] || echo "label-conflicts: still unknown (left unchanged):$pending"
