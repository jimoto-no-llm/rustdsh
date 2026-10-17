# Project dashboard and private Harness access

[Coding agent MCP quickstart](../docs/MCP-CLIENTS.md): add tasks, questions
and structured UI to your existing coding agent through the local stdio bridge.

[Worker scopes and worktrees](../docs/WORKER-WORKSPACES.md): local CLI allocation,
source/worker conflict scans and retained checkouts after lease expiry or release.

[External agent runners](../docs/AGENT-RUNNERS.md): detached cursor-agent and devin
jobs with status, cancel, permission mapping and untrusted result handling.

[Budget admission control](../docs/BUDGET-CONTROL.md): soft warnings, hard guarded
DSH job/model-call limits, durable parallel reservations and delayed usage holds.
Native guard registration is required; ordinary/unsupported CLIs are display-only.

[CLI adapter contract](../docs/CLI-ADAPTERS.md): version-checked DSH ACP
start/resume/send/interrupt/stop/usage, explicit unsupported CLI capabilities,
and isolated lifecycle smoke without provider credentials or model requests.

[Persistent session ledger](../docs/SESSION-LEDGER.md): distinct project, run,
task and native CLI IDs, with exact run resolution after client restart.

[Project profiles](../docs/PROJECT-PROFILES.md): versioned project settings,
precedence previews, and the current boundary between saved profiles and task execution.

[Follow-up instructions](../docs/INPUT-INSTRUCTIONS.md): exact-session browser/CLI
submission, preserved drafts, shared input ordering, human conflict review,
explicit interruption with native proof, and honest unsupported-steer fallback.

[Task preflight](../docs/TASK-PREFLIGHT.md) checks the required CLI, cwd, disk,
port, dependencies, GPU/WSL and selected authentication before an ACP session.

[Optional GPU leases](../docs/GPU-LEASES.md) reserve a requested UUID/VRAM amount
before original ACP attachment, report capacity waits separately from failures,
and retain uncertain ownership until actual process/group exit is confirmed.

[Resource admission](../docs/RESOURCE-ADMISSION.md) reserves local CPU, memory,
heavy-build slots and ports before a managed build or test command starts.

[Durable run recovery](../docs/RUN-RECOVERY.md) records control request/ack IDs
and separates recorded run state, root-process observations and UI connectivity.

[Managed Harness process observations](../docs/RUN-HEALTH.md) show owned process
state, stdout/stderr timestamps and aggregate dashboard reconnect gaps separately
from task completion. Missing upstream heartbeat, API-wait and CPU/GPU signals
stay unavailable; silence never triggers an automatic stop.

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
`routing enforce` adds the audited native dispatch guard on reattachment; the
human view compares actual request tuples and retains fallback permission history.

[Mobile overview](../docs/MOBILE-OVERVIEW.md) puts project/task context, observed
state, last result, pending decisions and stop availability before folded metrics
and reports. It preserves unobserved states and requires target confirmation
before stopping the live owned Harness run.

`rdsh-dashboard` provides two separate entry points:

External-agent `agents` help and CLI diagnostics use the same three languages. Its machine JSON, canonical states/codes and returned agent text stay unchanged; UTF-8 prompt files may contain Japanese filenames and instructions. [Agent runner commands and permission limits](../docs/AGENT-RUNNERS.md).

The browser chrome follows the effective rdsh language (`en`, `zh-CN`, or
`ja`). It localizes dashboard-owned labels, dates, numbers, and status text;
task titles, questions, answers, model output, paths, identifiers, API fields,
and server error details are shown exactly as received.
Choose a single invocation with `rdsh-dashboard --language ja project ...`;
selection uses `--language`, nonblank `RDSH_LANG`, `general.language`, then the
first nonblank `LC_ALL`/`LC_MESSAGES`/`LANG`, finally English. A malformed saved
language stops startup without rewriting its file. The native JSON bridges
`subagents plan`, `task-outcomes apply|validate|schema`, and
`cost-ledger validate|public|schema`, `budget-admission apply|validate|public`,
`question-contracts apply|validate|public`, `answer-applications apply|validate|public|schema`,
and `instruction-queue validate|context|submit|resolve|control` do not read settings;
they resolve display language from the explicit flag or environment and preserve
native request/output data and exit status even if `rdsh.json` is corrupt.
The cost-ledger bridge serializes its validated input into an exclusive request
file. POSIX uses mode `0600`. Windows creates a protected DACL allowing only the
current user, SYSTEM and Administrators, verifies that ACL before writing any
payload, and holds its creator handle until the native process exits. Windows
sharing rejects write, rename and parent-directory replacement while held;
delete-on-close removes the owned object without unlinking a reused pathname.
ACL/API failure stops dispatch, and a name collision never changes or removes
an existing file. Parent directory ACLs remain unchanged. Success and failure
both dispose the owned request.
Its pure actions take no project or dashboard connection. Existing
`cost-ledger declare|report|inspect` commands keep their project store path and
still refuse corrupt settings. Native cost-ledger help and diagnostics follow
the selected language; machine JSON, amounts, source text and canonical
in-process validation reasons keep their original values.
The DSH settings plugin has its own live selector; its `auto` follows the browser language.
The setup page translates known credential-sharing policy failures for display;
the status API retains canonical reasons, and unknown external details stay unchanged.
The command palette searches all three translated labels regardless of the
current display language; Escape closes it and returns focus. Known observed
CLI states and newly generated cancellation reasons use the selected language.
Received cancellation reasons and future status labels remain original values.

