# Pinned update evidence (#47)

The CLI output baseline is commit
`ea2ed9f1b023760e28b80ffdaa410c2935f8b4a1` (#157). These observations were
captured on 2026-10-06 UTC using owned temporary projects and native homes.
Only the temporary fixture root is normalized to `<qa>` in the JSON; release
IDs, native session IDs, observations and timings are retained as measured.

## Actual before/after output

[output-diff.json](output-diff.json) records this command against the baseline
archive and the current implementation:

```sh
node dashboard/cli.mjs release inspect --project <qa>/alpha
```

Before: exit 1, `Unknown command; use --help`. After: exit 0, project selection
revision 3, two release tuples and their change/recovery notes, canary/rollback
qualification history and three immutable run pins. No dashboard HTML/CSS or
browser flow changes are included in this feature.

## Actual original DSH lifecycle

[native-observations.json](native-observations.json) records original
`@deepseek-ai/dsh` **0.2.0-rc.2**, Node **v24.21.0**, Linux x64, the captured
`acp-stdio-v1` adapter and `rdsh-release-probe` contract 1. The public release
CLI re-executed the captured Node/CLI and imported its captured adapter.

The first and candidate artifacts both contain this implementation's runtime.
The candidate changes one comment in the owned probe source and its change
notes; its artifact ID differs while the upstream package versions are equal.
This proves selection and pinning between compatible code builds, not migration
to an untested upstream DSH version.

The recorded sequence is:

1. Qualify the first artifact in alpha, then explicitly promote it to beta.
2. Start an alpha run and retain its launch command and native session ID.
3. Qualify the candidate only in alpha; beta's complete selection stays equal.
4. Start a new alpha run using the candidate, then resume the existing run using
   its first artifact and the same native session ID and launch command.
5. Roll back alpha after requalifying the first artifact. Resume the candidate
   run with its unchanged artifact/native ID; a subsequent new run uses the
   restored project default.

All three qualifications (first canary, candidate canary, rollback) record
acknowledged startup, observed native Cordis `llm` injection in both processes,
same-native-ID continuation and confirmed exits of both owned processes.
The separate run observations report owned root-process exits; their scope
explicitly leaves descendants unverified. Beta has a project selection in this
fixture, not a native run.

No provider credentials were supplied and no model request was made. Provider
authentication, model output/billing and Production adoption remain unverified.
Existing user installs, profiles and external plugins were not changed; those
external configurations are not part of this qualification claim. The owned
fixture homes, code slots and native processes were cleaned up after capture.

## Capture measurements

[capture-measurements.json](capture-measurements.json) contains two local
measurements, including runtime/dependency copy and checksum verification:

| Artifact  | Files  | Bytes       | Staging time |
| --------- | ------ | ----------- | ------------ |
| First     | 30,432 | 611,801,005 | 24.468 s     |
| Candidate | 30,432 | 611,801,077 | 23.221 s     |

These are two samples from this machine, not a throughput or latency guarantee.
The manifest covers the captured Node, original DSH and packaged dependencies,
dashboard modules/dependencies and managed plugins. Runtime artifacts themselves
are not committed as evidence.

## Automated checks

The final dashboard suite passed **182/182** on Windows (Node 22.23.3) and
Linux/WSL (Node 24.21.0), without failures, cancellations or skips. The release
fixtures in [releases.test.mjs](../../../dashboard/test/releases.test.mjs) cover:

- Two-project failed plugin/start-resume qualifications, unchanged other-project
  selection and denied promotion of a failed candidate.
- Distinct old/new run pins, exact native IDs/commands through update and
  rollback, and missing/tampered/unsupported artifacts without silent fallback.
- Public CLI runtime re-execution, stale selection/override refusal and refusal
  of `NODE_OPTIONS`/`NODE_PATH` injection before managed dispatch.
- Locked concurrent registry writes, corrupt registry preservation, legacy
  unpinned records and incompatible host Node versions.
- Refused symlinked files and, on Linux, linked parent directories even when
  their leaf bytes match the manifest.

Repository gates also passed: Rust release tests **62/62**, release regress
**41/41**, `cargo fmt --check` and release clippy with warnings denied.

See [STAGED-UPDATES.md](../../STAGED-UPDATES.md) for the supported tuple, trusted
source contract, commands, explicit rollout and recovery limits.
