# Connection diagnostics

Project dashboards expose a read-only **接続診断** panel and an authenticated
`GET /api/diagnostics`. The local command returns the same report:

```sh
rdsh-dashboard diagnostics --project /path/to/project
```

The command uses the project's private runtime administrator credential only
against its literal loopback HTTP endpoint. Missing/invalid runtime, an
unreachable dashboard and rejected authentication produce a bounded diagnostic
and nonzero exit status. It does not start services, repair Serve, rotate keys
or retry an answer. Browser credentials and administrator credentials may read
the report; MCP and reply-consumer credentials may not.

## Two independent paths

| Path                                     | Observable stages                                                                                                                                                                        | Remaining external checks                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Phone → Tailscale → dashboard            | Current dashboard response, browser bearer acceptance, loopback/Serve host, current local Serve route                                                                                    | Actual phone, its Tailscale login and displayed project/revision        |
| Dot → Secure MCP Tunnel → MCP → callback | Latest recorded local Tunnel process/generation and health, MCP bearer acceptance, MCP 2 discovery/tool/event responses, subscriptions/expiry, signed callback verification and delivery | Which MCP client is Dot and the actual Dot response in its conversation |

`observed_at` describes the observation at that stage. Browser authentication
and MCP responses are retained in memory for the current dashboard instance.
Callback success/failure timestamps persist with the existing private Events
state across restarts; their old timestamps remain visible. Subscription counts
and expiry are calculated at report time. A recorded prior success never
replaces the latest failure.

Serve inspection runs only `version`, `status --json` and `serve status --json`.
It does not call `serve --bg`. A correct local route does not establish phone
reachability. A browser request is classified by its accepted host, not by
user-agent strings or an inferred device type.

MCP discovery observations are successful JSON-RPC responses to
`server/discover`, `tools/list` and `events/list` on the MCP 2 endpoint. An
accepted bearer alone is a different stage. Legacy HTTP/stdio tools and their
resource notifications remain available; this panel does not reinterpret those
as native Events discovery. The six tool names and state schema stay unchanged.

## Tunnel identity and restart diagnosis

`rdsh-dashboard tunnel` forwards the bearer to the original official client
through its environment reference. Each invocation writes a fresh private
`tunnel-health-<owner>.url` and `tunnel-runtime.json` containing the dashboard
instance generation and child process birth identity. Diagnostics observe the
latest recorded launcher for that project. Run one intended Tunnel launcher per
project; this metadata is an observation, not authority to stop any process.

A new dashboard creates a new instance and bearer. If the previously recorded
Tunnel process is still observed with the same birth identity, its old instance
is reported as `stale_credentials`; no old health port is probed. A gone or
reused PID is reported stopped. Missing/unsupported process identity remains
unconfirmed. Uninstrumented older launchers remain unconfirmed until explicitly
restarted with this version.

Health requests require a validated project/owner record, a live matching
process, the current dashboard generation, and a bounded URL file containing a
literal `http://127.0.0.1:<port>/`. Only `/healthz` and `/readyz` HTTP status codes
are used, with timeouts and redirects disabled. No credential is sent and no
health response body is retained. An invocation retires its own exit marker and
health file; it cannot overwrite a newer invocation's record during cleanup.

## Recovery by stage

| Observation                                   | Smallest next action                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Browser authentication rejected after restart | Open the latest QR or `rdsh-dashboard open` URL again.                                                         |
| Serve login/DNS/route missing                 | Check Tailscale on both devices; deliberately use the existing share refresh when configuration is needed.     |
| Tunnel stopped/unreachable/not ready          | Start the dashboard first; inspect the intended original Tunnel client and its local health UI.                |
| Tunnel retains old generation                 | Stop that launcher and rerun the same Tunnel command against the current dashboard.                            |
| MCP bearer rejected                           | Restart the Tunnel; manually configured MCP clients must reload the regenerated HTTP connection configuration. |
| Discovery absent/failed                       | Discover the tools/events through the intended ChatGPT connection.                                             |
| Subscription expired or verification failed   | Renew the intended subscription; check receiver HTTPS, signing key and challenge response.                     |
| Callback network/4xx/429/5xx failure          | Check the receiver and the existing bounded delivery retry; do not replay an answer or assume a Dot response.  |

Task startup prerequisites remain a separate
[preflight report](TASK-PREFLIGHT.md). Connection diagnostics do not establish
provider authentication, model selection or permission to execute work.

## Evidence boundaries

The [official Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
defines local health/readiness checks. The
[official Events contract](https://developers.openai.com/plugins/build/mcp-events)
separates callback acceptance from subsequent asynchronous processing and asks
the operator to verify the ChatGPT response. A callback `2xx` establishes receipt
by that receiver, not that Dot answered or a native CLI applied the answer.

The current protocol does not expose a Dot-response receipt to this server.
Accordingly `dot.response` and `end_to_end` remain **unconfirmed**, even if every
local stage has succeeded. Do not invent a receipt from a subscription, health
response, native CLI result or operator checkbox. Verify the actual question →
human answer → signed callback → Dot response in the intended conversation
before claiming external end-to-end success.

Reports contain fixed reason codes, stage timestamps and filtered subscription
metadata. They omit bearer/signing keys, callback URLs, health detail bodies,
raw errors, private roots, command lines and environment values.
[Technical evidence](evidence/connection-diagnostics.md) covers the independent
failure fixtures and restart/redaction checks. Real Dot and phone validation
remain outstanding, so the PR references issue #43 without closing it.