Programmatic callers can pass `port: 0` to `startDashboard` to reserve a loopback
port atomically. The returned port, URLs and persisted runtime/MCP metadata use
the listening socket's assigned port. Omitting the port keeps the usual default.

Display-only `--language` options are removed when re-executing an immutable
captured CLI, so older captures need no new option grammar. Other argument bytes,
option terminators, locale environment variables and captured files are preserved.
`preflight` validates the original arguments after removing its command token and
display-language options, including unexpected positionals.

| Mode      | Purpose                                                    | Data source                                      |
| --------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `project` | Project metrics, tasks, questions, human answers, progress | 19 project-scoped MCP tools                      |
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

プロジェクト画面では、Dashboard と同じ host・OS view から見える別terminalの
CLI process をPIDで読取専用登録できます。表示するのはprocessの生存状態と、登録時の
開始識別子・所有者が続いているかだけです。コマンドライン、環境変数、会話、ログは
読みません。観測解除やDashboard再起動で外部processへsignalを送りません。登録情報は
Dashboardのproject別状態ディレクトリにある `observed-cli.json` に保持し、所有者はOSの
UID/SIDそのものではなくscope付きSHA-256 fingerprintで保存します。Dashboardを別hostやPID namespaceから起動した
場合、同じPIDを同じprocessとは扱わず、識別できない状態にします。

追加端末には画面の「端末ごとの権限」から個別鍵を発行できます。閲覧のみが既定で、プロジェクト画面では質問への回答と追指示・質問取消しを個別に付与します。Harness入口では閲覧または管理中の実行停止を付与でき、端末鍵から本体のHarness画面には入れません。プロジェクトごとの鍵とHarness入口の鍵はそれぞれの `devices.json` に分けて保存します。どちらも鍵は発行時だけ表示し、保存先にはハッシュと端末名・権限・利用時刻・失効状態を記録します。失効はその端末にだけ適用され、既存のイベント接続を閉じたうえで以後のAPI要求と再接続も拒否します。既存の「スマホで開く」QRは所有者用の全権鍵なので、追加端末には個別発行リンクを使ってください。共有URLが未設定のとき、発行リンクはこのPCからのみ利用できます。端末の回答は質問への返答であり、回答によって実行権限は発行されません。

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

