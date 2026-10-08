# Task prerequisite diagnostic evidence

Issue: [#38](https://github.com/sahenjp/rustdsh/issues/38).
Captured on 2026-10-06 JST, based on the session ledger PR
[#122](https://github.com/sahenjp/rustdsh/pull/122), commit
`6770adbebde41ba1a9285e9f45817f23f892d57b`.

[Command comparison](task-preflight-command.json) uses the baseline CLI source
from that exact commit and this implementation. The baseline rejects
`preflight`; the new CLI returns a structured report with a blocking disk item
and its minimal fix.

[Local observations](task-preflight-local.json) record an actual CPU-only
preflight, cwd-filesystem capacity, a deliberately occupied loopback port,
missing cwd/profile and the selected existing WSL distribution. The CPU-only
case never probes GPU, WSL or provider authentication. The local fixtures use
temporary state and send no provider request or model prompt.

[Linux observations](task-preflight-local-linux.json) repeat CPU, capacity,
port and cwd/profile cases in the existing WSL environment and check the
explicit original DSH executable version without starting a model prompt.

Fixture tests separately cover absent/incompatible CLI, Node/dependency
failures, synthetic low capacity, required GPU/WSL availability and explicit
model-list authentication responses. An existing but invalid credential is
never reported as verified. Peer secrets and key values are absent from the
copyable reports. The startup integration test proves a blocked report prevents
both ledger creation and ACP profile startup.

Validation: dashboard tests pass 48/48 on Windows and WSL Linux. Rust release
tests pass 62/62, regression checks pass 41/41, and formatting, release Clippy
with warnings denied and the release build pass. No dependency changed.

Real provider authentication, CUDA workload compatibility and physical-phone
access are unverified. A successful prerequisite report grants no execution
permission and does not replace task approval or native provider routing checks.
