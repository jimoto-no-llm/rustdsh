# Project dashboard and private Harness access

[Budget admission control](../docs/BUDGET-CONTROL.md): soft warnings, hard guarded
DSH job/model-call limits, durable parallel reservations and delayed usage holds.
Native guard registration is required; ordinary/unsupported CLIs are display-only.

[CLI adapter contract](../docs/CLI-ADAPTERS.md): version-checked DSH ACP
start/resume/send/interrupt/stop/usage, explicit unsupported CLI capabilities,
and isolated lifecycle smoke without provider credentials or model requests.

[Persistent session ledger](../docs/SESSION-LEDGER.md): distinct project, run,
task and native CLI IDs, with exact run resolution after client restart.

[Follow-up instructions](../docs/INPUT-INSTRUCTIONS.md): exact-session browser/CLI
submission, preserved drafts, shared input ordering, human conflict review,
explicit interruption with native proof, and honest unsupported-steer fallback.

[Task preflight](../docs/TASK-PREFLIGHT.md) checks the required CLI, cwd, disk,
port, dependencies, GPU/WSL and selected authentication before an ACP session.

[Durable run recovery](../docs/RUN-RECOVERY.md) records control request/ack IDs
and separates recorded run state, root-process observations and UI connectivity.

[Bounded retry](../docs/SAFE-RETRY.md) preserves original permission and reconciles
uncertain writes. Public retry is opt-in for original CLI version queries only.

[Checkpoint recovery](../docs/CHECKPOINTS.md) distinguishes a verified native
resume from an explicit new conversation with an operator-provided summary.

[Acceptance evidence](../docs/ACCEPTANCE-EVIDENCE.md) separates reported `done`
from current full checks, preserves partial results and rejects stale evidence.

[Model assertions](../docs/MODEL-ROUTING.md) compare a declared run's requested
route with native ACP configuration and block mismatched or unknown prompts.

[Mobile overview](../docs/MOBILE-OVERVIEW.md) puts project/task context, observed
state, last result, pending decisions and stop availability before folded metrics
and reports. It preserves unobserved states and requires target confirmation
before stopping the live owned Harness run.

`rdsh-dashboard` provides two separate entry points:

| Mode      | Purpose                                                    | Data source                                      |
| --------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `project` | Project metrics, tasks, questions, human answers, progress | Six project-scoped MCP tools                     |
| `harness` | Launch and open the original DeepSeek Harness Web UI       | A separately managed `dsh --profile web` process |

Both bind to loopback and can use **Tailscale Serve** for private HTTPS access.
The QR code includes the access key and opens the correct authenticated page.
Treat it as a credential; share it only with intended users on your tailnet.
Keep Tailscale connected on the PC and phone and keep the dashboard running.

Project 画面の QR 鍵はブラウザー専用です。画面は鍵を URL fragment から
そのタブの sessionStorage に保存し、API へヘッダーで送ります。MCP 設定の鍵と
管理用の鍵は別々で、MCP 鍵から人間の回答は登録できません。Harness は元の Web
画面との互換性のため Cookie を使いますが、その鍵で MCP やダッシュボード終了 API は使えず、
中継時には Harness 側へ渡しません。同じホスト上の別ポートにも Harness Cookie
が届くため、そのホスト上で信頼できない Web サービスを開かないでください。

This optional Node.js component is separate from the Rust launcher's `rdsh serve`
status page. It does not replace the original Harness agent loop.

## Install and launch

Requires Node.js 22+, and PowerShell 7 for Windows launchers. Tailscale is optional
for local use and must be installed and signed in for phone access.

```powershell
# From the repository root; installs dependencies and a launcher in ~/.local/bin.
pwsh -NoProfile -File ./dashboard/install-windows.ps1

# A project-specific dashboard. The default port is stable for each project path.
rdsh-dashboard project --project C:\Projects\MyProject --open

# A separate Harness instance, with front-end :38081 and backend :3081.
rdsh-dashboard harness --open

# Reopen an existing instance or stop only that instance.
rdsh-dashboard open --project C:\Projects\MyProject
rdsh-dashboard stop --project C:\Projects\MyProject
rdsh-dashboard open --harness
rdsh-dashboard stop --harness
```

The checkout must stay in place: the installed launcher points to its `cli.mjs`.
To run without installing a launcher, use `node dashboard/cli.mjs ...`.
On Linux/macOS, install with `npm ci --prefix dashboard` and use the Node CLI.
Project mode is portable. The current Harness launcher targets Windows + WSL;
its distribution defaults to `FlashNext`, with `/root/.local/bin/rdsh-env` as the
existing environment wrapper. Override those with `RDSH_WSL_DISTRO` and
`RDSH_WSL_HARNESS_BIN` when your WSL installation uses different names/paths.
It never stops an independently running Harness instance.