# Include only the additional projects you explicitly want to see here.
rdsh-dashboard project --project C:\Projects\MyProject `
  --include-project C:\Projects\AnotherProject --open

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

### Cross-project overview

Project mode can show a read-only summary for the current project and up to 31
additional projects supplied with repeated `--include-project <directory>`
options. The dashboard never searches for other projects. Each included path is
an explicit grant to show its project name and aggregate counts to users who can
open the current dashboard. It exposes only active, waiting, and needs-attention
counts; task and question details stay in the owning project dashboard.

If an included project's state cannot be read or validated, its row reports
unknown and the time it was last read successfully. Old counts are not shown.
Only the last successful read time is cached in the current project's
`project-cross-overview.json`; counts are read again on each refresh. A detail
link appears only while the owning project dashboard is running. It carries no
browser key, so the owning dashboard still requires its own human session.
Projects not named with `--include-project` are not enumerated or exposed.

The same explicit project list also enables **project cross-search** for task,
decision, log, and artifact-reference records. Search requires the current
dashboard's human browser credential, supports all-terms text queries, one
project or all included projects, record kind, date range, and a bounded result
limit. Results show a short matching excerpt, project/source, record time, and
a link to its source record when that project's dashboard is running. The link
contains no browser key and still needs that project's own human session.
Unreadable project state is reported as unknown and contributes no results.

Task, decision, and log records search their stored dashboard text. Artifact
search is reference-only: it searches the report title and sanitized path/URL,
never reads the artifact file, follows a symlink, or fetches an external URL.
Local references are checked with metadata-only `realpath`/`stat` calls inside
the owning project; a missing path is labeled stale, while external or unsafe
references remain unverified. The existing DSH Session full-text search is
unchanged and remains the place to search Session bodies; project cross-search
does not index Sessions or add semantic search.

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
PowerShell 7 is resolved from PATH and the URL handler from the Windows system
directory; an executable placed in the project or working directory is never used.
Re-run the installer after upgrading to refresh an older launcher.
Installation uses the lockfile's native prebuilts without package lifecycle
scripts and verifies that Koffi loads before writing the launchers. An unavailable
native prebuilt fails installation; ownership checks are retained. The installed
wrapper also preserves the Node executable selected at installation time.

The checkout must stay in place: the installed launcher points to its `windows-launcher.mjs`.
To run without installing a launcher, use `node dashboard/cli.mjs ...`.
On Linux/macOS, install with `npm ci --prefix dashboard` and use the Node CLI.
Project mode is portable. Managed Harness startup is selected through
`RDSH_HARNESS_PROVIDER`; `windows-wsl` is the default and the only verified
provider. It preserves the `web` profile, loopback readiness, process-scope
health observation, and verified owned-descendant stop. Its distribution defaults
to `FlashNext`, with `/root/.local/bin/rdsh-env` as the environment wrapper;
override those with `RDSH_WSL_DISTRO` and `RDSH_WSL_HARNESS_BIN` when needed.
`linux-native`, `macos-native`, `remote`, unknown providers, and `windows-wsl` on
other platforms fail with a specific reason and no silent fallback. Add a provider
only after its launch, readiness, health, and scoped-stop contract is verified.
It never stops an independently running Harness instance.

### Keep project history after moving a folder

Project IDs normally follow the canonical folder path. To keep the same tasks,
answers and evidence references after a rename or move, capture the ID before
moving the folder, then preview and explicitly apply the mapping at its new
location. The operation reuses the existing state directory; it does not copy,
merge or rewrite project history. Stop the project's dashboard first.

```powershell
rdsh-dashboard project-id --project C:\Projects\OldName
# Move or rename the project folder in Explorer or with your usual file tool.
rdsh-dashboard project-move preview --project D:\Work\NewName --from-id <project_id>
rdsh-dashboard project-move apply --project D:\Work\NewName --from-id <project_id> --expected-revision <source_revision>
rdsh-dashboard project-move rollback --migration-id <migration_id>
```

`preview` reports the source revision and task/answer counts. `apply` refuses a
changed source revision, an active dashboard, or any state already registered
for the destination path. The returned migration ID can remove the new path
mapping; rollback leaves the source state untouched. If a move is interrupted,
rerun `project-id` and `project-move preview` at the destination: an applied
mapping is reported as `already_moved` and does not duplicate history.
An abandoned identity lock expires after 30 seconds; stale same-runtime
dashboard locks are cleared only after their recorded process has exited. If a
command reports that `project-identity.lock.mutation` is busy, inspect its owner
and confirm no project-move or dashboard startup/shutdown is active before
removing that stale guard. Never remove `project-identity.lock` while its owner
may still be active.

WSL and native Windows share a project identity only when both runtimes use the
same `RDSH_DASHBOARD_HOME`. Capture the ID in the runtime that currently owns
the history and apply the explicit mapping from the runtime that will use the
new path. Paths are never joined by matching folder names.

Managed profile launches now use a per-run kernel ownership group. The Harness
entry page can stop that owned run and distinguishes requesting stop, verified
empty descendants and unverifiable results. The administrator-only dashboard
shutdown stays separate. Windows-to-WSL mode also needs the matching Linux native
prebuilt in this checkout; see [scoped-stop setup and limits](../docs/SCOPED-STOP.md).
When WSL runs the supervisor in systemd's un-delegated `init.scope`, it uses a
unique transient systemd scope and confirms that exact unit and cgroup are empty
before reporting stop success.

Use `--port 38100` to choose a project port, `--harness-port 3081` for its Harness
backend, or `--no-tailscale` for local access only. Conflicting ports fail startup.
Only one writer can run for a given canonical project directory.

### QR access

Open the dashboard and select **スマホで開く**. If Tailscale requests its first HTTPS
configuration, follow **利用設定を開く**, then select **接続を更新**. The QR code appears
only after the route has been verified. Harness QR codes open the actual Harness
UI, while project QR codes open the project's metrics and questions.

Project rows provide a **リンクをコピー** action for tasks, questions, registered
run/session pairs, and progress events. These links contain the project ID and exact
target ID only; they strip the current URL's query and fragment, so the browser key
is not copied. The browser still requires its own pairing/authentication before it
can read project state or submit an answer. If a target link is opened first, its
navigation hint is held in same-origin local storage for up to ten minutes so a QR
pairing in another tab can resume it. The target is matched against the authenticated
project ID and exact task/question/session/event ID; a different project, missing
target, or ambiguous run/session is reported instead of selecting a same-named item.
Session links bind both the native session ID and run ID. Event links identify the
event sequence and can reopen an older event outside the default recent-30 view.

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
画面はライトとダークの2テーマです。初回はOSの設定に従い、ヘッダーの
「ダーク表示／ライト表示」で切り替えると選択が保存されます。

`runtime.json` の `token` は管理用、`mcp_token` は MCP 用です。ブラウザー用の
鍵は `browser_url` に含まれます。これらを別用途で使い回さないでください。

| Tool                               | Effect                                           |
| ---------------------------------- | ------------------------------------------------ |
| `dashboard_report_provider_status` | Report provider status, quota and retry evidence |
| `dashboard_update_metrics`         | Report measured cumulative snapshots             |
| `dashboard_upsert_task`            | Create/update a task by ID                       |
| `dashboard_ask_question`           | Ask a human a question with a unique ID          |
| `dashboard_publish_event`          | Report progress or an artifact reference         |
| `dashboard_get_feedback`           | Read durable answers after a sequence cursor     |
| `dashboard_get_state`              | Read this project's current state                |
| `dashboard_create_handoff`         | Save a source-linked snapshot for one task       |
| `dashboard_get_handoff`            | Read the latest snapshot and source freshness    |
| `dashboard_present_ui`             | Present structured UI a human can act on         |
| `dashboard_record_review`          | Store a version-bound independent-review report  |
| `dashboard_get_review_evidence`    | Read review reports and freshness status         |

`runtime.json` は MCP 用の `mcp_token` と接続情報を保持し、管理 token と
ブラウザー鍵は `owner-credentials.json` に分けて保存します。stdio MCP は
`runtime.json` だけを読み、管理コマンドとブラウザー起動だけが別ファイルを開きます。
秘密を用途間で使い回しません。ブラウザー資格情報は所有者セッションの所持を示すだけで、
特定の人の身元を証明しません。同じOSアカウントで任意コードを実行できるプロセスからの
分離境界でもありません。POSIXでは秘密ファイルを0600で作成し、Windowsでは
dashboard state directoryのACLを継承します。

`state.json` にはHMAC sealを付け、状態変更のたびに検証情報を更新します。
`state-integrity.key` は状態ファイルと分けて0600で保存し、`state-integrity.enabled` を
初期化マーカーとして残します。起動時にsealの欠落・不一致や鍵の欠落を検出するとstateを
拒否します。既存schema-1 stateは、構造検証後に初回sealを
付けて移行します。これはstateへのMCP/API経由の未認可編集や、鍵を伴わない保存データの
改変を検出します。同じOSアカウントの任意コードは鍵も読めるため、その脅威モデルへの
改ざん防止や人間の身元確認を保証しません。

| Tool                                     | Effect                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `dashboard_update_metrics`               | Report measured cumulative snapshots                                        |
| `dashboard_upsert_task`                  | Create/update a task by ID                                                  |
| `dashboard_ask_question`                 | Ask a human a question with a unique ID                                     |
| `dashboard_publish_event`                | Report progress or an artifact reference                                    |
| `dashboard_get_feedback`                 | Read durable answers after a sequence cursor                                |
| `dashboard_get_state`                    | Read this project's current state                                           |
| `dashboard_check_task_contract`          | Preflight declared repo/cwd/write paths against a versioned task contract   |
| `dashboard_check_operation`              | Parse/audit explicit tool attributes; keep execution on hold                |
| `dashboard_request_approval`             | Create a pending request bound to one operation and its limits              |
| `dashboard_check_approval`               | Match a human grant to the current operation and next attempt               |
| `dashboard_claim_approval`               | Atomically reserve one approved attempt and declared cost                   |
| `dashboard_execute_approved_operation`   | Consume one approved attempt and execute it in the probed OS sandbox        |
| `dashboard_create_handoff`               | Save a source-linked snapshot for one task                                  |
| `dashboard_get_handoff`                  | Read the latest snapshot and source freshness                               |
| `dashboard_check_worker_start`           | Resolve requested permissions and hold startup without an enforcing adapter |

Example tool arguments:

Optional [outcome cards and fixed milestone criteria](../docs/TASK-OUTCOMES.md)
add purpose, ownership, latest outcome and next step to these tasks. Inspect
existing acceptance evidence from each card; reported `done`, partial checks and
operator reports never substitute for current full-check evidence. Task splits
do not change a milestone's declared criterion list.

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

### Independent review evidence

`dashboard_record_review` stores a caller-submitted review report for an existing task. It validates the worker records and target commit, but does not invoke or authenticate a reviewer; the upstream subagent service remains the execution owner.
The implementation and reviewer worker IDs must resolve to separate active
worktrees. The implementation worker must have role `edit`; the reviewer must
have role `review` with an empty declared write scope. Both checkouts and the
clean project root must match `head_sha`. `base_sha` and `head_sha` identify the
binary diff whose SHA-256 is stored with the report. Reuse `review_id` when
retrying the same report; changing the contents under an existing ID is
rejected.

Reports retain findings, checks that were not run, and unavailable reviews as
different states. A project HEAD change, uncommitted source edit, or task update
makes an earlier report stale. `dashboard_get_review_evidence` and the browser
panel show the exact target, report digest, references, and freshness. A clear
caller-reported result only makes that exact target eligible for human review;
it is not an approval, correctness guarantee, or permission grant. The worker
role and read-only declaration are recorded evidence, not proof that the native
runtime enforced an OS sandbox. Evidence references are displayed as text and
are never fetched or executed.

Optional [answer application acknowledgements](../docs/ANSWER-APPLICATION.md)
bind a card's `decision.consumer_id` to a confirmed run/native session. The
original ACP transport consumer records read, one-time input dispatch and a
correlated native result with an input digest. `reply-consumer once|serve`
explicitly resumes that exact session; missing results block automatic replay.
Webhook delivery and cursor reads remain separate from application evidence.
This is an opt-in input channel under the session's existing permissions.

The **方針の決定ログ** keeps human-selected policy records separate from AI
summaries and question history. A record can cite a saved question/answer and a
task. Replacing a decision adds a new record and preserves the prior version,
with an explicit replacement link; empty reasons and change summaries remain
marked as unrecorded. Only the authenticated browser can create, hold, or
withdraw decisions. MCP can read the log and optionally attach `policy_decision_id` to
a task. Tasks that cite replaced, held, withdrawn, or missing decisions receive
`decision_reference.confirmation_required`; the dashboard shows the referenced
and replacement policies, and leaves both records and task reports untouched.
Review and update the task's `policy_decision_id` explicitly after confirming the
current policy.

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

### Local human-effort metrics (#73)

Human-effort metrics are **off by default**. A user can enable them in the
project dashboard and choose 7, 30 or 90 days of local retention. The sidecar
`human-metrics.json` is created only after opt-in and contains only event types,
timestamps, durations and aggregate counts. Question, task, command and session
IDs, text, credentials and secrets are not retained. The dedicated endpoint requires the browser credential;
it is not an MCP tool, is absent from MCP state, and does not publish webhooks.
Export downloads an aggregate JSON file in the browser and does not send it.
Raw events are capped at 10,000; if older in-window records are dropped, the
summary marks the affected metrics as partial.

Decision time uses a user-started stopwatch that can be paused while away.
Recovery time is wall-clock time from a user-selected blocked task to the user's
stop action and can include waiting or absence. Question recurrence and
instruction resend are counted only after the user marks a specific recorded
item; text similarity and automatic replay are not inferred. Queue revision
conflicts count only the existing `queue_revision_changed` outcome. Missing
timer completions remain unpaired, and a metric with no completed samples stays
unavailable instead of displaying zero. Token snapshots are exported separately
from human-effort metrics so a token reduction cannot hide more resends or slower
recovery.

### Provider status, quota and retry hints (#59)

`dashboard_report_provider_status` records one latest report per provider and
scope. It accepts only an explicitly reported status (`rate_limited`,
`quota_exhausted`, `authentication_failed`, or `unknown`), a source label, the
actual `observed_at`, stable `event_id`, and a sequence that increases for that
scope. Quota amounts, a reason code, and `retry_after` are optional and must be
present in the provider evidence; the dashboard does not infer counts or a
countdown. Reports expire from `observed_at` using `max_age_seconds` (default
900, maximum 604800), after which retry hints are hidden and the UI asks for a
new observation. Each project is limited to 64 provider/scope records.

The dashboard is a reporting surface, not a provider adapter. Reports submitted
through this MCP tool are always marked `agent_reported`; the dashboard checks
their shape and age but does not authenticate provider origin. An agent or
integrator must obtain status through a supported provider interface and report
the result; the dashboard does not scrape provider sites or inspect CLI error
text. It displays all reported values as text and does not retry requests, run
login flows, renew credentials, or change budgets. Authentication failures and
quota exhaustion have separate guidance. The existing bounded retry coordinator
continues to honor trusted retry delays and refuses to shorten a delay that
exceeds its configured budget; this report tool does not connect provider
observations to retry execution. Browser credentials are read-only for reports;
the MCP bearer credential is required to write one.

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

Artifact references remain text until a human selects **プレビュー** on an
artifact event. The authenticated project browser can read only that event's
relative path beneath the project root; absolute paths, parent traversal,
dotfiles, symlinks, HTML/SVG, and files over 1 MiB are refused. UTF-8 text,
diffs, logs, and JSON are shown as text (never rendered as HTML), with common
credential patterns redacted and text previews capped at 128 KiB. PNG, JPEG,
GIF, and WebP are accepted only when their extension and signature agree.
Responses are private and non-cacheable. Previews never write, publish, or
share the source file. Credential redaction is a best-effort screen, not a
guarantee that arbitrary text or image content contains no secrets; inspect
the source when that assurance matters. Treat all user-authored paths as data.

### Decision inbox

The **判断待ちインボックス** groups unanswered questions, explicit failure or
dependency reports, and existing `blocked` tasks. A blocked task without attention
metadata appears as **停止中 · 種類未報告**, with its `blocker` as the reason;
the inbox does not infer a failure or dependency type. Ordinary events and metric
errors do not add alerts. Report attention through `dashboard_upsert_task`:

```json
{
  "id": "build",
  "title": "Restore the dependency download",
  "status": "blocked",
  "attention": {
    "cause_id": "package-fetch",
    "kind": "failure",
    "deadline": "2026-10-08T12:00:00Z",
    "impact": "high",
    "next_action": "Check the download log"
  }
}
```

Task attention requires `kind` (`failure` or `dependency`). Optional fields are
`cause_id` (1–160 characters), `deadline` (ISO date-time with timezone), `impact`
(`low`, `medium`, `high`, `critical`), and `next_action` (1–2000 characters).
Whitespace-only strings, invalid dates, unknown fields, and invalid types are
rejected without saving. `dashboard_ask_question` accepts the same optional
attention fields, without `kind`. Missing deadlines and impacts display 未報告.
Without a reported next action, the inbox offers answering the question or
reviewing the failure/stop reason.

Within a project, identical explicit `cause_id` values group tasks and questions;
without a known cause, each item stays separate. The default priority order uses
question urgency, earliest deadline, greatest impact, next-operation type, oldest
report, then ID. Urgency is not converted into impact. The selector also sorts by
deadline, impact, or operation type, using the default priority to break ties.
Operation order is: answer a question, review a reported next action, then review
a failure/stop reason; free-text actions are not sorted alphabetically. Missing
deadlines, impacts, and report times sort last within their comparison. Each
member retains its reported values, and buttons open the existing task row or
human answer form.

Each cause starts as a compact summary row; expand it to see every member's full
report and navigation button. Questions retain the existing approval/consultation
label and reported urgency, including when grouped with tasks. A question's
`default_action` is shown separately as informational and never runs automatically.
Long summary text is shortened visually, with the full text available in the
expanded report. Sorting and live updates preserve expanded groups and keyboard
focus within the inbox.

Omitting task `attention` preserves an explicit failure/dependency report until
`status: "done"`; moving to `doing` alone does not resolve it. An unclassified
blocked task resolves when its status changes to `todo`, `doing`, or `done`.
Sending the required task fields with `"attention": null` resolves either kind
and suppresses the blocked fallback for that stopped episode. A transition from
another status back to `blocked` starts a new episode and restores legacy reporting;
an explicit attention report can also reopen it.
A `done` update with non-null attention is rejected. An elapsed deadline does not
resolve anything. Resolving one member leaves other members of its cause group
active; human answers remove only their question. These fields never grant
permission or execute actions.

Revisioned questions follow their existing question-contract lifecycle: cancelled
or expired cards leave the actionable inbox and remain in its history. This is
separate from the reported attention deadline, which does not expire a question.
Typed approval/consultation labels use the current contract kind. Optional
attention survives a question revision when omitted; answered history keeps the
original report snapshot even if that question is later revised. Navigation to
a task opens its folded section in the current overview layout.

Task attention changes are stored in server-managed `attention_history`, separate
from the bounded event log. The history includes report snapshots before changes,
resolution, cause replacement, and recurrence; identical reports do not add
history entries. Classified reports also retain the blocker and previous blocker,
including updates that change only the stop reason. Resolving an existing blocked task with no prior history saves
its original blocker in the resolution snapshot, without inventing an earlier
report event. Original questions and answers remain in project state. The inbox's
history section remains available after resolution and restart. Clients cannot
supply or replace `attention_history`; its unclassified `blocked` snapshots are
internal, not an accepted input kind.

[#13](https://github.com/jimoto-no-llm/rustdsh/issues/13) requires actionable items with
deadline/impact/operation sorting, same-cause grouping, and retained history after
resolution. The priority and compatibility rules above are this implementation's
design proposal. Producers remain the existing MCP tools and HTTP reporting API;
this adds no automatic Harness monitoring. Dependency execution (#15), question
contracts (#40), answer application (#41), and notification delivery (#56) remain
separate work.

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
MCP contract mutation tool. This is the existing browser-owner credential boundary,
not proof of a particular human's identity. The MCP server does not open the separate
owner credential file, but a process running as the same OS user may read it. Each change marks previous approvals as
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
request version. Only the browser-owner credential can call
`POST /api/approvals/decide` with `id`, `request_version`, `decision`.
MCP and administrator credentials cannot grant approval; generic update routes
cannot bypass this API boundary. The approver is recorded as the `dashboard_owner`
role with `browser_owner_credential`, not as a verified named person. Decision history is retained.
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

This is a host-invoked plugin API, not an active product integration. The DSH
launcher, MCP entrypoint and existing tool workflows do not attach it
automatically; a host must add the plugin in its own code and keep the protected
context dedicated.

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
References are bounded locators: URL userinfo, queries, fragments and common
credential-shaped assignments are rejected, so callers must supply a redacted
reference when a source URL contains tracking or secret parameters. This is
input hygiene, not authentication of the claimed source.
Summary/forward transformations preserve original references and link every
content digest to the immediately preceding digest. These are self-reported
attribution, not identity authentication or cryptographic proof.
`renderExternalQuote` renders content/references using
`textContent`; audit reports retain metadata/digests, not source or operation
bodies. Reports list uninspected session replay, compaction, context injection
and direct-backend paths. The pinned DSH `tools/result` hook exposes a final tool
outcome but does not assign repository/web/agent origin metadata to arbitrary
result text. Automatic source capture through those DSH subsystems and
integration into the dashboard source UI remain unfinished.

The real-runtime fixture uses existing libraries without DSH boot/auth/LLM:

```sh
RDSH_DSH_MODULE_ROOT=/path/to/existing/node_modules/@deepseek-ai \
  node --test test/dsh-runtime.integration.mjs
