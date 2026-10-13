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
PROFILE=web SOUND=0 GITVIEW=0 ./plugins/install.sh  # skip the default third-party Web UI plugins (below)
```

### Desktop app (Electron) profile

The Desktop application owns the reserved `desktop` profile and its own
bundled command runtime, and the npm `dsh` CLI refuses to manage it. Use the
profile installer, which forwards every package to the app's own command:

```sh
PROFILE=desktop ./plugins/install.sh              # recommended + bundled + default third-party plugins
PROFILE=desktop COMPUTE=1 ./plugins/install.sh    # plus the compute bridge
PROFILE=desktop SOUND=0 GITVIEW=0 ./plugins/install.sh  # skip the default third-party plugins
```

It runs `rdsh desktop install --no-bundled --package <spec>`, which invokes
`resources/runtime/cli/bin/dsh plugin --profile desktop add ...`. Quit the app
before attaching and reopen it afterwards; the app's own **Plugins** page can
install the same packages without a command runtime. The installers do the same
inline with `./install.sh --desktop` or `.\install.ps1 -Desktop`. See
[docs/DESKTOP-INTEGRATION.md](../docs/DESKTOP-INTEGRATION.md).

## Default Web UI plugins (third-party, MIT, used with permission)

Installed by default for `PROFILE=web` / `PROFILE=desktop`. Other profiles
can opt in with `SOUND=1` / `GITVIEW=1`. Set `SOUND=0` or `GITVIEW=0` to skip one, or
`features.sound=false` / `features.gitview=false` in `rdsh.json` to veto them.
`rdsh desktop install` includes both by default as well (`--no-sound` /
`--no-gitview` to skip).

| Package | Why |
| --- | --- |
| `github:cwd514/dsh-sound-notifications` (MIT, (c) 2026 cwd514) | Effect sounds (Web Audio synthesis, no audio files) and desktop notifications for reply-done / approval-waiting / questions / errors / re-login. Zero dependencies, no build step. Verified by upstream on DSH `0.2.0-rc.2` Web UI. |
| `github:yugapor/dsh-gitview` (MIT, (c) 2026 yugapor) | Git panel in the Web sidebar: working-tree changes, staging and commits, unified/side-by-side diffs, commit graph, branches, blame, reflog, and CI status. Verified by upstream on DSH `0.2.0-rc.2` Web UI. |

Notes:

- Browser client plugins: use `PROFILE=web`. Desktop notifications additionally
  need a secure context (`127.0.0.1`/`localhost`/`https`) and the browser's
  notification permission; otherwise only the sounds play (see upstream README).
- Installed from upstream GitHub at install time, not vendored here, so fixes
  arrive without a rustdsh release. Upstream repos:
  <https://github.com/cwd514/dsh-sound-notifications> and
  <https://github.com/yugapor/dsh-gitview>.
- Credits: see [Credits](../README.md#credits). Both plugins are used with
  upstream permission under their MIT licenses.

## Bundled rdsh plugins (this repo)

`./plugins/install.sh` also installs these local plugins into the same
profile, so the rdsh settings UI and one-click translation action are available by default:

| Plugin | Why |
| --- | --- |
| `rdsh-settings` | rdsh section in DSH settings (budgets, retrieval, memory, beta flags) |
| `rdsh-translation` | Web UI action to translate a settled answer and replace it on the history surface |

## Workflow board source preparation

The [workflow board toolkit](workflow-board/README.md) prepares an explicitly
selected, isolated DSH source checkout at its pinned revision. It is source
tooling, not an installable plugin, and `plugins/install.sh` does not install it.
It adds the board and shared workflow UI projection rules; build and adoption
of the patched DSH remain separate operator decisions.

## Filesystem skills (rdsh-docs + ponytail + rtk)

Install with `./plugins/install-skills.sh` (defaults to `~/.dsh/skills`).

| Skill | Source | Notes |
| --- | --- | --- |
| rdsh-docs | `plugins/skills/rdsh-docs` in this source checkout | Documents the verified DSH/rdsh version scope and read-only inspection procedure |
| ponytail + 5 companions | `DietrichGebert/ponytail@main` | shallow clone, `FORCE=1` refreshes with backup under `$DSH_HOME/skill-backups/` |
| rtk | local `rtk` binary (want 0.46.0+) | verified by the script; its `SKILL.md` is kept as-is |

```sh
./plugins/install-skills.sh                  # into ~/.dsh/skills
DSH_HOME=/tmp/test sh plugins/install-skills.sh  # sandbox trial
FORCE=1 ./plugins/install-skills.sh          # refresh installed skills; preserve old copies outside skills/
DRY_RUN=1 ./plugins/install-skills.sh        # preview only
```

The bundled `rdsh-docs` skill is installed only from a source checkout. It targets the `web` profile's `standard` and
`cordis` presets and tells agents to check the installed DSH version before relying on its version-pinned references.
Model selection and runtime skill loading require a separate DSH acceptance run; the installer and `rdsh skills` do not
prove that a model loaded or followed the skill.
