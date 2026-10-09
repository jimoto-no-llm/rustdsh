# Integration queue CLI evidence

Verified source: `ba73929e060d23e7b79a86bb6e042c55f4170a1b`.
Baseline: main `cf1762a447e188e636c863110ca6599062121f1c`.

`before-after.txt` records 13 actual CLI observations against disposable Git
repositories, worktrees and literal Node checks. Baseline uses the exact archived
main CLI. Registration leaves the target and execution history unchanged. Each
applied source has a fixed SHA and sequence. Exit 7 blocks the next source;
retry runs both checks; the next integration and an operator commit invalidate
the old success. All source HEAD/status/remote configuration and the untracked
human file remain unchanged. There are no model/provider or publication actions.

`cli-observations.json` retains commit/order/result/evidence IDs; private argv,
homes, stdout/stderr and Git fixture files stay outside the repository.
`validation.json` binds final-source file hashes, the complete Windows 209/209
and Linux 204/209 suites (five Windows-only skips), 14 actual integration cases,
and native checks. The native Cargo/source/tests/examples/assets input tree is
byte-identical to the recorded core validation source: fmt, zero-warning release
Clippy, 103 release tests, seven example tests, two fence tests, 53 CLI regression
checks and 11 security tests passed. Windows used Node 22; Linux used Node 24.

Earlier attempts are preserved privately and excluded from the final pass:
one invocation used the wrong working directory; a parallel Windows fixture
later reported an unconfirmed history write during teardown and left its test
runner open. The exact fixture passed in isolation, then the complete pinned
suite was rerun with concurrency four. This does not claim that the earlier
failure established a production root cause or was fixed by this queue.

No UI or HTTP endpoint changes, screenshots, real-model runs, human approval,
production adoption, main merge or push authority are claimed.
