# Recommended plugins and skills

## Essential and recommended plugins

`./plugins/install.sh` installs plugins into a dsh profile (defaults to the
`headless` profile) in two tiers:

- **Essential** — installed on every run and printed first. The upstream tools
  that are absent from the `dsh-base` bundle (each adds real capability) plus
  the bundled rdsh settings UI, phone-width layout and answer guard.
- **Recommended** — convenience plugins you decide on. With a terminal on
  stdin the installer lists them and asks
  `Install recommended plugins? [Y=profile defaults/n/a=all/s=select individually]`;
  without a terminal the per-profile defaults apply.

### Provision an existing profile from the binary (`rdsh plugins`)

`./plugins/install.sh` needs the checkout, and nothing calls it by itself: a
release archive carries the `rdsh` binary alone. Upgrading therefore leaves
`$DSH_HOME/profiles/<profile>/package.json` untouched, and the profile keeps
whatever was attached by hand. The binary carries the same essential tier
(`src/plugin_catalog.json`, compiled in) and can report and close that gap:

```sh
rdsh plugins status                      # essential and recommended state, read-only
rdsh plugins status --profile web --json # machine-readable (schema 1)
rdsh plugins install                     # attach what the profile is missing
rdsh plugins install --profile web       # web/desktop defaults also add the starter set
rdsh plugins install --recommended=all   # every recommended plugin
rdsh plugins install --recommended=none  # essential tier only
rdsh plugins install --no-bundled        # no checkout: the upstream tools only
rdsh plugins install --plugins-dir <checkout>  # or set RDSH_PLUGINS_DIR
```

Attaching goes through the same `dsh plugin --profile <name> add <spec>` the
installer uses (`RDSH_DSH_BIN` overrides the CLI), so the result is identical.
Bundled plugins are resolved from the checkout and an absent checkout is
reported rather than skipped quietly. `rdsh doctor` prints one line per profile
whose essential tier is incomplete, `--profile desktop` forwards to
`rdsh desktop install`, and `tests/plugin-catalog.test.mjs` fails whenever this
catalog and `plugins/install.sh` disagree.

### Starter set (on by default for web and desktop)

A newcomer who arrives from Codex or Claude Code should get a capable setup
without choosing anything. `PROFILE=web` and `PROFILE=desktop` therefore start
with the **starter set** on: Japanese translation (`translation`), bounded
exploration subagents (`subagents`), effect sounds and notifications (`sound`),
the Git panel (`gitview`) and visual answers (`intelligent-ui`). Plugins that
change a familiar default (`ui-comfort` replaces Enter-to-send, `easy-work`
replaces the empty-chat preset picker) or need extra setup (`compute`) stay off.
`headless` keeps the essential tier only, so CI and automation are unchanged.
`--recommended=starter` selects the same set on any profile; `=0` on one
variable (for example `INTELLIGENT_UI=0`) or `--recommended=none` turns it off.

Choose a set explicitly (or for CI) with `--recommended`:

| Value | Effect |
| --- | --- |
| *(unset)* | per-profile defaults: the starter set for web/desktop, nothing for others (see the Default column below) |
| `starter` | the beginner starter set on any profile |
| `all` | every recommended plugin |
| `none` | essential plugins only |
| `list` | print the catalog, essential tier first, then exit |
| `id,id` | exactly the listed ids |

Ids: `translation`, `compute`, `easy-work`, `subagents`, `ui-comfort`,
`sound`, `gitview`, `intelligent-ui`. The `RECOMMENDED` environment variable
carries the same value for callers that only set the environment. An explicit
spec replaces the `TRANSLATION`, `COMPUTE`, `EASY_WORK`, `SUBAGENTS`,
`UI_COMFORT`, `INTELLIGENT_UI`, `SOUND` and `GITVIEW` defaults;
`features.sound=false` / `features.gitview=false` in `rdsh.json` still veto
those two, even under `--recommended=all`.

