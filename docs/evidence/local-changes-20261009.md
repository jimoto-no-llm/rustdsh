# Local changes consolidated on 2026-10-09

The working tree combines Discord RPC recovery, update notifications, CLI performance
changes, context-engine work, documentation and the introduction-video source/assets.
The existing three branch commits remain in history; no published release or tag is replaced.

## Discord recovery cause

At 16:51 JST, the DSH compatibility task saved tracked unfinished work with
`git stash push -m "dsh-latest-wip-20261009"` before fast-forwarding from
`96dbcbb` to `cf1762a`. It did not reapply the saved RPC UI/API/CLI changes.
Untracked Discord implementation files remained, leaving incomplete wiring in the
working tree. The later service start loaded that incomplete plugin.
This sequence is supported by the stash metadata, HEAD reflog and the task record.
The relevant changes and their tests have now been restored while retaining newer edits.

The two original stash diffs are retained as recovery patches on dedicated branches:

- `archive/local-stash-dsh-latest-20261009`: `aa89c381f1b65c5d17496fba5cc660b003ed6142`
- `archive/local-stash-bucket-b-20261009`: `55cfcee008237f7834b031616681ca3957dfb58c`

Each archive branch retains the current implementation and adds the original binary
Git patch plus its source-stash metadata. The patches are historical drafts, including
superseded implementations, rather than code applied to the runtime. In particular, the old bucket-B HTTP worker-pool draft used an unbounded
queue; it is not applied to the active implementation. Original local stashes remain intact.

## Verification of the consolidated working tree

| Check | Observed result |
| --- | --- |
| Cargo formatting | PASS |
| Clippy, all targets, warnings denied | PASS |
| Rust release tests | 107 passed |
| Extended/model benchmark example tests | 7 passed |
| JavaScript tests including the model fence | 78 passed, 1 existing skipped test |
| Sandboxed CLI regression | 55 passed |
| Existing browser integration | 3 flows passed |
| Update-banner browser integration | 13 flows passed; observed live notice 69 ms |
| Isolated original DSH RPC/settings browser | Save/reload/partial save/error recovery/mobile passed |
| Original DSH AgentLoop RPC fixture | Idle -> two active agents -> idle passed, no model requests |
| Video TypeScript | PASS |
| Existing sharp 4K video verification | Decode/privacy/source-density passed, 3840x2160 at 60 fps |
| Sharp representative contact sheet | Inspected, sample project content and credits visible |
| Credential-pattern and authenticated-URL checks | No live credentials found; one intentional guard test marker |

The running GUI has not been restarted during consolidation. Its RPC API was still
404 before restart. A thread follow-up waits for all related work and all DSH agents/jobs
to finish before restarting only the DSH Web service and checking runtime RPC again.
Runtime restoration is therefore a separate pending result.

Ignored local state, dependencies, build output and generated video output remain local.
The video source, captures, fonts with their licenses and attributed audio assets are included.
