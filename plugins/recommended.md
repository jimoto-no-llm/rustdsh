# Recommended plugins and skills

## dsh plugins (not in `dsh-base`)

Install with `./plugins/install.sh` (defaults to the `headless` profile).
All entries below were verified present in the shipped dsh distribution and
absent from the `dsh-base` bundle, so each one adds real capability.

| Package | Why |
| --- | --- |
| `@deepseek-ai/dsh-tool-present` | Final deliverables as file cards (spreadsheets, decks, images) |
| `@deepseek-ai/dsh-tool-ask-user` | Ask the user for confirmation, choices, or missing info mid-run |
| `@deepseek-ai/dsh-tool-str-replace-editor` | Claude-Code-style `view`/`create`/`str_replace` editor tool |
| `@deepseek-ai/dsh-skill-office` | Word / PowerPoint / Excel creation, edits, and PDF conversion |
| `@deepseek-ai/dsh-hooks-claude-code` | Reuse your existing Claude Code `hooks.json` during agent runs |
| `@deepseek-ai/dsh-tool-bash-persistent` | Shell with cwd/env/jobs persisting across calls |
| `@deepseek-ai/dsh-mcp-client` | Use tools from external MCP servers (`mcp__<server>__<tool>`) |

```sh
./plugins/install.sh                    # PROFILE=headless (default)
PROFILE=web ./plugins/install.sh       # install into the web profile instead
DRY_RUN=1 ./plugins/install.sh         # print the pnpm commands only
PROFILE=web SOUND=1 ./plugins/install.sh  # also add Web sound/desktop notifications (below)
```

### Desktop app (Electron) profile

The Desktop application owns the reserved `desktop` profile and its own
bundled command runtime, and the npm `dsh` CLI refuses to manage it. Use the
profile installer, which forwards every package to the app's own command:

```sh
PROFILE=desktop ./plugins/install.sh              # recommended + bundled plugins
PROFILE=desktop COMPUTE=1 ./plugins/install.sh    # plus the compute bridge
```

It runs `rdsh desktop install --no-bundled --package <spec>`, which invokes
`resources/runtime/cli/bin/dsh plugin --profile desktop add ...`. Quit the app
before attaching and reopen it afterwards; the app's own **Plugins** page can
install the same packages without a command runtime. The installers do the same
inline with `./install.sh --desktop` or `.\install.ps1 -Desktop`. See
[docs/DESKTOP-INTEGRATION.md](../docs/DESKTOP-INTEGRATION.md).

## Optional Web UI plugins (third-party, opt-in)

Installed only when `SOUND=1` is set. Kept out of the default set so the
base install stays first-party and dependency-free.

| Package | Why |
| --- | --- |
| `github:cwd514/dsh-sound-notifications` (MIT, (c) 2026 cwd514) | Effect sounds (Web Audio synthesis, no audio files) and desktop notifications for reply-done / approval-waiting / questions / errors / re-login. Zero dependencies, no build step. Verified by upstream on DSH `0.2.0-rc.2` Web UI. |

Notes:

- Browser client plugin: use `PROFILE=web`. Desktop notifications additionally
  need a secure context (`127.0.0.1`/`localhost`/`https`) and the browser's
  notification permission; otherwise only the sounds play (see upstream README).
- Installed from upstream GitHub at install time, not vendored here, so fixes
  arrive without a rustdsh release. Upstream repo:
  <https://github.com/cwd514/dsh-sound-notifications>

## Bundled rdsh plugins (this repo)

`./plugins/install.sh` also installs these local plugins into the same
profile, so the rdsh settings UI is available by default:

| Plugin | Why |
| --- | --- |
| `rdsh-settings` | rdsh section in DSH settings (budgets, retrieval, memory, beta flags) |

## Workflow board source preparation

The [workflow board toolkit](workflow-board/README.md) prepares an explicitly
selected, isolated DSH source checkout at its pinned revision. It is source
tooling, not an installable plugin, and `plugins/install.sh` does not install it.
It adds the board and shared workflow UI projection rules; build and adoption
of the patched DSH remain separate operator decisions.

## Filesystem skills (rtk + ponytail)

Install with `./plugins/install-skills.sh` (defaults to `~/.dsh/skills`).

| Skill | Source | Notes |
| --- | --- | --- |
| ponytail + 5 companions | `DietrichGebert/ponytail@main` | shallow clone, `FORCE=1` refreshes with timestamped backup |
| rtk | local `rtk` binary (want 0.46.0+) | verified by the script; its `SKILL.md` is kept as-is |

```sh
./plugins/install-skills.sh                  # into ~/.dsh/skills
DSH_HOME=/tmp/test sh plugins/install-skills.sh  # sandbox trial
FORCE=1 ./plugins/install-skills.sh          # refresh ponytail from upstream
DRY_RUN=1 ./plugins/install-skills.sh        # preview only
```
