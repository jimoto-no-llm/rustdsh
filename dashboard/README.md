# Project dashboard and private Harness access

[Worker scopes and worktrees](../docs/WORKER-WORKSPACES.md): local CLI allocation,
source/worker conflict scans and retained checkouts after lease expiry or release.

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

[Offline fault simulator](../docs/FAULT-SIMULATOR.md) reproduces six seeded
control-plane failures with local mock peers, saved input/reports, and Windows/Linux CI.

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
| `project` | Project metrics, tasks, questions, human answers, progress | Twelve project-scoped MCP tools                  |
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
pwsh -NoProfile -ExecutionPolicy Bypass -File ./dashboard/install-windows.ps1

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

On native Windows the installed launcher starts `project` and `harness` in the
notification area without keeping a console window open. Right-click the icon for
**Open / 開く** or **Exit / 終了**; double-click also opens the authenticated page.
Windows notification-area settings control whether it sits in the hidden-icons overflow.
Each icon's tooltip identifies its project (or `rdsh Harness`). The helper receives
only a small Windows runtime environment; provider credentials are not forwarded.
Exit calls this instance's existing scoped shutdown: a managed Harness run must
have verified stopped before the icon/server disappear. If verification fails,
the icon remains with a warning so you can inspect the stop status and retry.
Closing the browser leaves the server running. CLI `stop` removes its tray too.
Independent Harness sessions and other project dashboards are not stopped.

```powershell
# Keep terminal output and Ctrl-C behavior for scripts or troubleshooting.
rdsh-dashboard project --project C:\Projects\MyProject --no-tray
```

Other subcommands remain foreground commands. Direct `node dashboard/cli.mjs ...`
remains foreground; native Windows can explicitly request `--tray` there.
Startup failure returns an error to the caller, rather than reporting a ready tray.
If startup exceeds 60 seconds, the launcher reports that readiness is unconfirmed;
the owned server may still start. Use `open` or `stop` with that same project to
inspect or stop it before starting another instance.
The helper runs this checkout's PowerShell script with process-local execution
policy; machine/user policy is not changed and enforced Group Policy still applies.
Opening a browser passes its authenticated URL to the Windows URL handler, as the
existing `open` command does. Other processes with the same OS-user access can
observe that short-lived command line; the tray helper itself receives no URL/key.
Re-run the installer after upgrading to refresh an older launcher.
Installation uses the lockfile's native prebuilts without package lifecycle
scripts and verifies that Koffi loads before writing the launchers. An unavailable
native prebuilt fails installation; ownership checks are retained. The installed
wrapper also preserves the Node executable selected at installation time.

The checkout must stay in place: the installed launcher points to its `windows-launcher.mjs`.
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

| Tool                            | Effect                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| `dashboard_update_metrics`      | Report measured cumulative snapshots                                        |
| `dashboard_upsert_task`         | Create/update a task by ID                                                  |
| `dashboard_ask_question`        | Ask a human a question with a unique ID                                     |
| `dashboard_publish_event`       | Report progress or an artifact reference                                    |
| `dashboard_get_feedback`        | Read durable answers after a sequence cursor                                |
| `dashboard_get_state`           | Read this project's current state                                           |
| `dashboard_check_task_contract` | Preflight declared repo/cwd/write paths against a versioned task contract   |
| `dashboard_check_operation`     | Parse/audit explicit tool attributes; keep execution on hold                |
| `dashboard_request_approval`    | Create a pending request bound to one operation and its limits              |
| `dashboard_check_approval`      | Match a human grant to the current operation and next attempt               |
| `dashboard_claim_approval`      | Atomically reserve one approved attempt and declared cost                   |
| `dashboard_check_worker_start`  | Resolve requested permissions and hold startup without an enforcing adapter |

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

### Observation source and freshness (#16)

`dashboard_update_metrics`, `dashboard_upsert_task`, and
`dashboard_publish_event` accept an optional `observation` object:

```json
{
  "total_cost_usd": 2.45,
  "session_id": "session-123",
  "observation": {
    "kind": "measured",
    "observed_at": "2026-10-05T12:00:00Z",
    "source": "provider usage response",
    "session_id": "session-123",
    "reference": "request-456 / commit abc123",
    "max_age_seconds": 900
  }
}
```

Use the actual observation time, including a timezone. Source kinds are
`measured` (**実測**), `agent_reported` (**agent報告**), `estimated` (**推定**),
and `unavailable` (**未取得**). These are the authenticated reporter's claims;
the dashboard does not independently verify measurements or artifact quality.
Measured reports require both `source` and `observed_at`. Explicit estimates
remain visibly marked; missing values are never filled with zero or estimates.
`unavailable` permits only `null` numeric values. `null` always clears the value
and sets its kind to `unavailable`, even in a mixed measured report.

