# CLI adapter contract

The dashboard's Node module provides a version-checked CLI client, without
replacing DSH's agent loop, tools, persistence or profile boot.
Related: [issue #17](https://github.com/sahenjp/rustdsh/issues/17).

## Supported versions and operations

| CLI         | Verified version | Transport         | Operations                                  |
| ----------- | ---------------- | ----------------- | ------------------------------------------- |
| DSH         | 0.2.0-rc.2       | ACP v1 over stdio | start, resume, send, interrupt, stop, usage |
| Codex       | None             | Not implemented   | All unsupported                             |
| Claude Code | None             | Not implemented   | All unsupported                             |
| Kimi        | None             | Not implemented   | All unsupported                             |

DSH support is conditional on a successful version probe and ACP initialization.
Resume also requires the peer to advertise sessionCapabilities.resume.
The registry lists verification requirements; a probe alone does not claim that
the protocol, authentication or a model request has worked.

Use the original DSH executable, rather than an rdsh shim. An explicit executable
is required, so capability inspection does not accidentally boot a PATH wrapper.
An unknown version, invalid wire message or mismatched protocol disables
operations. A missing method disables the affected operation. Protocol failures
require a new adapter after the CLI contract is fixed and tested.

## Commands

Run these commands from the repository's dashboard directory:

    node cli.mjs adapters
    node cli.mjs adapters --cli dsh --executable /path/to/original/dsh
    node cli.mjs adapter-smoke --executable /path/to/original/dsh --project /path/to/repo

When a platform needs a Node entry point rather than an executable script:

    node cli.mjs adapter-smoke --executable /path/to/node --entrypoint /path/to/dsh/lib/bin.js --project /path/to/repo

The catalog starts no child. A probe runs only the selected executable's version
command. The lifecycle smoke uses a temporary HOME and DSH_HOME, passes no
provider credentials, creates a session, stops the child, resumes that session
in a second child and confirms both exits. It makes no model request. Its output
marks send as unexercised, cancellation as a written notification, usage as
unavailable and authentication as unverified. Temporary homes are removed only
after all managed children have exited.

## Node API

Import createCliAdapter from dashboard/adapters.mjs and provide an explicit
command array, canonical project cwd and, when needed, a controlled environment.
Every adapter exposes the same methods:

| Method         | Result or failure                                                       |
| -------------- | ----------------------------------------------------------------------- |
| capabilities() | All six operations, verified/detected versions and current health       |
| probe()        | Version check; capabilities still require protocol negotiation          |
| start()        | session/new acknowledgement and the CLI-generated session ID            |
| resume(id)     | session/resume acknowledgement for exactly that session and cwd         |
| send(id, text) | Text ACP prompt; completion requires the peer's stopReason              |
| interrupt(id)  | Cancel notification written, acknowledged=false                         |
| usage(id)      | Observed context occupancy, or unavailable with no fabricated zero      |
| stop()         | Close owned sessions, EOF, then TERM/KILL if needed; confirm child exit |

Send and usage require a session attached through this adapter. Simultaneous
prompts to one session are rejected as busy. Cancellation is confirmed by a
cancelled prompt result, rather than by writing to stdin.
Stop remains callable to clean up an owned child after other capabilities fail.
EOF or a requested signal alone is not reported as process exit.

Usage updates are context occupancy and capacity, not billable token counts or
money. The API returns null for those quantities. No cost is inferred from
message length or context occupancy.

JSON events carry a sequence, source version, observation time and
untrusted_data provenance. Consumers must treat CLI content as data. This client
advertises no filesystem or terminal services and denies permission requests;
it does not approve tools on behalf of a human. It is not an OS sandbox and does
not restrict the CLI's own access to its environment or files.
Raw stderr and peer error strings are not copied into errors or CLI diagnostics.
NDJSON frames are limited to 1 MiB and malformed frames revoke compatibility.

## Verification

The versioned fixture is dashboard/test/fixtures/dsh-acp-0.2.0-rc.2.json,
derived from the published DSH ACP 0.2.0-rc.2 implementation and ACP SDK 1.4.0.
Tests exercise real child processes and the public CLI, including all operations,
unsupported CLIs, unadvertised resume, unknown versions, bad JSON/UTF-8, oversized
frames, invalid usage, timeouts, early exit, permission refusal, same-session
input conflicts and confirmed stop.

Run npm test in dashboard. For an installed DSH, run the isolated adapter-smoke
command above. Successful fixture prompts do not prove provider authentication.
[Recorded output and real DSH smoke](evidence/cli-adapters.md) distinguish those
two scopes.

The contract follows the official ACP
[session lifecycle](https://agentclientprotocol.com/protocol/v1/session-setup)
and [prompt/cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn)
interfaces. New CLI versions need updated fixtures and an isolated smoke before
being added to the verified-version list.
