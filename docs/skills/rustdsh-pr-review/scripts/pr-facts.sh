#!/bin/bash
# Deterministic PR facts for rustdsh reviews. Usage: pr-facts.sh <pr-number>
# Prints: title/state/merge/review, check summary, non-pass checks, diff stat.
set -u
N="${1:?usage: pr-facts.sh <pr-number}"
R=jimoto-no-llm/rustdsh
gh pr view "$N" --repo "$R" --json number,title,state,isDraft,mergeStateStatus,mergeable,reviewDecision,headRefName,headRefOid,updatedAt,additions,deletions,changedFiles,body --jq '{n: .number, t: .title, s: .state, draft: .isDraft, ms: .mergeStateStatus, mg: .mergeable, rev: (.reviewDecision // "NONE"), br: .headRefName, head: .headRefOid[0:9], upd: .updatedAt[0:16], ch: "\(.additions)+/\(.deletions)-/\(.changedFiles)f", closes: ([.body | scan("(?i)(?:closes|fixes|resolves) #(\\d+)") | .[0]] | unique | join(","))}'
echo "--- checks ---"
gh pr checks "$N" --repo "$R" 2>&1 | python3 -c "import sys; lines=[l.rstrip(chr(10)).split(chr(9)) for l in sys.stdin if chr(9) in l]; from collections import Counter; print(dict(Counter(s for _,s,*_ in lines)))"
echo "--- non-pass ---"
gh pr checks "$N" --repo "$R" 2>&1 | grep -vE "\spass\s" | head -8
