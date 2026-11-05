# DSH 0.2.2-alpha.3 compatibility (2026-11-04)

## Scope

Add the exact `@deepseek-ai/dsh` / `@deepseek-ai/dsh-tools` 0.2.2-alpha.3
manifest pair to the audited strict tool boundary. Keep older pairs and reject
mixed versions. This does not declare a new ACP adapter version or change the
user's installed DSH, model routes, credentials, or default sandbox setting.

## Published artifacts

Source: the npm registry tarballs for
[DSH 0.2.2-alpha.3](https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2-alpha.3.tgz)
and [dsh-tools 0.2.2-alpha.3](https://registry.npmjs.org/@deepseek-ai/dsh-tools/-/dsh-tools-0.2.2-alpha.3.tgz).
They were compared with the corresponding published alpha.2 tarballs.

| Entry | SHA256 (both alpha.2 and alpha.3) |
| --- | --- |
| DSH `lib/bin.js` | `b6640801a5a65aae9f53ca21bcce3b2ea28bd9e9554c939c1ff7c4448d91fa18` |
| dsh-tools `lib/index.js` | `1889cbf718d64518dd83245d4dba1e1f080b2c5326259c3ed5b1be7a7666a2bd` |

The entry files are byte-identical, but their package manifests and dependencies
are not. In particular, dsh-tools moves brand/util-values to alpha.3 and
schemastery from `~3.18.6-alpha.1` to `~3.18.6-alpha.2`. The runtime smoke therefore
uses a separately installed alpha.3 tree, rather than relabeling an alpha.2 tree.
Installation used `--ignore-scripts` in an isolated temporary prefix.

## Before and after

With the published alpha.3 runtime and `RDSH_TOOL_ADAPTER=dsh-tools-0.2.2-alpha.3`,
the original preload exits 1 with `RDSH_SECURITY[UNKNOWN_ADAPTER]`.
After registration, the Cordis tool-service constructor installs the boundary;
`rdsh_inspect` executes the fixed `printf PROBE_022_RUNTIME` command and returns
exit 0 and the expected output. The probe prints `ok`.

The new tests also append executable content to a copy of the runtime and verify
that the copy is rejected before that content executes. Rust's exact-pair tests
cover mixed alpha.2/alpha.3 manifests even though their entry bytes are identical.
CI installs alpha.3 alongside the six older audited versions and supplies both
the DSH entry and tools runtime to those tests.

## Reproduce

```sh
npm install --prefix /tmp/rdsh-alpha23 --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.2-alpha.3
export RDSH_AUDITED_DSH_ALPHA23=/tmp/rdsh-alpha23/node_modules/@deepseek-ai/dsh/lib/bin.js
export RDSH_AUDITED_RUNTIME_ALPHA23=/tmp/rdsh-alpha23/node_modules/@deepseek-ai/dsh-tools/lib/index.js
cargo test --locked tool_security
node --test tests/dsh-alpha23.test.mjs
```

The installed CLI also returned `0.2.2-alpha.3` with exit 0 from `--version`, using
an empty temporary HOME/DSH_HOME. No model request or live authentication was used.
This is Linux validation; other hosts retain their existing strict-mode limits.

## Validation results

- `cargo test --locked tool_security` with the alpha.3 entry/runtime variables:
  9 tests passed, including protected-command construction against the installed tree.
- `sh scripts/check.sh quick`: fmt, all-target Clippy with zero warnings, 1,218
  Rust tests and the conflict check passed. DISPLAY/WAYLAND_DISPLAY were unset.
- `cargo test --locked --release` under the same headless environment: 1,218 passed.
- Release example tests: `benchmark_extended` 3 passed; `benchmark_models` 12 passed.
- Security Node suite with the installed alpha.3 runtime: 45 passed, 5 skipped
  (other official runtime versions were not installed for this local run).
  The two alpha.3-specific tests both executed and passed.
- `tests/regress.sh`: all 117 checks and final pipe-exit checks passed, using
  the newly built binary and `RDSH_SETUP_OPEN=0` to avoid opening a real browser.
- Model benchmark fence: 2 passed. Release policy Python: 154 passed.
- JavaScript syntax checks, Markdown lint and `git diff --check` passed.

A first release test in the desktop environment reproduced the existing
`setup_web::tests::the_page_opens_off_a_terminal_but_never_in_a_headless_session`
failure (863 passed / 1 failed). Removing DISPLAY and WAYLAND_DISPLAY made the
full matrix pass. That independent environment-dependent test is addressed in
[PR #1031](https://github.com/jimoto-no-llm/rustdsh/pull/1031); this compatibility
change does not duplicate its fix. This run did not install other audited
runtime versions locally; CI retains those installs alongside alpha.3.
