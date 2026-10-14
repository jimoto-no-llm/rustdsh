# Dashboard macOS validation ledger

Date: 2026-10-14; platform: darwin; Node: v24.21.0.

## Command results

| Run | Command | Exit | Tests | Pass | Fail | Skip |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | `cd dashboard && npm test` | 1 | 322 | 229 | 85 | 8 |
| After fix, attempt 1 | `cd dashboard && npm test` | 1 | 330 | 235 | 1 | 94 |
| Functional retry case, original fixture | `node --test --test-name-pattern="a failed check cannot borrow" dashboard/test/integration.test.mjs` | 0 | 1 | 1 | 0 | 0 |
| Prior fresh run | `cd dashboard && npm test` | 0 | 330 | 236 | 0 | 94 |
| PR review final | `cd dashboard && npm test` | 0 | 336 | 242 | 0 | 94 |

Baseline: `/tmp/rdsh-dashboard-baseline-macos.log`. First post-fix attempt: `/tmp/rdsh-dashboard-macos-attempt1.log`. Final: `/tmp/rdsh-dashboard-final-macos.log`. RED/GREEN: `/tmp/rdsh-smoke-red.log`, `/tmp/rdsh-smoke-green.log`. Functional retry: `/tmp/rdsh-integration-recheck.log`.

The first post-fix attempt observed validation.status=blocked instead of failed in the unchanged integration retry fixture. The implementation maps a null exit code to test_transport_or_deadline_unconfirmed, so timeout versus transport failure was not distinguished by that retained output. The focused case and the fresh full run passed without changing its 1000 ms child deadline, assertions, product budgets or CI. CPU contention was reported by root; it is a possible cause, not a confirmed timeout measurement.

## Preconditions and exclusions

| Suite | Kernel ownership positive cases | Native identity positive cases |
| --- | --- | --- |
| adapters.test.mjs | 15 | 0 |
| answer-applications.test.mjs | 22 | 0 |
| budget-admission.test.mjs | 1 | 0 |
| checkpoints.test.mjs | 15 | 0 |
| connection-diagnostics.test.mjs | 0 | 4 |
| fault-simulator.test.mjs | 2 | 0 |
| model-routing.test.mjs | 7 | 0 |
| process-scope.test.mjs | 7 | 0 |
| releases.test.mjs | 5 | 0 |
| run-history.test.mjs | 4 | 0 |
| server-close.test.mjs | 1 | 0 |
| session-ledger.test.mjs | 3 | 0 |

The 94 skipped cases comprise 82 explicitly annotated kernel ownership positives, 4 read-only native identity positives and 8 pre-existing platform-specific cases. All original supported-OS assertions remain; a missing Linux delegated cgroup or Windows native package still fails on its supported OS. The extra real-ownership cleanup negative runs on Linux/Windows and is included in the 82. No platform or CI detection was loosened to hide a runtime error.

## Executed regression evidence

- Actual macOS ACP startup rejects with ownership_unavailable before the ACP launch marker is written. The adapter child remains undefined and stop_scope remains null; stop reports confirmed not_running.
- The isolated smoke retains ownership_unavailable and removes its unused private home. The version probe runs as before; the managed ACP entrypoint does not run.
- A portable bounded cleanup-policy fixture supplies an unconfirmed stop result, observes smoke_cleanup_unconfirmed and verifies retention of the private home before test-owned cleanup. It creates no OS child/scope or provider request.
- Missing native process identity produces an unconfirmed Tunnel result with process_identity_unavailable and zero health HTTP requests. No guessed identity or PID fallback is installed.
- Version probes, missing executable/cwd checks, catalog/CLI argument checks, portable state tests and browser/HTTP credential checks remain active. Mixed public CLI and browser/Tunnel cases keep their portable assertions and only condition their backend-positive subtest.

## Positive cases retained for supported platforms

### Kernel ownership

#### adapters.test.mjs

