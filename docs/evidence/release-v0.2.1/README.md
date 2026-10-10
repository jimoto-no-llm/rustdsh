# v0.2.1 release candidate verification

Local verification after rebasing onto `0f6b284` and setting both Rust version
files to `0.2.1`. [The report](verification.json) records the checks and limits.
GitHub CI and verification of published archives are separate release steps.

- Rust fmt/clippy, 109 release tests, 2 extended-runner tests, 5 model-runner tests,
  and 55 CLI regression checks passed.
- Node plugin/client compatibility tests: 82 passed, 1 Windows-only skip.
- Dashboard tests: 223 passed, 6 native Windows skips. Linux uses a delegated
  systemd scope so the process containment tests exercise their actual boundary.
- Security tests: 15 passed. Release metadata/asset-policy tests: 21 passed.
- The [real browser flows](browser.json) passed at desktop and mobile widths;
  only the deliberately injected HTTP500/503 errors were accepted.
  [Update banner verification](update-banner.json) passed all 13 flows.
- Locked Cargo check, release-note validation, Markdown lint and issue-form YAML
  parsing passed.

[Onboarding verification](onboarding.json) started the documented project CLI
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