```sh
./plugins/install.sh                    # PROFILE=headless (default); essential only
PROFILE=web ./plugins/install.sh        # + the starter set (translation, subagents, sound, gitview, intelligent-ui)
./plugins/install.sh --recommended=list # catalog: essential first, then recommended
./plugins/install.sh --recommended=none # essential plugins only
./plugins/install.sh --recommended=all  # every recommended plugin
./plugins/install.sh --recommended=compute,gitview
DRY_RUN=1 ./plugins/install.sh --recommended=all  # print the dsh plugin commands only
PROFILE=web SOUND=0 GITVIEW=0 ./plugins/install.sh  # skip the default third-party Web UI plugins
PROFILE=web INTELLIGENT_UI=0 ./plugins/install.sh    # starter set without visual answers
./plugins/install.sh --recommended=starter            # the starter set on another profile
```

### Essential plugins (always installed)

One entry below is conditional: `rdsh-no-feedback` is attached unless
`features.feedback` is explicitly `true` (rdsh turns the DSH feedback
surface off by default so rdsh-specific issues never reach the DSH
upstream). Every other row is attached on every run.

| Package | Why |
| --- | --- |
| `@deepseek-ai/dsh-tool-present` | Final deliverables as file cards (spreadsheets, decks, images) |
| `@deepseek-ai/dsh-tool-ask-user` | Ask the user for confirmation, choices, or missing info mid-run |
| `@deepseek-ai/dsh-tool-str-replace-editor` | Claude-Code-style `view`/`create`/`str_replace` editor tool |
| `@deepseek-ai/dsh-skill-office` | Word / PowerPoint / Excel creation, edits, and PDF conversion |
| `@deepseek-ai/dsh-hooks-claude-code` | Reuse your existing Claude Code `hooks.json` during agent runs |
| `@deepseek-ai/dsh-tool-bash-persistent` | Shell with cwd/env/jobs persisting across calls |
| `@deepseek-ai/dsh-mcp-client` | Use tools from external MCP servers (`mcp__<server>__<tool>`) |
| `rdsh-settings` | rdsh section in DSH settings (budgets, retrieval, memory, beta flags) |
| `rdsh-mobile-ui` | Phone-width layout for the DSH Web chat: full-width chat and composer, one-tap logo to the session list. Adapted from Smart-DSH (MIT) — see [its README](rdsh-mobile-ui/README.md). |
| `dsh-mobile-maxxing` | PWA install, phone/tablet UX, in-app and Web Push notifications, and CJK Markdown tables for the Web UI. Bundled after `rdsh-mobile-ui` so its rules take priority over the Smart-DSH-derived layout. See [its README](dsh-mobile-maxxing/README.md). |
| `rdsh-answer-guard` | When a turn ends with the reply only in the reasoning channel, the reader sees no answer and the agent looks stuck. The guard steers one reminder so the model restates it as text. `rdsh features off answer_guard` disables it — see [its README](rdsh-answer-guard/README.md). |
| `rdsh-update-banner` | Release banner and notifications in the Web UI (`PROFILE=web` only). Installing it keeps the profile's own insert block from failing to import on every boot (issue #5). |
| `rdsh-no-feedback` | Turn off DSH's Like/Dislike on assistant messages and the `/feedback` dialog and command. Attached by default (`rdsh features on feedback` restores the surface — see [its README](rdsh-no-feedback/README.md). |
| `rdsh-no-feedback-client` | Hide the sidebar **Feedback** row, which DSH hard-codes and the patch layer cannot remove. Attached with `rdsh-no-feedback`; the Web profile is the only one with a browser. |

The upstream entries were verified present in the shipped dsh distribution and
absent from the `dsh-base` bundle, so each one adds real capability. The
`rdsh-*` entries are bundled in this repo.