- start/send/usage use versioned ACP requests and measurements instead of shell input
- resume attaches the exact session and rejects failed attachment
- missing advertised resume is unsupported without writing a resume request
- simultaneous prompts are refused and interrupt is a request until the cancelled result
- client-side permission and filesystem requests do not gain execution authority
- a changed executable version revokes capabilities on an already connected adapter
- broken JSON, oversized frames, invalid UTF8, wrong protocol and invalid start fail closed
- invalid usage cannot become a zero or fabricated measurement
- CLI errors retain no peer secret and missing methods disable the affected operation
- timeouts and early exit are failures, never successful starts
- duplicate session identifiers disable the adapter
- stop waits for the owned child to exit and escalates when EOF is ignored
- isolated smoke covers restart/resume and accurately marks unexercised model work
- public CLI smoke acquires and stops real native ownership
- a failed cleanup after real ownership remains unconfirmed and cannot become a no-child stop

#### answer-applications.test.mjs

- registration rejects malformed owner IDs and unbounded session IDs before enrollment
- general inputs and human replies share exact-session order and immutable IDs, including unsupported steer
- legacy unbound feedback cannot advance a consumer cursor past a newly submitted instruction
- concurrent contradictory inputs retain both texts, require human comparison, and reject stale review decisions
- human-approved interruption cancels only the currently awaited native prompt and confirms its correlated result before the follow-up
- a cancel notification without a correlated prompt result cannot release the follow-up or be replayed after reconnect
- a lost cancel claim response performs zero cancels and does not gain replay permission
- general-input result loss remains an ordered unknown barrier after explicit exact-session reconnection
- public instruction CLI and lost HTTP submission responses reuse an immutable ID without launching native sessions
- late cursors and simultaneous callers cannot bypass earlier or uncertain inputs to the same native target
- saved, webhook delivered, cursor GET, target read, begin and correlated ACP result stay separate
- an invalidated input may reconcile its already-issued native result without replaying or changing the new question
- concurrent readers, old cursor rereads and duplicate begin IDs cannot repeat a native effect
- stopped consumer retains its answer; explicit same-session resume rotates credentials and applies once
- effect followed by native result loss stays unknown after explicit reconnect and never replays
- dashboard restart and missing application ack reconcile an existing native result without another send
- lost begin response commits a claim but performs zero sends and remains blocked on reread
- wrong consumer/run, forged success, project MCP/admin/browser and ended-session acks fail closed
- revision changes, cancellation and expiry retain original replies but forbid current application
- a correlated native refusal is shown as failed input processing, never successful application
- an acknowledged native command with different input cannot confirm application of the saved answer
- public CLI once resumes the exact session, applies once, and inspection never launches another prompt

#### budget-admission.test.mjs

- guarded attachment verifies hook, scopes cleanup, and rejects hard job before native session starts

#### checkpoints.test.mjs

- checkpoints bind the native ID, branch, durable event and timestamp without copying conversation or credentials
- a fresh formal session-list observation enables a candidate without pretending a resume acknowledgement
- formal checkpoint resume confirms the same native ID and repeated recovery never replays it
- a checkpoint safety refusal keeps its specific error code and blocks replay
- a context safety error is preserved in the uncertain recovery record and never retried
- missing and expired-session fixtures require a new-session choice, while unsupported or malformed native evidence is distinct
- explicit context-loss choice creates a new native ID and sends the operator summary once with a checkpoint reference
- worktree moves, changed branch and changed HEAD block recovery before native profile boot
- unconfirmed control commands block recovery and completed external effects are never replayed
- referenced external outcomes must be known before resume, including an applied operation whose response was lost
- corrupt checkpoint data and missing committed journal events refuse recovery without overwriting evidence
- a lost summary response leaves the new session link uncertain and never dispatches the summary again
- a flushed recovery intent blocks later clients if persistence fails before dispatch
- a surviving checkpoint writer lock remains visible and is never stolen to recover a session
- separate public CLI clients record, inspect, resume and reject unsafe summary options

#### fault-simulator.test.mjs

- all six real control-plane scenarios expose effects, persistence and resource proof without inherited credentials
- CLI replay retains the exact seed and fault point; ENOSPC before write dispatches nothing

#### model-routing.test.mjs