Managed profile launches now use a per-run kernel ownership group. The Harness
entry page can stop that owned run and distinguishes requesting stop, verified
empty descendants and unverifiable results. The administrator-only dashboard
shutdown stays separate. Windows-to-WSL mode also needs the matching Linux native
prebuilt in this checkout; see [scoped-stop setup and limits](../docs/SCOPED-STOP.md).

Use `--port 38100` to choose a project port, `--harness-port 3081` for its Harness
backend, or `--no-tailscale` for local access only. Conflicting ports fail startup.
Only one writer can run for a given canonical project directory.

### QR access

Open the dashboard and select **スマホで開く**. If Tailscale requests its first HTTPS
configuration, follow **利用設定を開く**, then select **接続を更新**. The QR code appears
only after the route has been verified. Harness QR codes open the actual Harness
UI, while project QR codes open the project's metrics and questions.

Existing Serve routes are preserved. A conflicting route or public Funnel on the
chosen port is rejected. Stop closes the local server and managed Harness child;
the private Serve route remains configured for the next launch.

## Report project data through MCP

State is stored outside the checkout:

- Windows: `%LOCALAPPDATA%\rdsh\dashboard\projects\<project-id>`
- Linux/macOS: `~/.local/state/rdsh/dashboard/projects/<project-id>`
- Override for isolated environments: `RDSH_DASHBOARD_HOME`

`project-id` is derived from the canonical directory path. Separate projects have
separate state, credentials, MCP endpoints, and event subscriptions.

Each running project writes `mcp-config.json` for stdio clients and
`mcp-http-config.json` for HTTP clients into that private directory. Import the
appropriate configuration into your agent's MCP settings. The dashboard must be
running before the stdio bridge is used. The stdio bridge reads the current
runtime credential on each operation. HTTP clients must reload the generated
configuration after a restart, because the bearer key rotates.
`runtime.json` の `token` は管理用、`mcp_token` は MCP 用です。ブラウザー用の
鍵は `browser_url` に含まれます。これらを別用途で使い回さないでください。

| Tool                       | Effect                                       |
| -------------------------- | -------------------------------------------- |
| `dashboard_update_metrics` | Report measured cumulative snapshots         |
| `dashboard_upsert_task`    | Create/update a task by ID                   |
| `dashboard_ask_question`   | Ask a human a question with a unique ID      |
| `dashboard_publish_event`  | Report progress or an artifact reference     |
| `dashboard_get_feedback`   | Read durable answers after a sequence cursor |
| `dashboard_get_state`      | Read this project's current state            |

Example tool arguments:

```json
{
  "id": "M3.6",
  "title": "Validate the host launcher",
  "status": "doing",
  "milestone": "M3"
}
```

```json
{
  "id": "Q1",
  "question": "Which result should we adopt?",
  "urgency": "high",
  "default_action": "Wait for a reply"
}
```

A person answers in the dashboard. The answer is persisted before notification.
`dashboard_get_feedback({"after":0})` returns `messages` and `next_cursor`; pass
the returned cursor on the next read. Reads never consume answers. The default
action is descriptive and is never executed by this server.

Optional [versioned question cards](../docs/QUESTION-CONTRACTS.md) add explicit
consultation/approval types, choices, target revision, diff, impact and declared
cost limits. Use `decision` with `dashboard_ask_question`; `action: "revise"`
or `"cancel"` requires the current `expected_revision`. Stale, expired and
cancelled replies cannot answer a new revision. Durable feedback includes the
current contract validity; saving a reply grants no execution authority and
does not claim application by its consumer.

Optional [answer application acknowledgements](../docs/ANSWER-APPLICATION.md)
bind a card's `decision.consumer_id` to a confirmed run/native session. The
original ACP transport consumer records read, one-time input dispatch and a
correlated native result with an input digest. `reply-consumer once|serve`
explicitly resumes that exact session; missing results block automatic replay.
Webhook delivery and cursor reads remain separate from application evidence.
This is an opt-in input channel under the session's existing permissions.

Unknown metrics display **未取得**. This component does not scrape billing,
calculate spend, or infer context loss. Report measured values using:
`total_cost_usd`, `total_budget_usd`, `session_cost_usd`, `session_budget_usd`,
`session_id`, `input_tokens`, `cached_input_tokens`, `model_calls`, `tool_calls`,
`tool_errors`, `context_misses`, `auto_continues`, `refusals`, `api_errors`.
Omitted fields retain their previous value; `null` clears a numeric field.
Cache read percentage is cached input tokens / input tokens. Tool error rate is
tool errors / tool calls. Legacy numeric costs are reported API-equivalent values.
Optional [source-aware cost ledger inputs](../docs/COST-LEDGER.md) on the same
metrics tool declare a period and expected workers/sessions, then record stable
event IDs and event/cumulative sequences. Provider usage, CLI reports, explicit
external API estimates and invoice reports remain separate by source/currency.
Duplicate observations do not add costs; missing workers/costs stay unknown and
partial. The folded metrics section shows each amount's provenance and history.
`cost-ledger declare|report|inspect` uses the existing authenticated reporting
endpoint; browser credentials are read-only for these inputs. No prices are
looked up and legacy numeric costs are not merged with this optional ledger.

