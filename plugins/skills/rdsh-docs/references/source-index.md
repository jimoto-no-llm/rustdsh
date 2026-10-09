# DSH and rdsh source index

## Verified DSH baseline

Checked 2026-10-10. `npm view @deepseek-ai/dsh@latest version` returned `0.2.0-rc.2`; the installed `dsh --version` returned the same version. The matching official source tag is [`dsh-v0.2.0-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2) at commit `639ed015397290b3745d163aafe02ffee4aa3f84`.

Use these version-pinned primary sources first:

- [`web` profile, `standard` preset](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/bundle/web-app/presets/standard.patch.yml) — mounts `@deepseek-ai/dsh-skill-filesystem` and `@deepseek-ai/dsh-tool-skill`.
- [`web` profile, `cordis` preset](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/bundle/web-app/presets/cordis.patch.yml) — mounts the skill provider/loader and `@deepseek-ai/dsh-tool-cordis`.
- [`dsh-skill-filesystem` package reference](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/skill/skill-filesystem/README.md) — directory skills use `<root>/<name>/SKILL.md`; `name` and `description` frontmatter are required; `$DSH_HOME/skills` is the user DSH root.
- [`dsh-tool-skill` package reference](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/skill/tool-skill/README.md) — the visible `skill` tool loads the body; a user-invocable skill can also be loaded with `/name`.
- [`dsh-tool-cordis` package reference](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/extensions/tool-cordis/README.md) — `cordis_inspect_list` finds providers and `cordis_inspect_query` retrieves selected declarations.

The version-pinned npm package and its `repository` field are available at [@deepseek-ai/dsh on npm](https://www.npmjs.com/package/@deepseek-ai/dsh). If the installed version differs, use its installed package documentation or matching source tag. `main` pages can describe behavior added after this baseline.

## rdsh implementation

These paths are relative to the `rustdsh` repository checkout:

- [`src/inspect.rs`](../../../../src/inspect.rs) — `rdsh profiles` and `rdsh skills` list directory names; they do not inspect active DSH runtime state.
- [`src/passthrough.rs`](../../../../src/passthrough.rs) — resolves and delegates to the original DSH CLI. The delegated `dump-config` emits a broad effective profile configuration and is unnecessary for skill validation.
- [`plugins/install-skills.sh`](../../../install-skills.sh) — installs source-tree skills and third-party filesystem skills into an explicit or default DSH home.

Read the current checkout and tests for exact rdsh behavior. Do not infer that a feature works in an installed DSH merely because a local file or directory exists.
