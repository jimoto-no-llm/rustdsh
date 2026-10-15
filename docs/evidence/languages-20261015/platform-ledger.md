# Native dashboard platform ledger

These are ordinary complete local dashboard runs on the same 350-file source snapshot; they are not GitHub CI results. No test-name filter or concurrency override was used.

| Platform | Total | Pass | Fail | Skip |
| --- | --- | --- | --- | --- |
| macOS | 347 | 256 | 0 | 91 |
| Windows native | 347 | 335 | 0 | 12 |

Darwin now supports read-only native process identity. Kernel-owned process scopes still support Linux and Windows only; Darwin owned-scope starts fail closed before managed launch. No PID-only fallback or weakened supported-platform assertion is introduced.

The macOS exclusions comprise 82 owned-scope positives, one missing-identity negative that is inapplicable on a supported identity platform, and eight existing OS-specific cases. Windows excludes unsupported-backend negatives, Darwin-only identity, POSIX transport/install/legacy-wrapper fixtures. All exact case names and reasons follow.

## macOS

- start/send/usage use versioned ACP requests and measurements instead of shell input — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- resume attaches the exact session and rejects failed attachment — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- missing advertised resume is unsupported without writing a resume request — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- simultaneous prompts are refused and interrupt is a request until the cancelled result — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- client-side permission and filesystem requests do not gain execution authority — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a changed executable version revokes capabilities on an already connected adapter — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- broken JSON, oversized frames, invalid UTF8, wrong protocol and invalid start fail closed — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- invalid usage cannot become a zero or fabricated measurement — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- CLI errors retain no peer secret and missing methods disable the affected operation — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- timeouts and early exit are failures, never successful starts — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- duplicate session identifiers disable the adapter — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- stop waits for the owned child to exit and escalates when EOF is ignored — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- isolated smoke covers restart/resume and accurately marks unexercised model work — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- public CLI smoke acquires and stops real native ownership — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a failed cleanup after real ownership remains unconfirmed and cannot become a no-child stop — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- registration rejects malformed owner IDs and unbounded session IDs before enrollment — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- general inputs and human replies share exact-session order and immutable IDs, including unsupported steer — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- legacy unbound feedback cannot advance a consumer cursor past a newly submitted instruction — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- concurrent contradictory inputs retain both texts, require human comparison, and reject stale review decisions — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- human-approved interruption cancels only the currently awaited native prompt and confirms its correlated result before the follow-up — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a cancel notification without a correlated prompt result cannot release the follow-up or be replayed after reconnect — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a lost cancel claim response performs zero cancels and does not gain replay permission — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- general-input result loss remains an ordered unknown barrier after explicit exact-session reconnection — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- public instruction CLI and lost HTTP submission responses reuse an immutable ID without launching native sessions — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- late cursors and simultaneous callers cannot bypass earlier or uncertain inputs to the same native target — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- saved, webhook delivered, cursor GET, target read, begin and correlated ACP result stay separate — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- an invalidated input may reconcile its already-issued native result without replaying or changing the new question — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- concurrent readers, old cursor rereads and duplicate begin IDs cannot repeat a native effect — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- stopped consumer retains its answer; explicit same-session resume rotates credentials and applies once — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- effect followed by native result loss stays unknown after explicit reconnect and never replays — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- dashboard restart and missing application ack reconcile an existing native result without another send — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- lost begin response commits a claim but performs zero sends and remains blocked on reread — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- wrong consumer/run, forged success, project MCP/admin/browser and ended-session acks fail closed — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- revision changes, cancellation and expiry retain original replies but forbid current application — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a correlated native refusal is shown as failed input processing, never successful application — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- an acknowledged native command with different input cannot confirm application of the saved answer — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- public CLI once resumes the exact session, applies once, and inspection never launches another prompt — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- guarded attachment verifies hook, scopes cleanup, and rejects hard job before native session starts — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- checkpoints bind the native ID, branch, durable event and timestamp without copying conversation or credentials — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a fresh formal session-list observation enables a candidate without pretending a resume acknowledgement — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- formal checkpoint resume confirms the same native ID and repeated recovery never replays it — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a checkpoint safety refusal keeps its specific error code and blocks replay — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a context safety error is preserved in the uncertain recovery record and never retried — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- missing and expired-session fixtures require a new-session choice, while unsupported or malformed native evidence is distinct — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- explicit context-loss choice creates a new native ID and sends the operator summary once with a checkpoint reference — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- worktree moves, changed branch and changed HEAD block recovery before native profile boot — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- unconfirmed control commands block recovery and completed external effects are never replayed — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- referenced external outcomes must be known before resume, including an applied operation whose response was lost — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- corrupt checkpoint data and missing committed journal events refuse recovery without overwriting evidence — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a lost summary response leaves the new session link uncertain and never dispatches the summary again — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a flushed recovery intent blocks later clients if persistence fails before dispatch — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a surviving checkpoint writer lock remains visible and is never stolen to recover a session — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- separate public CLI clients record, inspect, resume and reject unsafe summary options — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- missing native process identity keeps Tunnel readiness unconfirmed without probing its URL — Requires a platform without the native process identity reader
- all six real control-plane scenarios expose effects, persistence and resource proof without inherited credentials — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- CLI replay retains the exact seed and fault point; ENOSPC before write dispatches nothing — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a declared run persists requested and native configuration separately and guards an actual prompt without storing its body — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- mismatched, absent or malformed native routes block a tracked prompt before dispatch and never select another model — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- only an exact unexpired operator authorization accepts a changed native route and its history retains before, after and source — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- the adapter repeats the assertion at its final send boundary after a native configuration update — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- corrupt route policies and surviving locks are preserved and block prompts instead of guessing an allowed route — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- separate public clients bind, probe and inspect a native configuration without sending a prompt or modifying DSH routing — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a checkpoint cannot drop a declared model assertion while starting a new conversation with a summary — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- framed supervisor drains queued child output before input-close exit — SKIP
- owned children and detached grandchildren stop in order after a bounded graceful deadline, with duplicate requests sharing one result — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- cooperative EOF/TERM exits require no forced kill on Linux and retain truthful Windows graceful capability — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- root exit cannot confirm descendant exit and changing the exposed PID to an independent canary never redirects a kernel-handle stop — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- monitor disconnect is unverifiable, sends no guessed PID kill, and never produces a confirmed stop — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- managed Harness stores ownership before release and every stop stage including final empty-group proof; reloaded history cannot recreate signal authority — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- authenticated Harness API separates stopping from verified empty descendants, duplicate human requests stop once, and MCP credentials cannot stop the owned run — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- lost Harness monitor remains unverifiable in HTTP responses and administrator shutdown refuses to hide the uncertain result — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- failed one-project canary retains observations and cannot alter or roll out to the other project — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- existing run keeps the original adapter/Node/DSH command and native ID through update and verified rollback — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- public CLI re-execs the captured runtime and refuses overrides or changed pins — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- tampered, missing, incompatible and unqualified bytes block dispatch; legacy records are not silently pinned — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- stale selection plans never start native work, while exclusive registry ownership preserves concurrent writers — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- tracked attachment persists command and native ack IDs and stops once despite duplicate stop requests — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- a live or unverifiable recorded process blocks duplicate resume before a second ACP session starts — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- cancel notifications remain unacknowledged while the actual cancelled prompt result is recorded — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- journal failures block new profile boot yet still allow cleanup of an already owned child — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- concurrent close shares one attempt and retries an unconfirmed stop — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- separate public CLI processes start, resolve and resume the same stored native session — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- resume rejects changed executable, home, branch and CLI version before claiming attachment — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- failed starts retain an unknown ID; failed resumes retain only the reported identity — darwin has no owned process-scope backend; requires Linux cgroup v2 delegation/pidfds or a Windows Job
- native PowerShell wrapper forwards help in foreground — SKIP
- Windows tray launcher detaches only after ready; scoped stop preserves another project — SKIP
- native PowerShell foreground wrapper preserves MCP stdin/stdout — SKIP
- native Windows menu emits Open and Exit actions — SKIP
- native Windows creates a real NotifyIcon and disposes it on server close — SKIP
- native Windows runs real PowerShell despite a planted pwsh.exe in the working directory — SKIP
- native Windows timeout reports phases and observes its exact helper's exit — SKIP