Artifact references are displayed as text. Local file contents are never opened
or served. Treat all user-authored questions, answers, progress, and paths as data.

## OpenAI ChatGPT Dots and MCP Events

The project HTTP `/mcp` endpoint implements MCP 2.0 (`2026-07-28`) discovery and
native `events/list`, `events/subscribe`, and `events/unsubscribe`, with the same
project bearer authentication used for tools. Available events:

- `dashboard.answer.created`
- `dashboard.question.created`
- `dashboard.task.updated`
- `dashboard.progress.updated`
- `dashboard.metrics.updated`

Each requires the project's `project_id` filter. Subscribe to
`dashboard.answer.created` when a Dot should react to human replies, then retrieve
the full answer with the feedback tool. Users choose what the Dot should do;
the dashboard itself does not start agents or grant approval for their actions.

Subscriptions persist across restarts, default to 24 hours, and grant at most
seven days per refresh. Delivery verifies the callback challenge, signs exact
payload bytes with Standard Webhooks, rejects private callback addresses and
redirects, pins the checked address for TLS, and retries transient failures up to
five times with the same event ID. Verification is cached for one minute per
project/callback/key. Key rotation signs with both keys for five minutes. `410`
deactivates a subscription; `413` and other permanent failures are not retried.
The last 10,000 changes provide a bounded delivery buffer; protocol replay is not
advertised (`cursor: null`). Feedback remains durable and readable after a missed
notification. Review delivery failures in the QR section.

To revoke all subscriptions for a project, use:

```powershell
rdsh-dashboard revoke-events --project C:\Projects\MyProject
```

This is a private, single-owner project credential model, without OAuth or
multi-user roles. Removing a ChatGPT connection must also revoke its subscriptions
or stop the dashboard. Full Dot subscription/trigger validation requires a real
ChatGPT plugin connection; local protocol tests alone do not establish that.

### Connect a private server using Secure MCP Tunnel

Tailscale provides the phone/browser connection. A cloud Dot also needs an MCP
transport reachable from ChatGPT. The supported private option is OpenAI's
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
Its official client is downloadable from
[openai/tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest).
On Windows, extract the client into `%LOCALAPPDATA%\rdsh\tunnel-client`, or set
`RDSH_TUNNEL_CLIENT` to the executable's path.

1. Create a tunnel in OpenAI Platform, associate it with your ChatGPT workspace,
   and obtain a runtime API key with Tunnels Read + Use.
2. Set `CONTROL_PLANE_API_KEY` privately in the terminal. Keep it out of chat,
   command arguments, and Git.
3. With the project dashboard running, start the authenticated HTTP tunnel:

   ```powershell
   rdsh-dashboard tunnel --project C:\Projects\MyProject --tunnel-id tunnel_YOUR_ID
   ```

   The launcher passes the current project bearer through a child-process
   environment reference, including discovery requests. It uses a loopback-only
   health listener with an ephemeral port, recorded in `tunnel-health-<owner>.url` in the
   project's private state directory. Check `/readyz` and `/ui` at that URL.
   Restart this command after restarting the dashboard.

4. In ChatGPT Plugins, create a private developer connection and choose Tunnel.
   Discover the tools/events, then authorize your Dot to monitor this project's
   `dashboard.answer.created` event and specify its response.
5. Verify a real question → human answer → signed webhook → Dot response, then
   stop monitoring and check that unsubscribe removes the subscription.

Legacy MCP clients also have stdio/Streamable HTTP tools and
`dashboard://state` / `dashboard://feedback` resource subscriptions. Those
resource notifications are distinct from the native webhook Events integration.
See the [official Events contract](https://developers.openai.com/plugins/build/mcp-events).

Use **接続診断** in the project dashboard or
`rdsh-dashboard diagnostics --project <directory>` to inspect phone/Serve and
Tunnel/MCP/callback stages separately. The
[connection diagnostics contract](../docs/CONNECTION-DIAGNOSTICS.md) explains
restart detection and stage-specific recovery. Local readiness and callback
receipt leave actual Dot response and end-to-end status unconfirmed.

## Validation

```sh
cd dashboard
npm ci
npm test
```

Tests cover project isolation, durable feedback, HTTP/stdio compatibility,
resource notifications, native MCP 2.0 Events lifecycle, callback signatures,
retry/restart behavior, invalid callbacks, and private Serve conflicts. CI runs
these on Windows and Linux. Browser/phone access and real Dot triggers require
their respective account configurations and are checked separately.