The server stores `recorded_at` separately from `observed_at`. It accepts past
observations, rejects future or invalid timestamps, and marks a report stale
when its observation age reaches `max_age_seconds` (default 900; allowed range
1–604800). Receipt time, unrelated events and metadata-only writes never make
an old observation fresh. The browser checks expiry every 30 seconds and when
the page becomes visible, including during a disconnected or idle session.
Expired values remain visible as previous reports, with **古い情報** replacing
the current value. Task counts include only fresh, non-estimated `done` reports;
this is a report count, not an acceptance or QA gate. Progress/artifact entries
remain history and show their own observation source and time.

Metric provenance is stored per field in `metric_observations`, including source,
reporting session, reference, observation/receipt times, and a server-generated
`report_id`. An observation applies only to numeric fields supplied in that
call (and an explicitly supplied `session_id`). Omitted fields retain both
their value and provenance. Report the numerator and denominator of cache/error
rates together: partial updates from different snapshots display **比較不可**,
and stale/missing counters do not produce a precise rate. When `session_id`
changes, session cost/budget values are cleared; project totals and cumulative
counters keep their original provenance. Supplying `observation.session_id`
alongside `session_id` requires them to match. Tasks/events store provenance in
their own `observation`; references default to the task ID or artifact path.

Existing schema-1 state and callers without `observation` remain readable.
Existing values without provenance display **出所未確認 / 鮮度未確認**; new
legacy-style reports default to `agent_reported` with no invented observation
time. Their numeric values are retained as previous reports, not treated as
current measurements. Send explicit observation metadata to show current values.
Reference strings and sources are displayed as text, never opened or executed.

Artifact references are displayed as text. Local file contents are never opened
or served. Treat all user-authored questions, answers, progress, and paths as data.

## Versioned task contracts (P0 foundation, Issue #12)

Current-main integration, fresh tests, and real browser evidence are recorded in
[the task-contract re-review](../docs/evidence/task-contract-rereview.md).

Create the task first, then save its contract with the local administrator CLI:

```sh
rdsh-dashboard set-contract --project /path/to/repo --file contract.json
```

On Windows, use absolute native paths (JSON backslashes must be escaped).
The dashboard must already be running. This command uses its local administrator
credential internally; do not copy the credential into the contract or arguments.
Use test directories and `--no-tailscale` for local validation.

```json
{
  "task_id": "M3.6",
  "expected_version": 0,
  "purpose": "Validate the launcher locally",
  "repository": "/path/to/repo",
  "allowed_scope": "Edit source and local tests only",
  "write_roots": ["/path/to/repo/src", "/path/to/repo/tests"],
  "forbidden_actions": ["No remote push, publication, or credential changes"],
  "completion_conditions": ["Affected tests pass and the change is reviewed"],
  "change_reason": "Initial task scope"
}
```

`expected_version` is zero for creation and the current version for an update.
The server serializes updates and rejects a stale version. All versions, change
reasons and timestamps remain in project state; task reports, questions, answers
and conversation summaries never replace the contract. The task row displays the
current version and its history. MCP clients read the same history with
`dashboard_get_state`, including after restart. Existing schema-1 state remains
readable; tasks without contracts are shown as unset and preflight blocks them.

Contract versions are retained without a count limit and each update rewrites the
state file. Large histories increase storage and update cost. Automatic truncation
would discard the required scope-change audit; plan an archival/migration design
before adopting frequent contract revisions. Approval request/decision histories
are also retained without automatic truncation; recent check logs are bounded.

Only `POST /api/contracts/update` with the local administrator bearer credential
can save a contract. Browser and MCP credentials cannot change it; there is no
MCP contract mutation tool. This is the existing single-owner credential boundary,
not proof of a particular human's identity. A process running as the same OS user
may still read the private runtime file. Each change marks previous approvals as
requiring revalidation; no answer is converted to an execution approval. The
approval ledger below implements declared scope/retry matching; execution adapter
integration remains required.

Before an operation, call `dashboard_check_task_contract` with:

```json
{
  "task_id": "M3.6",
  "contract_version": 1,
  "repository": "/path/to/repo",
  "cwd": "/path/to/repo",
  "write_paths": ["src/main.rs"]
}
```

