# Session ledger command and lifecycle evidence

Issue: [#18](https://github.com/sahenjp/rustdsh/issues/18).
Captured on 2026-10-06 JST, based on CLI adapter PR
[#120](https://github.com/sahenjp/rustdsh/pull/120), commit
`5b636a00d5881ed4e06d2401dcf4aa839b4ed126`.

## Before and after

[Command capture](session-ledger-command.json) runs the baseline CLI source
from that exact Git commit and this implementation, in an isolated temporary
project. The baseline rejects `session-ledger` as an unknown command. The new
CLI records and resolves an unconfirmed run, retaining distinct IDs and showing
its native session as `不明`.

## Native restart

[Real DSH lifecycle capture](session-ledger-live-smoke.json) uses the installed
original DSH 0.2.0-rc.2 executable and separate Node client processes:

1. Create a native session, save its identity, and confirm the owned ACP process exits.
2. Resolve the run from the persisted ledger in a new client process.
3. Resume the exact native session ID and cwd in another client, then confirm exit.
4. Record an unknown session with the same label/task; keep a separate run ID and `不明`.

All homes, CLI session storage and ledger files are temporary. The child
environment excludes inherited provider credentials. No model prompt or
provider authentication was exercised; provider remains unknown. Temporary
state is removed only after both owned-process exits are confirmed.

The fixture suite additionally tests failures and changed contexts without
claiming those failure cases were produced by a real provider. This evidence
establishes persistence and native ID routing, without claiming a live chat
surface, native-session ownership locks or task completion.
