# rustdsh PR review checklist

## 1. Claims vs diff

- Read the PR body, then `gh pr diff <n>`. Flag exaggeration, TODOs,
  unimplemented paths, and test-count mismatches.
- Docs-only changes still need accuracy (no dead links, no stale versions).

## 2. Security (block on any regression)

- Permission checks use effective rights (`faccessat(X_OK, AT_EACCESS)`),
  not mode bits. Paths are validated (no traversal, no CWD hijack on
  Windows). Tokens/credentials never reach logs. Sandbox boundaries
  (bubblewrap, namespaces, fd leaks, env allowlist) hold under probes.

## 3. Tests must actually test

- Reject: always-true asserts, `skip`/`todo`/`only`, tests that do not
  call the implementation, fixtures missing a platform triple,
  mutation-weak assertions (verify by reverting the fix locally).

## 4. No behavior breakage

- Destructive changes, platform differences (Windows/macOS runners),
  changed API semantics, changed defaults. Dashboard JS: check the
  callers of every changed function signature.

## 5. Stale base and review state

- BEHIND/DIRTY/UNKNOWN: use `git merge-tree` to test conflicts; a green
  head CI does not survive a conflicted rebase.
- CHANGES_REQUESTED: read the threads; verify the current head addresses
  them (reviewers often confirm in follow-up COMMENTs without dismissing).
- DRAFT: judge whether it is ready; do not merge drafts.

## 6. Repo-specific pitfalls

- GraphQL (`gh pr list --json`, `gh pr checks`) flaps with 502/504:
  fall back to REST (`gh api repos/.../pulls`, `.../commits/<sha>/check-runs`).
- `gh pr checks` output is tab-separated: `name\tstate\t...`. `links`
  (lychee) fails on redirects — pre-existing, not a code failure.
- Fork PRs: workflows need maintainer approval
  (`POST .../actions/runs/<id>/approve`); head branches cannot be updated.
- Pushing `.github/workflows/*` needs the `workflow` scope: use the SSH
  remote `git@github.com:jimoto-no-llm/rustdsh.git`.
- Merging needs `--admin` when reviews are missing/dismissed.
- Required checks (scripts/release_ci.py): Analyze (rust/javascript),
  Rust lint, test (ubuntu/macos/windows matrix), browser-e2e,
  security-boundaries, release-policy, plugin-security, msrv,
  update-banner-windows, Isolated install.
- `test (windows-latest)` (no flags) is the slow dashboard suite, not
  a required check; `test (windows-latest, false)` is required.
- `cargo`/`node` builds: `TMPDIR=/var/tmp`, shared target dir is the
  session checkout `target/`. `sudo -n` fails; no musl-gcc locally
  (musl cases run in CI).

## Verdict format (one block per PR, no preamble)

```
#<n> verdict=<MERGE|NEEDS-WORK|HOLD> / confidence=<high|mid|low>
- claims-vs-diff: <1 line>
- risk: <max 2 lines>
- before-merge: <e.g. rebase+CI, or "none">
- evidence: <file:line or command>
```