The banner's package supplies a bundle patch. A Web profile previously wired
with `install-banner.sh` may also have a manual insert with the same ID. DSH
`0.2.0-rc.2` combines entries by ID and applies the profile's entry after the
bundle entry, retaining the manual configuration. This installer leaves that
profile patch untouched. After upgrading to a different DSH loader version,
check its duplicate-ID behavior before migrating existing profiles.

### Recommended plugins (optional)

| Id | Package | Default | Why |
| --- | --- | --- | --- |
| `translation` | `rdsh-translation` | web, desktop | Japanese translation settings and preview |
| `compute` | `rdsh-compute` | off | Web compute bridge (`rdsh features on compute`) |
| `easy-work` | `rdsh-easy-work` | off | Guided file-organization workflow entry points |
| `subagents` | `rdsh-subagent-optimizer` | web, desktop | Bounded exploration subagents |
| `subagent-route` | `rdsh-subagent-route` | off | Provider, model and reasoning effort every new child agent starts with, picked in **Settings -> Subagents** |
| `ui-comfort` | `rdsh-ui-comfort` | off | Deliberate Enter in the DSH Web chat: the composer sends on a second Enter within 1.5 s instead of the first, and the goal editor keeps Enter from committing the edit; both toggle live in the **rdsh 入力** settings section through `localStorage`. |
| `sound` | `github:cwd514/dsh-sound-notifications` (MIT, (c) 2026 cwd514) | web, desktop | Effect sounds (Web Audio synthesis, no audio files) and desktop notifications for reply-done / approval-waiting / questions / errors / re-login. Zero dependencies, no build step. |
| `gitview` | `github:yugapor/dsh-gitview` (MIT, (c) 2026 yugapor) | web, desktop | Git panel in the Web sidebar: working-tree changes, staging and commits, unified/side-by-side diffs, commit graph, branches, blame, reflog, and CI status. |
| `intelligent-ui` | `dsh-intelligent-ui` (bundled; MIT, (c) 2026 cwd514) | web, desktop | ChatGPT-style visual answers: the model calls the declarative `render_ui` tool and the plugin draws the view (tables, charts, comparisons, timelines, inputs, calculators; 15 block types, nesting up to 6 levels). A browser client plugin, so `PROFILE=web` is the intended target; skip it with `INTELLIGENT_UI=0`. |

Notes:

