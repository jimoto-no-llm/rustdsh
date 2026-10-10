# Claude Code / Codex: start with the tools you already use

[日本語](CODING-AGENTS.ja.md) · [Install rdsh](../README.md#install)

You can keep your existing Claude Code or Codex login and workflow. The local
rdsh text tools and project dashboard need no DSH account, runtime or API key.

| Goal | Use | Prerequisite |
| --- | --- | --- |
| Estimate an instructions file | `rdsh tokens AGENTS.md` / `CLAUDE.md` | rdsh |
| Fit a long log into a text budget | `rdsh prune build.log --max-tokens 4000` | rdsh |
| Find a literal substring in local files | `rdsh search TODO --dir . --max 20` | rdsh on Unix |
| See progress and answer questions | Project dashboard through MCP | Node.js 22+, source checkout, your MCP client |
| Run DSH conversations | DSH launcher and setup | Original DSH + model connection |

## Try a local command

Install the prebuilt binary using [the Unix or Windows instructions](../README.md#install).
You do not need Rust for a prebuilt binary. In your project directory:

```sh
rdsh --version
printf 'hello rdsh\n' | rdsh tokens
```

PowerShell:

```powershell
rdsh --version
"hello rdsh" | rdsh tokens
```

For existing files, estimate your instructions and prepare a log for review:

```sh
rdsh tokens AGENTS.md       # Codex instructions, if present
rdsh tokens CLAUDE.md       # Claude Code instructions, if present
rdsh prune build.log --max-tokens 4000 > build-for-review.txt
```

Choose the instructions file that exists and supply your own log. `prune` keeps
the beginning and end; it does not summarize meaning, and omitted middle lines
may still matter. The source file is unchanged. Token counts are heuristic,
not a model tokenizer or billing measurement. Native search currently refuses
Windows; run it in WSL or keep using your agent's existing search tool there.

If useful, append this to your existing `AGENTS.md` or `CLAUDE.md`:

```text
When preparing a large text input, rdsh tokens estimates its size and rdsh prune
can retain its beginning and end within an estimated budget. Keep the original
file and inspect omitted details when needed. On Unix, rdsh search performs
literal local search. Use these tools when helpful under the existing permissions.
```

## Share progress and questions through MCP

The optional dashboard is a Node component. The release archive contains the
Rust CLI; obtain the dashboard separately from the source checkout. Keep the
checkout in place after registration. MCP means Model Context Protocol: it lets
your existing agent report work and read your answers without changing its runtime.

Clone the repository and install the locked dependencies:

```sh
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
npm ci --prefix dashboard
```

On Unix, save this checkout path, set your existing project path, and start the UI:

```sh
rdsh_repo="$PWD"
work_project="/absolute/path/to/your/project"
node "$rdsh_repo/dashboard/cli.mjs" project --project "$work_project" --no-tailscale --open
```

On Windows PowerShell:

```powershell
$rdshRepo = (Get-Location).Path
$workProject = "C:\Projects\my-app"
node "$rdshRepo/dashboard/cli.mjs" project --project "$workProject" --no-tailscale --open
```

Keep that terminal running. In a second terminal, define the same checkout and
project paths. Change into the project:

```sh
rdsh_repo="/absolute/path/to/rustdsh"
work_project="/absolute/path/to/your/project"
cd "$work_project"
```

For Codex, use a different server name for each project:

```sh
codex mcp add rdsh-my-app -- node "$rdsh_repo/dashboard/cli.mjs" mcp --project "$work_project"
codex mcp get rdsh-my-app
```

For Claude Code, register privately in this project:

```sh
claude mcp add --transport stdio --scope local rdsh-my-app -- node "$rdsh_repo/dashboard/cli.mjs" mcp --project "$work_project"
claude mcp get rdsh-my-app
```

PowerShell equivalents:

```powershell
$rdshRepo = "C:\Projects\rustdsh"
$workProject = "C:\Projects\my-app"
Set-Location $workProject
# Run the line for your client.
codex mcp add rdsh-my-app -- node "$rdshRepo/dashboard/cli.mjs" mcp --project "$workProject"
claude mcp add --transport stdio --scope local rdsh-my-app -- node "$rdshRepo/dashboard/cli.mjs" mcp --project "$workProject"
```

Run only the registration for your client. Codex stores the named server in its
configuration; Claude's local scope limits it to the project where you registered it.
See [official Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
and [Claude Code's stdio/local-scope setup](https://code.claude.com/docs/en/mcp).
Start a new agent session after registration and confirm the six tools are available.
Use the same OS environment for the server and client: native Windows paths and
state differ from WSL paths and state. For a GUI client, use its MCP settings or
CLI-shared configuration; the [generated configuration](../dashboard/README.md#report-project-data-through-mcp)
contains the exact Node executable and arguments.

The stdio bridge reads this project's current credential for each operation.
No bearer key is copied into these commands, and a server restart does not require
editing the registration. Keep provider logins in your original agent.

Give your agent this task:

```text
Use the rdsh project MCP server for this task. First read dashboard_get_state.
Register/update tasks with dashboard_upsert_task and publish progress with
dashboard_publish_event. If you need my decision, use dashboard_ask_question
and read dashboard_get_feedback for my answer. Keep the returned next_cursor
for later reads. Report only metrics you actually measured. A saved answer
alone does not grant new execution permission.
```

The dashboard displays reports only when your agent sends them; it does not
scrape other clients' histories, billable usage or models. Native start/resume,
interrupt, scoped stop and hard budget enforcement for Codex/Claude remain
unsupported in the [adapter catalog](CLI-ADAPTERS.md). Your original client keeps
running the work. Human replies must be read through MCP; automatic input into
those clients is not implemented.

## Recover or remove

If disconnected, confirm the dashboard terminal is running, Node dependencies
are installed, and both commands name the same absolute project path. Reopen it
with `node /absolute/path/to/rustdsh/dashboard/cli.mjs open --project /absolute/path/to/your/project`.
A bridge can advertise tools before the dashboard is running; a successful
`dashboard_get_state` confirms the connection. Try that before starting work.

Remove only the server you added, from the same project:

```sh
codex mcp remove rdsh-my-app
claude mcp remove --scope local rdsh-my-app
```

Stop the dashboard with Ctrl-C in its terminal, or its project-scoped `stop`
command. Removing the MCP entry does not delete saved project reports.

For failures, use the [issue form](https://github.com/jimoto-no-llm/rustdsh/issues/new/choose)
with your rdsh version, OS, client and reproduction. Keep launch URLs and keys out
of the report. [Settings and recovery](USER-FLOW.md) covers DSH setup separately.