The corresponding HTTP endpoint is `POST /api/contracts/check`. `within_scope`
(HTTP 200) means only that these declared paths passed preflight. `block` or
`unparsed` (HTTP 409) must stop the caller. The stdio and HTTP MCP routes return
the same structured decision. Checks do not write state or read file contents.
The read-only check intentionally accepts administrator, MCP and human browser
project credentials, matching access to project state; unauthenticated requests
are rejected. Browser access does not grant contract mutation or operation execution.
They require the active version and project repository, check cwd containment,
and check both lexical and resolved write destinations. Empty `write_roots` means
no writes. Roots must exist when saved; a new write leaf may be absent. Escaping,
retargeted and dangling symlinks/junctions fail closed. Parent traversal and
ambiguous Windows device/ADS/drive-relative paths are unsupported. Diagnostics
return fixed reason codes without echoing supplied paths or command text.

This is an opt-in preflight boundary, not an execution grant or OS sandbox.
`allowed_scope`, `forbidden_actions` and `completion_conditions` are descriptive;
they are saved and displayed but are not parsed as executable policy. Commands,
read paths, network destinations and shell syntax are not evaluated; supplying
unknown fields returns `unparsed`. The existing launcher and original DSH tool
execution do not call this check automatically. Adapter integration, structured
tool/command policy (Issue #29), approval matching (Issue #30), input provenance
(Issue #32) and actual sandbox enforcement (Issue #33) are needed before expanding
execution permissions. Filesystem or contract changes after preflight can
invalidate a result; recheck at use, and rely on an execution sandbox for enforcement.

### Structured operation policy (Issue #29 foundation)

Contracts may add `operation_policy` with `schema: 1`, `read_roots`, `executables`
and `network_origins`. Omission grants no read/command/network rights in this
structural layer. Write roots remain the contract's `write_roots`. Read roots must
be existing directories inside the project. Each executable rule has an absolute
existing `file` and an exact `args` array; the stored rule retains the argument
count and SHA-256 digest, without raw argument values. Network rules are exact
HTTPS origins without credentials, paths, queries or fragments.

`dashboard_check_operation` (or `POST /api/policy/check`) accepts task ID, contract
version, repository and this explicit operation envelope:

```json
{
  "schema": "rdsh.operation.v1",
  "tool_name": "file.write",
  "tool_input": {"cwd": "/path/to/repo", "path": "src/new.txt", "content": "fixture"}
}
```

Supported tool input schemas are:

| Tool | Required input fields |
| --- | --- |
| `file.read` | `cwd`, `path` (existing regular file) |
| `file.write` | `cwd`, `path`, `content` (at most 64 KiB) |
| `process.exec` | `cwd`, `executable` (absolute file), `args` (exact direct argv) |
| `network.request` | `cwd`, `url` (HTTPS), `method`, `body` (at most 64 KiB) |

Unknown tools/fields, raw shell commands, recognized shell executables, ambiguous
paths and unresolved inputs return `unparsed`. This does not infer a tool's
effects from words in its text. Path, cwd, executable/argv and origin mismatches
return `block`. Only supported attributes inside the current policy return
`within_policy`; execution still returns `hold`. These are rdsh's declared input
schemas, not claims that external CLI tools are already adapted.

The latest 1,000 checks are durable and displayed separately from the contract.
Reasons are fixed codes; bodies, URL queries and raw argument values are omitted
from audit state. Digests bind data without duplicating it; hashes are not secret
storage or encryption. File metadata and real paths are inspected, file contents
are never read. The existing Rust pattern guard remains independent and is not
called by this layer. Responses explicitly identify pattern as `not_evaluated`,
structure as the decision, and enforcement as `not_applied`. No declared command
or network operation is executed. Automatic CLI tool interception, shell
semantics, dynamic subprocess effects and OS enforcement remain unconnected.

### Approval ledger (Issue #30 foundation)

General question answers remain feedback. They never grant operation approval.
Project credentials may inspect approval checks; only the execution/MCP bearer
may claim retry/cost reservations over HTTP. Administrator and browser credentials
cannot consume execution attempts. The shared HTTP authentication gate returns
401 for unauthenticated checks; human grant/reject/revoke remains a separate gate.
Create a request with `dashboard_request_approval` or `POST /api/approvals/request`:

```json
{
  "id": "request-1", "expected_version": 0,
  "task_id": "M3.6", "contract_version": 1, "repository": "/path/to/repo",
  "run_id": "run-1", "command_id": "command-1",
  "operation": {
    "schema": "rdsh.operation.v1", "tool_name": "file.write",
    "tool_input": {"cwd": "/path/to/repo", "path": "src/new.txt", "content": "fixture"}
  },
  "limits": {"max_cost_usd": 1, "max_attempts": 2},
  "expires_at": "2026-10-06T00:00:00.000Z",
  "source_ref": "request-artifact:command-1"
}
```

Replace the example expiry with a future UTC ISO timestamp within seven days.
Only an operation already within the current structured policy can be requested.
Each request version records project/task/contract, run/command, resolved target,
operation/data digest, limits, expiry and a reference to the original request.
The reference is untrusted display data; inspect the original request before
granting. Raw operation bodies, URL queries and argv values are not copied to the
ledger. Revisions require `expected_version` and always start pending; old versions
remain readable and their grants cannot authorize the new version.

Use the browser's dedicated approval buttons to grant, reject or revoke that
request version. Only the human browser credential can call
`POST /api/approvals/decide` with `id`, `request_version`, `decision`.
MCP and administrator credentials cannot grant approval; generic update routes
cannot bypass this boundary. The approver is the authenticated `dashboard_owner`
role, not a claim of a named person's identity. Decision history is retained.
The approval row shows current decisions/reservations and expandable past request
versions, including their scopes, decisions and uses. Past versions have no action
buttons and cannot authorize the current request.

Check or claim with the same task/repository/run/command/operation plus `id`,
`request_version`, `attempt` (starting at one) and `cost_usd`. A check reserves
nothing. A claim serializes revalidation and reservation: only the next attempt
within `max_attempts` and the cumulative declared cost is accepted. Costs have
micro-dollar precision and are declarations, not measured billing. Changed
scope/data/context, expired/revoked/rejected/pending requests and replayed attempts
fail closed. Use a new request version and obtain a new grant for changed limits
or operation data. Latest checks and all request versions survive restart.

HTTP check/claim returns 200 for `approval_valid`, otherwise 409; MCP returns the
same structured result. A valid claim **still returns `execution: hold`** and
`enforcement: not_applied`; its use record is `execution: not_started`. Claims
reserve an attempt and declared cost but do not run operations. The separate
`dashboard_execute_approved_operation` tool rechecks and consumes the approval,
then executes the exact operation through the sandbox below. A crash after the
durable start consumes that attempt and cannot be replayed. Declared cost remains
an approval limit, not measured billing.

### Sandboxed approved operations (Issue #33)

`dashboard_check_worker_start` (`POST /api/workers/check`) accepts `task_id`,
`contract_version`, `repository`, `run_id`, `worker_role` (`review` or
`implementation`). It verifies the current contract and runs a real sandbox
probe. A ready response means the Linux x64 Bubblewrap plus seccomp profile is
available; it does not start an LLM worker or grant an operation approval.
Unsupported platforms and failed probes return a hold with no fallback.

`dashboard_execute_approved_operation` is the only operation execution path in
this dashboard. It requires a fresh human grant for the exact task, role,
operation, run, command, attempt and declared cost. The attempt is durably marked
started before side effects; if the result cannot be recorded, it remains spent.
Review workers can only use `file.read`. Implementation workers are confined to
the contract's read/write roots, exact executable-and-argv digest, or exact
HTTPS origin. They cannot widen roots or provide their own sandbox settings.

Filesystem and process operations run in a Bubblewrap mount, PID, user and
network namespace with dropped capabilities, resource limits and a seccomp
filter. Only declared roots are mounted; read roots are read-only and write roots
are writable. Pinned directory and executable descriptors are passed with
Bubblewrap's fd mount options, which close the source descriptors after mounting.
Nested mount points, symlinks, hardlinks and special files already present in
operation roots are rejected.
Child processes inherit the same namespace, limits and seccomp filter. Network
requests go through a separate HTTPS broker that pins a resolved public IPv4,
rejects private/reserved or mixed DNS results, and does not follow redirects.
Operation output is returned to the caller but not stored in the approval ledger.

This executor applies only to operations explicitly routed through the dashboard
MCP/API. It does not start a worker, intercept arbitrary DSH tools, or protect
against another host process concurrently modifying a declared root or changing
its mount table.
Direct DSH tool dispatch remains denied by the guard described below. On Windows
and other unsupported environments, execution stays on hold; there is no
unsandboxed fallback.

### DSH operation boundary (Issues #29/#30/#32/#33, partial)

`dsh-guard.mjs` exposes a programmatic Cordis plugin (`apply`, `inject: ["tools"]`)
and `attachDshGuard(ctx, config)`. Attach it to a dedicated DSH context with the
real `ToolRuntime` already registered, before starting workers or invoking tools:

```js
const guard = attachDshGuard(ctx, {
  task: { task_id, contract_version, repository, run_id, worker_role },
  readState: async () => currentProjectState,
  recordCheck: async (report) => durableHostAudit(report),
});
const startup = await guard.ready();
// This release always holds startup: do not start the protected worker.
```

The host owns state freshness, serialized state access, durable audit and the
entire protected context's lifetime. Missing callbacks or `tools.guard` fail
installation. Audit failures deny execution. Do not unload this plugin or reuse
its context as an unprotected worker; `guard.stop()` keeps denial installed.
This API does not edit the installed DSH configuration or the original launcher.

The plugin registers DSH's synchronous, monotonic `tools.guard` before its
asynchronous `tools/pre-execute` checks. It maps the exact `read {file_path}` and
`write {file_path,content}` subset from `dsh-tool-fs` 0.2.0-rc.2 to task policy,
then checks the bound approval and worker enforcement requirements. Extra fields,
escalation flags, offsets, editors, shell tools, PTC transports and unknown tools
are unsupported. A later policy returning `allow`, skipping asynchronous checks,
or DSH's own one-time approval cannot force this guard to allow execution.

Direct DSH dispatch is deliberately held even when a human grant exists. The
dashboard's separate MCP operation tool is the only route that can execute an
approved operation through the OS sandbox. The guard connects denial to actual
DSH tool dispatch but does not itself prove filesystem/network/child-process
containment. Mapping uses the contract repository as the declared cwd; actual
backend resolution must also be verified before the guard could allow direct
execution. The legacy
`rdsh`/`dsh` passthrough, initial context loading, direct backend access, plugin
unloading and LLM requests remain outside this protected tool boundary.

Host code can bind an approval reference and attributed external data to one
call ID with `guard.bindCall(callId, {approval, sources})`. The approval reference
has only `id`, `request_version`, `attempt`, `cost_usd`; it cannot mint a grant.
It is consumed as a binding once per check, without consuming the ledger's
retry/cost allowance. External `repository`, `tool_result`, `web` and `agent`
envelopes created by `provenance.mjs` always have `untrusted_data` authority.
Summary/forward transformations preserve original references, content digests
and lineage. These are self-reported attribution, not identity authentication or
cryptographic proof. `renderExternalQuote` renders content/references using
`textContent`; audit reports retain metadata/digests, not source or operation
bodies. Reports list uninspected session replay, compaction, context injection
and direct-backend paths. Automatic source capture through those DSH subsystems
and integration into the dashboard source UI remain unfinished.

The real-runtime fixture uses existing libraries without DSH boot/auth/LLM:

```sh
RDSH_DSH_MODULE_ROOT=/path/to/existing/node_modules/@deepseek-ai \
  node --test test/dsh-runtime.integration.mjs
```

It is separate from `npm test` and fails if the existing libraries are missing.
Tested with DSH ToolRuntime 0.2.0-rc.2; no runtime dependency is added.

## OpenAI ChatGPT Dots and MCP Events

The project HTTP `/mcp` endpoint implements MCP 2.0 (`2026-07-28`) discovery and
native `events/list`, `events/subscribe`, and `events/unsubscribe`, with the same
project bearer authentication used for tools. Available events:

- `dashboard.answer.created`
- `dashboard.question.created`
- `dashboard.task.updated`
- `dashboard.progress.updated`
- `dashboard.metrics.updated`
- `dashboard.contract.updated`
- `dashboard.policy.checked`
- `dashboard.approval.requested`
- `dashboard.approval.decided`
- `dashboard.approval.checked`
- `dashboard.approval.claimed`

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

## Selective history backup

`backup preview|export|inspect|restore|history` selects task/answer/decision/evidence
history, holds all source prose by default, and restores a separate historical
collection using the target dashboard's own authentication. Reviewed replacement
text can be supplied explicitly; active commands, credentials and event
subscriptions are never transported. See the
[history backup contract](../docs/HISTORY-BACKUP.md) for selection, review and
collision handling. `backup history` exposes imported records through the local
control CLI; the existing state resource also includes `history_backups`.

## Project-scoped pinned updates

`release stage|inspect|canary|promote|rollback` captures a compatible original DSH,
Node and adapter snapshot, qualifies it in one project and widens only explicitly.
Managed `session-ledger start|resume` and `reply-consumer once|serve` omit executable
overrides and dispatch through the captured CLI. Project defaults apply to new
runs; existing runs retain their own artifact and native ID through rollback.
See the [pinned update contract](../docs/STAGED-UPDATES.md) for trusted code roots,
selection revisions, native qualification and recovery. This controls local
managed runs; global updates, external user plugins and provider/billing adoption
are separate.

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
Observation tests additionally cover idle expiry, independent field freshness,
source/session/reference persistence, legacy state, invalid metadata, explicit
unknown values, session cost resets, and incompatible ratio snapshots.
