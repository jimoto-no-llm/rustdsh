# Move from Claude Code / Codex to DSH

[日本語](CODING-AGENTS.ja.md) · [Install rdsh](../README.md#install)

Install rdsh, keep your project instructions, choose a model connection and start
one new conversation in DSH from your existing project.

## What carries over

| Existing item | In DSH |
| --- | --- |
| Project `AGENTS.md` / `CLAUDE.md` | Standard DSH profiles read them directly; no rename or conversion. |
| Codex ChatGPT login (OAuth) | Explicit import with `rdsh auth --import --provider openai-codex --source codex`. |
| Claude Code login or subscription | No direct import. Choose an Anthropic API key or another supported model connection. |
| Conversations and resume IDs | Stay in the original client. Start a new DSH conversation. |
| MCP, hooks, skills and approval settings | Configure what you need in DSH; no automatic conversion. |
| Editing code and running project tests | Current rdsh model tools can only inspect explicitly shared files. Host writes, network and project test execution are denied. |

Start with conversations and shared-code analysis. This release cannot replace
all of Claude Code / Codex's editing and execution capabilities. Keep the original
client and settings while trying a small project.

Conversations require **Linux x86_64 (WSL on Windows), original DSH, Node.js,
bubblewrap and prlimit**. Local CLI tools work on macOS and native Windows, but
protected agent startup is unsupported on those hosts.

## 1. Install rdsh and the original DSH

Use the [rdsh installation instructions](../README.md#install). For conversations
on Windows, run the Unix installer inside WSL. If DSH is missing, install an
audited version. Node.js 24 was used for local runtime verification.

```sh
npm install --global @deepseek-ai/dsh@0.2.0-rc.2
rdsh --version
rdsh doctor
```

Check the original DSH location and version. Audited versions are `0.2.0-rc.2`
and `0.2.1-alpha.1`. On Ubuntu, including Ubuntu in WSL, install missing isolation tools:

```sh
sudo apt-get install bubblewrap util-linux
```

DSH is a [developer preview](https://github.com/deepseek-ai/deepseek-harness).
An unpinned update can become incompatible with rdsh's execution protection.
Follow the diagnostic to select a supported environment and version if boot is refused.

## 2. Choose the model connection

Choose the authentication path for your previous client.

**From Codex, using its existing login:**

```sh
rdsh auth
rdsh auth --import --provider openai-codex --source codex
```

Run `codex login` first only if you are not signed in. Import copies the chosen
credential into DSH without modifying Codex. `setup --login` only opens login;
import remains a separate action. Check the saved state with `rdsh auth` or refresh `rdsh setup --web`.
Login discovery uses the same OS user's home. WSL does not automatically discover
native Windows logins. Sign into Codex within WSL or choose an API-key connection
if no login is found.

**From Claude Code, or using an API key:**

Add the provider and its API key together in DSH's **Settings → Models**.
Start DSH as shown in the next step before following those screen instructions.
API keys are separate from subscriptions; Claude Code subscriptions are not
transferred automatically. You can also choose a supported Codex login or
DeepSeek key instead of Claude.

For an already configured provider, `rdsh setup --web` can save or update an
Anthropic, OpenAI or DeepSeek key. Saving a key does not change the selected model.

## 3. Start in your existing project

Change into your project. This example assumes `README.md`
exists; replace it with the file you want the model tools to inspect.

```sh
cd /absolute/path/to/your/project
rdsh --share-file README.md --profile web
```

The Web profile initializes automatically on first use. In DSH:

1. Read the preview notice and press **Continue**. If DeepSeek onboarding appears and you want another provider, select **Configure later**.
2. Open **Settings → Models → Add model provider → Third-party model provider**. Choose `openai-codex` for Codex OAuth, `anthropic` for Claude, or `openai` for an OpenAI API key.
3. For imported Codex OAuth, leave the API-key field blank and **Apply**. For Claude / OpenAI, enter the API key here and **Apply**. For DeepSeek, configure the existing DeepSeek card.
4. Close Settings and use **Choose workspace** to select **the same project folder used at startup**. Switch away from an unrelated default workspace.
5. Press **New Session** to create a conversation, then use the composer's model selector to choose the added provider's model. Ask:

```text
Identify the instruction files that apply to this project and summarize the shared README.
Do not make changes yet.
```

If the folder picker opens inside DSH, use **Edit path** to enter the project's
absolute path, then confirm with **Open**.

Check the reply against the file to confirm your first conversation. Add another
`--share-file` and restart to expose more files. Sharing accepts files, not entire
directories, and leaves the original code and histories unchanged.

### Reuse instructions

The audited DSH's standard profiles load `AGENTS.md`, `CLAUDE.md` and their
`.local.md` overlays. Identical sibling content is deduplicated. Keep the files
in place. Custom profiles can disable instruction loading, so check their settings.

DSH's global instructions live in `$DSH_HOME/AGENTS.md` (usually `~/.dsh/AGENTS.md`).
Review the relevant text in `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md` and merge
it into that file if needed. Preserve any existing DSH instructions. Claude-specific
`@` includes, hooks, MCP names and Codex-specific configuration are not guaranteed to transfer.

## Familiar operations

| Previous operation | DSH / rdsh entry point |
| --- | --- |
| Start with `claude` / `codex` | `rdsh --profile web` in the project directory |
| Terminal conversation | `rdsh tui`, if a `tui` profile is installed |
| One request | `rdsh --share-file README.md --profile headless "Summarize README"` |
| Select a model | DSH's model selector; do not copy client-specific CLI flags |
| Check connection | `rdsh auth`, `rdsh doctor`, `rdsh setup --web` |
| Find a session | `rdsh sessions` lists DSH history, not the previous client's history |
| Add a progress and questions UI | Optional [project dashboard](../dashboard/README.md) |

## Recover or go back

- **Original DSH missing:** install it, then inspect discovery with `rdsh doctor`.
- **Connection fails:** check that the selected model matches the configured provider. Refresh expired logins, then import explicitly.
- **File unavailable:** check the startup directory and `--share-file`. Shared files are read-only.
- **Resume your previous workflow:** stop DSH and run `claude` / `codex` in the same project. Their settings and histories remain intact.

See the [configuration and recovery flow](USER-FLOW.md) and [settings reference](RDSH-SETTINGS.md).