```

It is separate from `npm test` and fails if the existing libraries are missing.
Tested with DSH ToolRuntime 0.2.0-rc.2; no runtime dependency is added.

The opt-in [local integration queue](../docs/INTEGRATION-QUEUE.md) applies fixed
worker commits in order to a dedicated worktree and requires current full-check
evidence before the next integration. Only explicit local CLI actions execute
Git/checks; queue registration and dashboard/MCP reads grant no push authority.

## OpenAI ChatGPT Dots and MCP Events

The project HTTP `/mcp` endpoint implements MCP 2.0 (`2026-07-28`) discovery and
native `events/list`, `events/subscribe`, and `events/unsubscribe`, with the same
project bearer authentication used for tools. Available events:

- `dashboard.answer.created`
- `dashboard.question.created`
- `dashboard.task.updated`
- `dashboard.progress.updated`
- `dashboard.metrics.updated`
- `dashboard.provider_status.updated`
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

## Project notification inbox

The human-authenticated project dashboard also provides a local notification
inbox. It prioritizes unanswered questions, explicitly recorded failed or
succeeded run transitions, and blocked or completed task reports. A task's
`done` status remains a report rather than acceptance proof, and a process exit,
disconnect, or unknown run state does not become a failure or completion alert.
Repeated reports for the same task and status, and events for the same run, are
grouped with their source event IDs and a bounded run-event summary.

Progress and metrics are grouped into one low-importance item per category and
filtered by the default `normal` importance. The inbox distinguishes filtered,
quiet-hours-held, ready, unread and read states; `critical` questions bypass
quiet hours. Quiet hours use the configured IANA time zone. Read state and
preferences are stored in the project's private dashboard state directory, so
they are shared by browsers for that project. The inbox is part of the dashboard
and does not create OS push notifications or change the native MCP Events
subscription, expiry, signature or retry contract. If the run-history journal
cannot be read, the dashboard says run notifications are unconfirmed while
continuing to show other inbox items.

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

Project MCP clients expose `dashboard://state`, `dashboard://feedback`,
`dashboard://handoff`, and `dashboard://acceptance` resources. Legacy and stdio
clients also support resource subscriptions. The handoff is a human-readable
snapshot, not a session resume; missing details stay unknown, arbitrary event
artifact references are not opened, and test commands are not rerun. Registered
acceptance evidence is inspected read-only for integrity metadata without
copying file contents or private paths. Reads compare saved source fingerprints
with current task, decision, artifact, and acceptance records. Resource
notifications are distinct from the native webhook Events integration. See the
[handoff packet contract](HANDOFF-PACKETS.md).
See the [official Events contract](https://developers.openai.com/plugins/build/mcp-events).

Use **接続診断** in the project dashboard or
`rdsh-dashboard diagnostics --project <directory>` to inspect phone/Serve and
Tunnel/MCP/callback stages separately. The
[connection diagnostics contract](../docs/CONNECTION-DIAGNOSTICS.md) explains
restart detection and stage-specific recovery. Local readiness and callback
receipt leave actual Dot response and end-to-end status unconfirmed.

The project dashboard's **最新push・CI・レビュー状態** panel is a separate,
manual, read-only check. It compares the local HEAD and working tree with the
configured upstream branch's current SHA, then compares that SHA with the PR
head before showing required checks, review decision and each check's GitHub
event (`push` or `pull_request`). It uses the installed GitHub CLI's existing
authentication. A missing upstream/PR, changed SHA, dirty tree, pending check
or unavailable response remains unconfirmed; it never pushes, edits protection
rules or merges. The snapshot is timestamped and is not continuously refreshed.

## Selective history backup

`backup preview|export|inspect|restore|history` selects task/answer/decision/evidence
history, holds all source prose by default, and restores a separate historical
collection using the target dashboard's own authentication. Reviewed replacement
text can be supplied explicitly; active commands, credentials and event
subscriptions are never transported. See the
[history backup contract](../docs/HISTORY-BACKUP.md) for selection, review and
collision handling. `backup history` exposes imported records through the local
control CLI; the existing state resource also includes `history_backups`.

## Safe project-state migration

`state-migrate inspect|dry-run|apply|rollback` handles the explicit schema 1 to
2 transition. Stop the project dashboard before applying it. Dry-run preserves
the source; apply creates a checksum-linked exact snapshot and atomically cuts
over the state file. Rollback refuses to discard state written after migration.
See the [state migration contract](../docs/STATE-MIGRATIONS.md) for recovery
after interruption and stale-lock handling.

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

## Bounded dependency plans

`plan define|inspect|enforce|stop` connects an explicit graph to a confirmed native
run. Bound attachments enforce dependency checks, atomic task claims, concurrent
and native branch-depth limits, total starts and stop conditions at the original
Workflow/subagent boundary. The human dashboard shows blockers and expands large
graphs on demand. See the [plan contract](../docs/BOUNDED-EXECUTION-PLANS.md) for
task IDs, native spawn scope and recovery; task schema 1 and six MCP tools stay
compatible.

## Reusable workflow recipes

`recipe save|list|inspect|preview|apply` stores revisioned task workflows and
previews their resolved target, inherited authority, budget policy, dependencies,
and bounded branching before creating a disabled run plan. Risky steps wait for
their own typed approval; recipes do not add permissions or start a process.
See the [recipe format and CLI contract](../docs/WORKFLOW-RECIPES.md).

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
