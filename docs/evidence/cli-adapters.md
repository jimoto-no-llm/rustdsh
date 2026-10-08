# CLI adapter evidence

## Before and after

The same adapters command was run with the CLI source from main 190dd7c and the
updated source. Before, it exited 1 with "Unknown command; use --help".
After, it exited 0 and returned a JSON capability registry for DSH, Codex,
Claude Code and Kimi, with explicit verification requirements and unsupported
operations. The captured [command result](cli-adapters-command.json) records
the actual outputs.

This adds CLI and Node API operations. No dashboard UI or Harness proxy was
changed, and the existing project/dashboard commands still use the same routes.

## Real DSH lifecycle

The [DSH smoke result](cli-adapters-live-smoke.json) was captured using installed
DSH 0.2.0-rc.2 in WSL/Linux. It used two real ACP processes and a temporary home,
without production credentials. Session creation was acknowledged, both child
exits were confirmed and the second child acknowledged resuming the same
persisted session.

Cancellation was a written ACP notification. No active model prompt was used,
so cancellation of inference, live usage and provider authentication remain
unverified. Model send/cancel/usage behavior is covered by the versioned wire
fixture and child-process tests, and is not presented as a real provider test.

The smoke deletes its temporary home after confirming both exits. The reported
capability snapshot was negotiated before the final stop; runtime_state is
stopped.
