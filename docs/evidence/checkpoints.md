# Checkpoint evidence

Issue: [#36](https://github.com/sahenjp/rustdsh/issues/36).
The before/after command uses the baseline CLI entrypoint from
`f6dbd05e208be6721b6322e827e6b52ac49248ff` with the current common dependencies.
The baseline rejects `checkpoint list`; the new CLI reads the immutable snapshot.

[Windows observations](checkpoints-local.json) use the version-pinned ACP wire
fixture in actual Node child processes. [Linux observations](checkpoints-local-linux.json)
use the explicit original DSH in the existing WSL distribution with isolated home
and temporary native Git project. A separate client lists the exact native ID,
another performs formal resume, and the same ID is confirmed. Repeating recovery
does not execute again or change the persisted action bytes.

Windows also exercises the public new-session command with a harmless fixture
summary. It records a distinct run/native ID, source checkpoint and observed
prompt response. No provider is contacted. Native model operation, authentication
and semantic summary acceptance remain unverified; Linux native QA sends no
summary or model prompt.

Fixtures cover normal, missing and expired-session scenarios, unsupported list
or resume, malformed evidence, cursor loops, moved cwd, changed branch/HEAD,
missing committed events, unconfirmed control requests and external outcomes.
ACP list absence does not prove expiry; the corresponding fixture changes the
candidate without pretending to diagnose the agent's retention policy.

A completed external write whose response is lost is reconciled before recovery
and occurs once. An unconfirmed write blocks recovery. Another fixture applies
one local effect and exits before acknowledging the new summary; the action
retains its new-session reference and unknown status, and a new client does not
send again. A simulated persistence failure after flushed intent similarly
prevents later dispatch. Surviving checkpoint locks remain visible and block
recovery without removal.

History and checkpoint files exclude summary bodies, native message chunks,
environment values, credentials and peer titles/errors. The source summary is
operator-provided; it is not used to reconstruct facts absent from the checkpoint.
OS containment, descendants, real external delivery/payment services, phone
operation and power-loss durability remain unverified.

Validation: dashboard tests pass 89/89 on Windows and WSL Linux; native-list
and same-ID resume observations pass using the installed original DSH.
Rust release tests pass 62/62, regression checks pass 41/41, and formatting,
release Clippy with warnings denied, release build and Markdown validation pass.
No dependency changed. Checkpoints mark control evidence; they do not establish
a point-in-time native conversation snapshot or semantic task completion.
