# DSH 0.2.2-rc.4 / rc.5 compatibility (2026-11-21)

## Scope

Add the exact `@deepseek-ai/dsh` / `@deepseek-ai/dsh-tools` 0.2.2-rc.4 and
0.2.2-rc.5 manifest pairs to the audited strict tool boundary, move the
auto-provision pin from 0.2.2-alpha.3 to 0.2.2-rc.5, and register the
0.2.2-rc.1..rc.5 adapters in `security/preload.mjs` so rc.1-rc.3 stop failing
with `RDSH_SECURITY[UNKNOWN_ADAPTER]`.

This does not declare a new ACP adapter version, change the user's installed
DSH, model routes, credentials, or default sandbox setting.

## Published artifacts

Source: the npm registry tarballs for
[DSH 0.2.2-rc.4](https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2-rc.4.tgz),
[DSH 0.2.2-rc.5](https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2-rc.5.tgz),
[dsh-tools 0.2.2-rc.4](https://registry.npmjs.org/@deepseek-ai/dsh-tools/-/dsh-tools-0.2.2-rc.4.tgz)
and [dsh-tools 0.2.2-rc.5](https://registry.npmjs.org/@deepseek-ai/dsh-tools/-/dsh-tools-0.2.2-rc.5.tgz).
They were compared with the published rc.1/rc.2/rc.3 tarballs. At audit time
`npm dist-tags` reported `latest = next = 0.2.2-rc.5` and
`alpha = 0.2.2-alpha.3`.

| Entry | SHA256 (rc.2, rc.3, rc.4 and rc.5) |
| --- | --- |
| DSH `lib/bin.js` | `36f86742e0c3cc1c3b2dbaa6582ee00b0c37bc4f5a190f7531b5303bf3efb6d9` |
| dsh-tools `lib/index.js` | `bf71a6ce1e95c5dfba06be7f69827bab19c5d2d9cf272875d92013ba2a8dadb0` |

rc.1 is the boundary between the two tool-runtime layouts: its
`lib/bin.js` is `b6640801a5a65aae9f53ca21bcce3b2ea28bd9e9554c939c1ff7c4448d91fa18`
(identical to alpha.3) and its dsh-tools `lib/index.js` is
`1889cbf718d64518dd83245d4dba1e1f080b2c5326259c3ed5b1be7a7666a2bd`. rc.2 re-cut
both entry files to the digests above.

## Upstream changes between rc.3, rc.4 and rc.5

Compared file-by-file inside each tarball:

- **dsh rc.3 → rc.4**: only `package.json`, the generated
  `docs/upgrade-guide/README.md`, and one new upgrade guide
  (`v0.2.2-rc.3/deepseek-refusal-code`). No shipped `lib/` file changed; the
  entry digest is unchanged.
- **dsh rc.4 → rc.5**: only `package.json`, `docs/config-catalog*`,
  `docs/subsystems/web*`, `docs/upgrade-guide/README.md`, and one new upgrade
  guide (`v0.2.2-rc.4/web-search-deepseek-model-default`). No shipped `lib/`
  file changed.
- **dsh-tools rc.3 → rc.4 → rc.5**: only `package.json` changed in each step.
  `lib/index.js` is byte-identical across rc.2..rc.5.

The two upgrade guides are user-visible behavior changes worth noting even
though no entry file moved:

- rc.3 → rc.4: the DeepSeek streamed refusal error code changes from
  `MALFORMED_RESPONSE` to `CONTENT_REFUSED`.
- rc.4 → rc.5: the shipped composition no longer fixes a search provider, so
  web search on a DeepSeek model falls back to legacy Messages search instead
  of the DeepSeek Search API.

Neither change touches the launcher's argument handling or the boundary
constructor anchor.

## Constructor anchor

All 0.2.2-rc.* releases still carry exactly one
`\t\tsuper(ctx, "tools");` in dsh-tools `lib/index.js` (line 417 of the
packaged file for rc.4 and rc.5). The preload uses that anchor per 0.2.2
adapter; 0.2.0/0.2.1 keep the single legacy `maxParallelSubCalls` anchor.

## Before and after

Before this change, `security/preload.mjs` had no 0.2.2-rc.* adapter entry, so
a protected run on rc.1-rc.5 exited with `RDSH_SECURITY[UNKNOWN_ADAPTER]`
even though `src/tool_security.rs` already pinned rc.1-rc.3.

After the change:

- `security/preload.mjs` registers the rc.1..rc.5 adapters and their
  constructors. It also keeps the `dsh-tools-0.2.1-rc.5` entry that the
  launcher does not audit: `plugins/rdsh-mcp-exposure` pins that release in
  its devDependencies and runs this preload under it, and the release's entry
  file is byte-identical to the audited 0.2.1-rc.3/rc.4. The launcher still
  refuses the pair because it has no `AUDITED_ADAPTERS` row.
- A Rust test (`preload_covers_every_audited_adapter`) reads the embedded
  preload and fails when an `AUDITED_ADAPTERS` id has no matching adapter
  entry, when the preload lists an id that is neither audited nor named in the
  explicit `PRELOAD_ONLY_ADAPTERS` list, or when an audited legacy adapter
  gains a per-adapter constructor key.
- With `RDSH_AUDITED_RUNTIME_RC5_022`, `tests/dsh-rc5.test.mjs` constructs
  the Cordis tool service through the preload, executes the fixed
  `printf PROBE_022_RUNTIME` command, and rejects a modified copy before its
  content runs.

## Validation results (this host, 2026-11-21)

- `cargo fmt --check`: clean.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `cargo test --bin rdsh tool_security`: 10 passed.
- `node --test tests/dsh-rc5.test.mjs tests/security-boundaries.test.mjs` with
  `RDSH_AUDITED_RUNTIME_RC4_022` and `RDSH_AUDITED_RUNTIME_RC5_022` set to the
  published runtimes: 19 passed, 5 skipped (the skipped ones need the other
  runtimes). The resolved entry digests matched the pinned `bf71a6ce…` for
  both releases.
- `npm test --prefix plugins/rdsh-mcp-exposure` with the installed
  `dsh-tools@0.2.1-rc.5` devDependency: 22 passed. Its guarded test runs the
  preload under `dsh-tools-0.2.1-rc.5`, which is the real consumer of the
  preload-only entry.
- `node --test plugins/rdsh-subagent-optimizer/test/runtime.test.mjs` against
  the rc.5 public APIs: 1 passed.
- `node --test plugins/rdsh-compaction/test/*.test.mjs` against the rc.5
  modules: 11 passed, 1 skipped (needs `RDSH_BIN`).
- `node --test plugins/rdsh-llm-native/test/*.test.mjs` against an installed
  rc.5 runtime: 16 passed. The real-DSH test failed before the peer range
  included `0.2.2-rc.5` (dsh refused the bundle as incompatible) and passed
  after.
- `npm audit` on an rc.5-only install: 74 moderate and 1 high affected paths.
  The leaf advisories are recorded in [rc5-audit.json](rc5-audit.json), and the
  same `undici`/`@modelcontextprotocol/client`/`fflate` advisories as alpha.3
  remain. Moving the pin does not fix them.

### Not verified

- `sh tests/runtime-bootstrap.sh` passed with the updated 0.2.2-rc.5
  expectations (three PASS lines, exit 0). It uses a fixture node/npm, so it
  proves the pin and the wrapper flow, not a real npm download of rc.5.
- `tests/runtime-bootstrap.ps1` was not run (no Windows host).
- `tests/guarded-launcher-matrix.test.mjs` was not extended to rc.5 in this
  change. The 0.2.2-rc.5 Web frontend is ~21 MB over 155 files (alpha.3 was
  ~5.6 MB), so the first protected launch spends about 110 s precompressing
  assets in a fresh `DSH_HOME` before the probe starts; the candidate matrix
  row also needs an explicit `defaultMode`/scope probe for the 0.2.2 tool
  service, which this host could not finish within the test timeout. Treat the
  rc.5 row as future CI work, not as verified behavior.
- Protected delegation itself was not exercised end-to-end under bubblewrap
  against rc.5 on this host (`unshare -Ur` works, but the launcher matrix row
  above is the only end-to-end path and it did not complete within the test
  timeout).
- `rdsh-mcp-exposure` and the third-party starter plugins were not re-tested
  on rc.5, so their peer ranges are unchanged.