## Windows native

- unsupported ownership rejects before ACP execution and retains a confirmed no-child stop — Requires an OS without the kernel ownership backend; supported OS lifecycle cases run separately
- smoke retains a pre-ownership rejection and removes its isolated unused home — Requires an OS without the kernel ownership backend; supported OS lifecycle cases run separately
- missing native process identity keeps Tunnel readiness unconfirmed without probing its URL — Requires a platform without the native process identity reader
- Darwin observes an external fixture with a rechecked owner without signalling it — SKIP
- framed supervisor drains queued child output before input-close exit — SKIP
- installer dry run previews rdsh-docs without creating a DSH home — the source skill installer is POSIX shell
- installer copies rdsh-docs and keeps forced-refresh backups outside skill discovery — the source skill installer is POSIX shell
- legacy subagents command forwards arguments and exit status — SKIP
- legacy subagents command skips a non-executable PATH candidate — SKIP
- legacy task-outcomes command forwards arguments and exit status — SKIP
- legacy task-outcomes command forwards the successful exit status — SKIP
- legacy task-outcomes command skips non-executable rdsh candidates on Unix — SKIP

The [structured record](dashboard-platforms.json) contains the original case names and reason strings. Skips are explicit exclusions, not successful assertions. The later [native Linux receipt](linux-cgroup-native.json) verifies one focused kernel lifecycle case on WSL2 Ubuntu using an already delegated user manager and unchanged source commit `8ee5d7f94f221db6135a9b3a3116707cc0fd4511`. Actual membership of the root, child and detached grandchild, pidfd TERM, one forced cgroup kill across two concurrent stop calls, a surviving independent canary and complete cleanup were observed. No system or user configuration changed. The other three running development distributions were surveyed for prerequisites only; this does not establish the complete Linux dashboard matrix.
