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
```

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