- a declared run persists requested and native configuration separately and guards an actual prompt without storing its body
- mismatched, absent or malformed native routes block a tracked prompt before dispatch and never select another model
- only an exact unexpired operator authorization accepts a changed native route and its history retains before, after and source
- the adapter repeats the assertion at its final send boundary after a native configuration update
- corrupt route policies and surviving locks are preserved and block prompts instead of guessing an allowed route
- separate public clients bind, probe and inspect a native configuration without sending a prompt or modifying DSH routing
- a checkpoint cannot drop a declared model assertion while starting a new conversation with a summary

#### process-scope.test.mjs

- owned children and detached grandchildren stop in order after a bounded graceful deadline, with duplicate requests sharing one result
- cooperative EOF/TERM exits require no forced kill on Linux and retain truthful Windows graceful capability
- root exit cannot confirm descendant exit and changing the exposed PID to an independent canary never redirects a kernel-handle stop
- monitor disconnect is unverifiable, sends no guessed PID kill, and never produces a confirmed stop
- managed Harness stores ownership before release and every stop stage including final empty-group proof; reloaded history cannot recreate signal authority
- authenticated Harness API separates stopping from verified empty descendants, duplicate human requests stop once, and MCP credentials cannot stop the owned run
- lost Harness monitor remains unverifiable in HTTP responses and administrator shutdown refuses to hide the uncertain result

#### releases.test.mjs

- failed one-project canary retains observations and cannot alter or roll out to the other project
- existing run keeps the original adapter/Node/DSH command and native ID through update and verified rollback
- public CLI re-execs the captured runtime and refuses overrides or changed pins
- tampered, missing, incompatible and unqualified bytes block dispatch; legacy records are not silently pinned
- stale selection plans never start native work, while exclusive registry ownership preserves concurrent writers

#### run-history.test.mjs

- tracked attachment persists command and native ack IDs and stops once despite duplicate stop requests
- a live or unverifiable recorded process blocks duplicate resume before a second ACP session starts
- cancel notifications remain unacknowledged while the actual cancelled prompt result is recorded
- journal failures block new profile boot yet still allow cleanup of an already owned child

#### server-close.test.mjs

- concurrent close shares one attempt and retries an unconfirmed stop

#### session-ledger.test.mjs

- separate public CLI processes start, resolve and resume the same stored native session
- resume rejects changed executable, home, branch and CLI version before claiming attachment
- failed starts retain an unknown ID; failed resumes retain only the reported identity

### Native process identity

#### connection-diagnostics.test.mjs

- Tunnel readiness is read-only, scoped to its live generation and distinct from Dot response
- Health diagnostics reject foreign projects, arbitrary URLs, redirects, oversized files and unknown processes
- a recorded native Tunnel identity becomes stale after restart
- public Tunnel launcher records its actual child and retires only its own health file

## Final Windows validation

The same 142 dashboard source files were verified by SHA-256 before the usual unfiltered `npm test` on Windows 11 x64 / Node 24.21.0. Final result: **336 tests, 330 pass, 0 fail, 6 platform skips**, exit 0; [output](dashboard-windows-final.txt). This executes the native ownership and process-identity positive cases excluded on macOS. The original Windows run had one existing 10-second retry-fixture failure; [the controlled investigation](windows-retry.md) distinguishes that original observation from the reproduced fingerprint-contention mechanism. The positive fixture now allows 30 seconds overall while retaining the 700 ms first-child timeout, exact two attempts and all deadline-negative assertions. The focused retry suite passes 14/14 on both macOS and Windows. Product limits are unchanged.

[Machine-readable excluded-case inventory](platform-skips.json) lists every one of the 94 macOS and 6 Windows exclusions with its recorded reason. These are distinct OS denominators, not one combined test total.

PR review follow-up logs: [macOS](dashboard-macos-final.txt) and [Windows](dashboard-windows-final.txt). The six added tests execute on both platforms. The final Escape-key handler is separately covered by the three-language real-browser suite; it was added after the Windows full-suite source transfer. All Node CLI and test files match that Windows run.
