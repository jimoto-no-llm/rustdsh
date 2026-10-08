# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| Latest stable release | Yes |
| Earlier releases | No |
| Release candidates | Preview only |

Only the [latest stable release](https://github.com/jimoto-no-llm/rustdsh/releases/latest) is supported. Prebuilt
installers (install.sh / install.ps1) always pull the latest release
unless pinned.

## Reporting a Vulnerability

Do not open a public issue for security reports.

1. Use GitHub's [private vulnerability report](https://github.com/jimoto-no-llm/rustdsh/security/advisories/new).
2. Include: affected version/commit, OS, repro steps or PoC, and impact
   (credential exposure, arbitrary exec, sandbox escape, ...).
3. Expect an initial response within 72 hours.

What happens next:

- We confirm the report and agree on a disclosure timeline (default 90 days).
- We ship a fix and credit you in the release notes (opt-out OK).
- rdsh doctor / rdsh auth output may be requested - redact tokens first.

## Scope Notes

- Agent execution through rdsh requires the audited DSH tool adapter and
  Linux x86_64 kernel isolation. Unsupported combinations fail closed.
  Only explicitly shared project files are exposed to model tools; their
  contents may reach the configured model provider. Plugins and profiles
  are trusted code. Direct upstream DSH execution is outside this protection.
  Upstream Harness vulnerabilities should also be reported upstream.
- The Node dashboard (dashboard/*) binds to loopback by default. Tailscale
  Serve QR URLs are credentials - never paste them into public issues.
