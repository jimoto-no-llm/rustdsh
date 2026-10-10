# v0.2.1 release candidate verification

Local verification after rebasing onto `0f6b284` and setting both Rust version
files to `0.2.1`. [The report](verification.json) records the checks and limits.
GitHub CI and verification of published archives are separate release steps.

- Rust fmt/clippy, 109 release tests, 2 extended-runner tests, 5 model-runner tests,
  and 55 CLI regression checks passed.
- Node plugin/client compatibility tests: 83 passed, 1 Windows-only skip.
- Dashboard tests: 223 passed, 6 native Windows skips. Linux uses a delegated
  systemd scope so the process containment tests exercise their actual boundary.
- Security tests: 15 passed. Release metadata/asset-policy tests: 21 passed.
- The [real browser flows](browser.json) passed at desktop and mobile widths;
  the three API providers save through the real bounded backend, changing providers
  clears the old key draft, and Japanese / English labels agree. Only the
  deliberately injected HTTP500/503 errors were accepted.
  [Update banner verification](update-banner.json) passed all 13 flows.
- Locked Cargo check, release-note validation, Markdown lint and issue-form YAML
  parsing passed.
- Installer follow-up text directs migrating users to model setup and the DSH guide.
  Bash syntax and the 55 regression checks passed;
  the Windows script retains its CRLF line endings.

[Earlier optional project MCP verification](onboarding.json) started the optional project CLI
without DSH and connected its stdio bridge using the real MCP SDK. All six tools
were advertised. Task/event/question reporting and a browser-authenticated answer
were read back with the feedback cursor. The same stdio client continued after a
Dashboard restart rotated its credential and retained reports.

Actual Codex CLI `0.161.0` registered, read and removed the server in isolated
settings. It did not change the user's Codex configuration or call a model.
The local `claude` executable is a different wrapper, so official Claude Code
registration was documented from its official instructions rather than claimed
as a local execution result. Native Windows/macOS and GUI client registration are
not covered by this local check.

The [dated UX/performance evidence](../ux-performance-20261010/README.md) retains
the original measurements, raw samples, hashes, real before/after PNGs and GIF.
Version-bumped builds are not presented as the binaries used for that measurement.

[DSH migration verification](migration-verification.json) uses an isolated synthetic
Codex login and preserves the original client and project files. It verifies explicit
import and private storage, reads the existing `AGENTS.md` / `CLAUDE.md` / local and
global instructions using the installed DSH 0.2.0-rc.2 loader, and verifies sibling
deduplication. A fresh Web profile then initializes and renders through rdsh's protected
launcher. It then adds an Anthropic provider with a synthetic key, selects the
original project as the workspace, creates an empty session and chooses a Claude
model from its actual catalog. No model prompt is sent; a live reply remains a
user/account-level check.

[Oversized settings measurements](settings-benchmark.json) compare five alternating
samples per variant. A 32 MiB known-field fixture retains the same 200-character prefix
while median process peak RSS changes from 472.9 to 216.7 MiB and startup + GET +
disposal from 879.08 to 490.90 ms. This fixture includes JSON parsing and plugin
lifecycle; it does not measure ordinary page latency or full DSH memory.
[Reproduction command](../../BENCHMARKS.md#oversized-settings-release-follow-up).

Real setup captures: [desktop](setup-desktop.png), [mobile](setup-mobile.png),
[API section desktop](setup-api-desktop.png) and [API section mobile](setup-api-mobile.png).
The previous single-provider UI remains in the [dated evidence](../ux-performance-20261010/after/setup-desktop.png).

[MuseSpark handoff and reproduction](muse-followup.json) records two artifact-fixture
failures. At umask 0077, file creation requested as 0444 becomes 0400. The fixture
now restores its original mode explicitly; all five releases tests pass at 0077,
including rollback and linked-directory rejection. The complete Dashboard suite
also passes with 223 successes and 6 Windows skips at 0077. Artifact verification
stays strict.