- The three GitHub entries are fetched from upstream at install time, not
  vendored here, so fixes arrive without a rustdsh release. Upstream repos:
  <https://github.com/cwd514/dsh-sound-notifications>,
  <https://github.com/yugapor/dsh-gitview> and
  <https://github.com/cwd514/dsh-intelligent-ui>. `sound` and `gitview` are
  used with upstream permission under their MIT licenses (see
  [Credits](../README.md#credits)); `intelligent-ui` is MIT by its author.
- `sound` and `gitview` are browser client plugins, so `PROFILE=web` is the
  intended target. Desktop notifications additionally need a secure context
  (`127.0.0.1`/`localhost`/`https`) and the browser's notification
  permission; otherwise only the sounds play (see the upstream README).
- `intelligent-ui` is a third-party Web client plugin, vendored into
  `plugins/dsh-intelligent-ui` and shipped in the release archive. It is part of
  the web/desktop starter set; skip it with
  `INTELLIGENT_UI=0` or `rdsh desktop install --no-intelligent-ui`. It has no
  `features.*` veto in `rdsh.json`.
- `subagent-route` is off by default. It writes the `agentOptions` block of the
  profile's `tool-subagent` loader entry, so DSH itself pins the provider, model and
  effort a child starts with; a child that is already running keeps the route it
  started with. A profile whose delegation tool comes straight from a bundle layer
  has no entry to write, and the section reports that instead of saving. See
  [its README](rdsh-subagent-route/README.md).
- `ui-comfort` is a Web client plugin that deliberately replaces the stock
  Enter-to-send in the composer, so it stays **off** by default and never enters
  the web/desktop default set: opt in with `--recommended=ui-comfort` (or
  `UI_COMFORT=1`). It is bundled here, so no network fetch happens at install
  time. See [its README](rdsh-ui-comfort/README.md).
- `rdsh-easy-work` file organization executes on Linux; Windows and macOS
  preview only. `rdsh-subagent-optimizer` uses the native DSH `spawn`
  provider (0.2.0-rc.2). See their READMEs and the
  [acceptance evidence](../docs/reviews/2026-10-14-easy-work.md).

### Desktop app (Electron) profile

The Desktop application owns the reserved `desktop` profile and its own
bundled command runtime, and the npm `dsh` CLI refuses to manage it. Use the
profile installer, which forwards every package to the app's own command:

```sh
PROFILE=desktop ./plugins/install.sh              # essential + default recommended, forwarded
PROFILE=desktop ./plugins/install.sh --recommended=all       # every recommended plugin
PROFILE=desktop ./plugins/install.sh --recommended=none      # essential only
PROFILE=desktop COMPUTE=1 ./plugins/install.sh    # plus the compute bridge
PROFILE=desktop SOUND=0 GITVIEW=0 ./plugins/install.sh  # skip the default third-party plugins
```

It runs `rdsh desktop install --no-bundled --package <spec>`, which invokes
`resources/runtime/cli/bin/dsh plugin --profile desktop add ...`. Quit the app
before attaching and reopen it afterwards; the app's own **Plugins** page can
install the same packages without a command runtime. The installers do the same
inline with `./install.sh --desktop` or `.\install.ps1 -Desktop`. See
[docs/DESKTOP-INTEGRATION.md](../docs/DESKTOP-INTEGRATION.md).

## Third-party credits

Third-party sources used by the installers and the bundled plugins. These
projects are independent of rdsh; their licenses and copyrights stay with their
authors.

| Upstream | License | How rdsh uses it |
| --- | --- | --- |
| [Smart-DSH](https://github.com/hikarioyama/Smart-DSH) by hikarioyama | MIT | Source of the phone-width layout bundled as `rdsh-mobile-ui` (the mobile rail of its `dsh-notify-push` browser bundle). Its Web Push notifications, Esc-to-stop, task hub and shared-HMR workaround are not bundled. |
| [dsh-sound-notifications](https://github.com/cwd514/dsh-sound-notifications) by cwd514 | MIT | Recommended `sound` plugin: effect sounds and desktop notifications. Default on for web/desktop; skip with `--recommended=none`, `SOUND=0`, or `features.sound=false`. |
| [dsh-gitview](https://github.com/yugapor/dsh-gitview) by yugapor | MIT | Recommended `gitview` plugin: sidebar Git panel. Default on for web/desktop; skip with `--recommended=none`, `GITVIEW=0`, or `features.gitview=false`. |
| [dsh-intelligent-ui](https://github.com/cwd514/dsh-intelligent-ui) by cwd514 | MIT | Recommended `intelligent-ui` plugin: `render_ui` visual answers in the DSH Web chat. Default on for web/desktop; skip with `--recommended=none`, `INTELLIGENT_UI=0`, or `rdsh desktop install --no-intelligent-ui`. |

## Workflow board source preparation

The [workflow board toolkit](workflow-board/README.md) prepares an explicitly
selected, isolated DSH source checkout at its pinned revision. It is source
tooling, not an installable plugin, and `plugins/install.sh` does not install it.
It adds the board and shared workflow UI projection rules; build and adoption
of the patched DSH remain separate operator decisions.

## MCP resource artifact source preparation

The [MCP resource artifact patch](mcp-resource-artifacts/README.md) prepares
an explicitly selected DSH source checkout at its pinned revision. It is
source tooling, not an installable plugin; it adds scoped resource-link reads
and bounded image/file attachments while keeping binary payloads out of model
text. Building and adopting the patched DSH remain separate operator decisions.

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
