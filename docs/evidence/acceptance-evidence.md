# Acceptance evidence

Issue: [#39](https://github.com/sahenjp/rustdsh/issues/39).
The before/after comparison evaluates the baseline CLI entrypoint from
`786f2acc6f37da98791efde7aa0298d33b33bff6` with current common dependencies.
It rejects `acceptance inspect`; the new CLI inspects conditions and evidence.

[Windows observations](acceptance-evidence-local.json) and
[WSL Linux observations](acceptance-evidence-local-linux.json) run separate public
CLI clients and actual Node checks against isolated native Git fixture projects.
They exercise `done` with not-run conditions, full pass, related source change,
full failure, partial success without overwriting the failure, and a repaired
full pass. Git SHA, worktree/input hashes, local OS/Node versions, command digest,
exit codes, timestamps and copied log integrity remain available for each check.
The existing task state bytes and schema 1 remain unchanged.

The one-pixel PNG is explicitly a payload fixture. Its original observation and
import time are preserved after source changes; its freshness becomes stale,
capture time/target stay unverified, and visual review is not assessed. It is not
a screenshot, UI validation or human acceptance evidence. No UI changed.

Tests also cover all declared conditions, agent-reported passes, missing/changed
command files and logs, corrupt evidence, input deletion, code changes during
successful execution, undefined impact from other files, changed requirements
and HEAD, filtered credential environment, deadlines and read-only inspection
without replay. Missing inputs block dispatch and incomplete outcomes stay
unverified. Public outputs exclude raw argv, log bodies and credential values.

Validation: dashboard tests pass 99/99 on Windows and WSL Linux; Rust release
tests pass 62/62 and regression checks 41/41. Formatting, release Clippy with
warnings denied, release build, `npm ci` and Markdown validation pass.

No native DSH, model/provider or external delivery service is contacted by this
QA. Local command execution is not an OS sandbox, root timeout termination does
not establish descendant cleanup, and before/after hashes are not continuous
attestation. Checksums detect corruption rather than an operator's forgery.
Passing declared commands does not establish semantic coverage, human review or
Production adoption. This PR adds CLI evidence management while preserving the
task schema and six-tool MCP inventory.
