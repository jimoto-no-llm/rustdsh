# dsh-locale-ja

Separate, optional Japanese locale package for DSH. It implements the final
ownership and packaging migration of
[#80](https://github.com/kuraneko1/dsh-mobile-maxxing/issues/80).

**This package is the only owner of `ja`.** The mobile package no longer
registers a language or injects a locale pack; its `COPY.ja` is only its own
UI copy. This package is not installed or enabled by the mobile tarball, is
not added to a profile automatically, and never writes the shared display
language: the phone picker only projects the catalog for this device.

**Current catalog (2026-10-28):** DSH 0.2.1-rc.3, **65 namespaces / 2915
keys**, with zero English fallback. The previous rc.2 snapshot had 64 / 2906;
the nine added entries are translated in the current dictionaries. Device
validation remains separate from automated tests. The historical notes below
describe the earlier rc.2 snapshot unless otherwise stated.

## What the package contains

- the English snapshot: **65 namespaces / 2915 keys** from DSH
  `0.2.1-rc.3`;
- **83 Japanese values** migrated byte-for-byte from the removed mobile pack
  (`common` 41, `settings` 41, `settings.locale` 1). They are pinned by
  `test/fixtures/seed-ja-83.json` and its SHA-256, so a later edit cannot
  silently change a migrated value;
- **2832 further Japanese values**, including nine added for rc.3. Together
  with the seed they cover every key, with no generated English fallback;
- a generated package manifest, host entry and browser client;
- a reviewable batch manifest with **98 batches** of 40-50 keys (small
  namespaces and final remainders may be shorter);
- `tools/build-client.mjs` and `tools/merge-batches.mjs`.

## Migration from the mobile pack (#80)

Before this migration, `dsh-mobile-maxxing` registered three `ja`
namespaces itself and injected them as `__RDSH_PWA_LOCALES__`. That code is
gone: there is no `addLanguage`, no `register(..., "ja", ...)`, no
`LOCALE_PACKS` and no injected locale payload in the mobile package.
Consequences:

- a phone without this package offers only the host's registered locales
  (`en`/`zh`); a stored `ja` choice is ignored instead of being guessed;
- installing this package is the only way to add `ja`. It registers the
  language and all 65 namespaces through the public locale API, and disposable
  effects restore the catalog on unload;
- having both packages installed is safe now: the mobile half never calls
  `addLanguage`, so there is no second registration, and it does not own or
  dispose this package's dictionaries;
- the desktop stays a hard no-op: neither package sets the shared language or
  changes a desktop catalog.

## Consuming the catalog from the mobile plugin (#80)

The mobile plugin reads this catalog but never owns it. Its tests pin these
behaviors and the known limit they cannot cover:

- **Reviewed labels, not guessed strings.** The phone's default hide list and
  the dock's Split control match the committed `ja` renderings (`分割` and
  the hide-list labels), and the idle subagent total is noun-first
  (`サブエージェント 3 件`) while the running form is count-first. Tests read
  the committed `ja` namespaces instead of spelling those labels out, so a
  dictionary edit that breaks a probe fails there; a desktop stays a no-op.
- **Late owner, still followed.** A profile may activate this package after
  the mobile plugin attached. In addition to `locale/change`, the picker
  follows the public `localeService.subscribe()` store republishes, so
  `addLanguage`/`removeLanguage` reach it. The device choice stays a
  separate intent (a withdrawn language unprojects to System and re-applies
  when re-added), and dispose restores the latest Host view instead of
  resurrecting a withdrawn `ja`.
- **Silent Host switches are a known limit.** A Host switch to the language
  this device already projects emits no event. To restore it, the plugin
  reads DSH `0.2.1-rc.2`'s `resolveActive()` read-only while projecting, on
  System/reset and on dispose; that method is runtime-callable but private in
  its type declarations. If it is absent, throws or returns an unregistered
  id, the plugin falls back to the last published baseline and a silent switch
  is not detected. It never calls `write`/`setLocale`, and no future SDK is
  assumed to keep that internal reader available.
- **Boxed revision is a projection shortcut.** The view keeps the Host number
  (125) but passes `Object(125)` so identity-keyed text/slot caches refresh;
  `<=`, `+ 1` and JSON still see the number, and System/dispose restore the
  primitive snapshot. It adapts the SDK's public `number` type locally: rc.2
  consumers are verified, but `typeof number`/`Number.isInteger` assumptions
  elsewhere break, with no general guarantee. No Host writer calls, fake
  `locale/change` or numeric bump (`SHORTCUT(#80)`).

## Install (optional, local tarball)

This package is not part of the mobile tarball and is not published yet. The
catalog is complete, so `scripts/pack-all.mjs` will build the locale tarball;
install it separately from that local file:

```sh
node scripts/pack-all.mjs            # dist/dsh-locale-ja-<version>.tgz only when complete
dsh plugin --profile web add ./dist/dsh-locale-ja-0.1.1.tgz
# restart DSH to load the client half
```

The gate stays in place as a safeguard: `scripts/pack-all.mjs` refuses to
create the locale tarball whenever `locale/translation-status.json` is not
`complete` (zero fallback with full 65/2915 coverage). It prints `REFUSED`
with the current counts and produces no locale tarball, so an English
fallback pack can never be released as Japanese. Use `node
scripts/pack-all.mjs --require-locale` to make that refusal fail the command.
There are still no release-download URLs for this package; the local tarball
path above is preparation, not a verified production install.

## Layout

```text
package.json                 generated from locale/package-meta.json
index.js                     generated host half (intentionally empty)
client.js                    generated browser half (loader registration; one addLanguage, 64 registers)
locale/
  upstream.json              stage-1 ownership, sources, hashes, key counts
  package-meta.json          source data for the generated manifest
  batches.json               generated batch manifest
  translation-status.json    generated complete/incomplete accounting
  namespaces/en/*.json       stage-1 English snapshot (read-only here)
  namespaces/ja/*.json       reviewed Japanese values only (64 files, one per namespace)
test/
  extract-upstream.test.mjs  stage-1 extraction/reproducibility tests
  stage2.test.mjs            generation, ownership, parity, complete/incomplete and merge tests
  distribution.test.mjs      npm pack / install smoke, exports, no work/, dispose tests
  client-loader.mjs          browser-loader harness (window.__ModuleLoader__ capture)
  fixtures/seed-ja-83.json   immutable 83-value migration evidence and SHA-256
LICENSE                      MIT license text plus the upstream copyright
NOTICE                       upstream attribution notice
work/                        local batch inputs/outputs, gitignored and not shipped
```

The English files remain the key/value source of truth. The generator can
fill a missing `ja` key with the English value as a development-only
fallback, but that path is a test/development safeguard (it is what the
incomplete fixture exercises), not the current state: every source key has a
reviewed Japanese value, so the generated client has zero fallback.
`locale/translation-status.json` reports `translated` and `fallback`
counts per namespace and names the policy `development-only-english`.

## Generating the package

From the repository root:

```sh
node tools/build-client.mjs           # regenerate the five generated files
node tools/build-client.mjs --check   # exit 1 on a stale generated file
```

Generated files are `package.json`, `index.js`, `client.js`,
`locale/batches.json` and `locale/translation-status.json`. Do not edit them
by hand. The generator reads the English snapshot and the Japanese source
files, verifies the stage-1 dictionary hashes, checks key sets, duplicate JSON
keys, blank values (allowed only where the English source is blank) and
placeholder sets, then writes only those five paths. It never writes an
English file.

`client.js` is a browser bundle, not an ES module. DSH concatenates each
plugin's client file verbatim into a classic `<script>` batch, so the file only
calls `window.__ModuleLoader__.load({ id: "dsh-locale-ja", factory })`; the
loader queues that registration and materializes the factory once on first
import. Raw `export` statements would fail to parse in that position and
register nothing, so `./client` cannot be loaded with a bare Node `import`
either; that export is for the browser loader only. `index.js` stays the ESM
host entry. The factory returns:

- `language`: `{ id: "ja", label: "日本語", fallback: "en" }`;
- `dictionaries`: all 64 complete `ja` dictionaries;
- `inject`: `["locale"]`;
- `apply(ctx)`: exactly one `ctx.locale.addLanguage(language)` and 64
  `ctx.effect(() => ctx.locale.register(namespace, "ja", dictionary), label)`
  calls, so every registration has an owner-owned disposer.

## Batch translation workflow

`locale/batches.json` assigns every English key to exactly one batch. Each
batch has an `id`, one `namespace`, the namespace `sourceHash` from
`upstream.json`, and its `keys`. Read the English values from
`locale/namespaces/en/<fileName>`, where `fileName` comes from
`locale/upstream.json`.

A worker writes **only** `work/out/<batch-id>.json`:

```json
{
  "schemaVersion": 1,
  "batch": "approval-01",
  "namespace": "approval",
  "sourceHash": "sha256:...",
  "values": {
    "approve": "承認",
    "reject": "拒否"
  }
}
```

`values` must cover exactly the batch's key list: no missing keys, no extra
keys, strings with the same blankness as English (a blank value is allowed
only where the English value is blank too), and the same `{placeholder}`
names as English. Do not write English files, generated files, or another
batch's output. `work/` is gitignored and is not in the package `files` list.

A guessed translation is not a reviewed translation. A reviewer records the
exact batch hash they reviewed in `work/reviewed.json`:

```json
{
  "schemaVersion": 1,
  "reviewed": {
    "approval-01": "sha256:..."
  }
}
```

Then, from the repository root:

```sh
node tools/merge-batches.mjs --check   # validate reviewed batches, write nothing
node tools/merge-batches.mjs           # atomically update locale/namespaces/ja
node tools/build-client.mjs            # regenerate client and status
node --test packages/dsh-locale-ja/test/stage2.test.mjs
```

The merge accepts only batch ids present in `work/reviewed.json`. It rejects
a stale reviewed hash, a stale output hash, a wrong namespace, missing/extra
keys, blank values for non-blank English text, and placeholder changes. Every
reviewed batch is validated before the first write; writes are temp-file
renames under `locale/namespaces/ja/`, with the previous files restored if a
rename fails. Unreviewed outputs are ignored with a warning. The English
snapshot is never a write target. The merge does not run the generator
automatically, so the generated client stays stale until `build-client.mjs`
succeeds.

Duplicate translated values are reported as warnings (for example two
different English strings intentionally sharing one Japanese word). Duplicate
JSON keys are hard errors.

## Status and limits

- **Packing gate (safeguard):** a locale tarball is produced only when
  `locale/translation-status.json` reports the complete 65 namespaces / 2915
  keys with zero English fallback. The current status already satisfies it;
  the gate remains so a future incomplete edit cannot be packed as Japanese.
- **Current coverage (2026-10-28):** `complete` — 65 of 65 namespaces and
  2915 of 2915 keys have Japanese values; 0 fallback, 0 partial. The 83-key
  seed is unchanged; nine entries were added for rc.3.
  `locale/translation-status.json` is the source of truth;
  `node tools/build-client.mjs --check` fails if the generated files drift
  from it.
- **Fallback is test/development behavior:** the English fallback exists so
  the generator and the incomplete fixture can exercise selection and
  namespace registration. It is not used by the current catalog and must not
  be described as translation.
- **Sole ownership:** this package is the only `ja` language and namespace
  owner. The mobile package no longer registers `ja`, so both may be enabled
  together; only this package's effects add or remove the catalog entries. It
  never sets the shared display language (the phone picker projects the catalog
  for that device only).
- **Optional and not auto-installed:** the mobile tarball does not contain this
  package, does not depend on it and does not enable it. Nothing is installed
  into a DSH profile until the operator runs the separate local-tarball command
  above.
- **Loader verified in isolation, not live:** the tests materialize the real
  registration through a `window.__ModuleLoader__` harness, and a separate
  check with the real ClientModuleSystem and the upstream locale bundle in an
  isolated Chrome completed `modules.import` with 64 namespaces / 2906 keys /
  65 disposers. GUI-level checks use isolated source replacement and their
  evidence is tracked under #70 rather than here. Neither is a production
  profile install or a device run: those remain unverified, and this document
  claims no release, production or device success.
- **Batch sizing:** namespaces with at least 40 keys use 40-50 key chunks except
  the final remainder; namespaces below 40 keys stay in one short batch so a
  worker always owns one namespace per output file.
- `work/` is for local translation/review only. Keep it out of commits and
  releases; the generated manifest ships only runtime files.

## Intentionally untranslated values (allowlist)

A complete catalog has a reviewed `ja` entry for every key; a few entries are
deliberately identical to English. They are not missing translations:

- `command.token.{compact,export,feedback,goal,permission,plan}`: upstream's
  `TOKEN_ALIASES` only has en/zh execution spellings, so the English token is
  the correct value.
- `settings.account.onboardingArtworkLocale`: the artwork assets only exist
  for en/zh, so it stays `en`.
- `chat.message.stepProcess.sharedPrefix`,
  `pluginManager.sentenceSeparator`, `schedule.catalog.cron.part.join` and
  `schedule.manager.cron.part.join`: intentionally blank, exactly like their
  English source (a zero-width or other dummy character is forbidden).
- `schedule.catalog.time.locale` / `schedule.manager.time.locale`: Intl
  locale ids. They may become `ja`/`ja-JP` when complete but must never be
  blank; the acceptance test distinguishes those values from `en`.

Proper identifiers and execution tokens such as these are intentional keeps,
not untranslated keys.

## Stage 1: English snapshot and extractor

The stage-1 tool records the upstream English dictionaries and where each
namespace comes from. It does not translate anything and never creates,
rewrites or deletes Japanese files.

```sh
# Default: $DSH_HOME/runtime or ~/.dsh/runtime
node tools/extract-upstream.mjs

# Explicit runtime root, @deepseek-ai scope, or @deepseek-ai/dsh package
node tools/extract-upstream.mjs --dsh-root ~/.dsh/runtime
node tools/extract-upstream.mjs --dsh-root ~/.dsh/runtime/node_modules/@deepseek-ai

# Compare the committed snapshot with the installed sources (exit 1 on drift)
node tools/extract-upstream.mjs --check
```

`locale/upstream.json` contains `schemaVersion`, `snapshotLocale`, the
`@deepseek-ai/dsh` version, totals, and per namespace `fileName`, `owners`,
`sources` (`package`, `packageVersion`, `file`, `line`, `sha256`), a
combined `sourceHash`, `locales`, `keyCounts` and `dictionaryHashes`. It has
no timestamp, so extraction is deterministic and `--check` is a byte
comparison. It contains no translations.

The parser is an already-installed JavaScript parser: the acorn bundled with
Node first, then a project-local `acorn`, then `/usr/share/nodejs/acorn`. No
dependency is added and nothing is installed. It resolves `register()` calls
through local constants, templates, concatenation, `join`, `trim`,
`Object.freeze`, spreads and literal three-argument locale tables, and fails
with `file:line` rather than guessing when a registration cannot be resolved
statically. Imported/re-exported dictionaries, computed keys, runtime values
and data-driven tables outside the supported literal shape remain unsupported.

When a new DSH rc is installed: run the extractor, review namespace/key/text
diffs, update the Japanese source files only through reviewed batches, run
`build-client.mjs`, and run both test files plus `--check`. The 64/2906 gate
is specific to `0.2.1-rc.2`; tests skip the installed-runtime reproducibility
assertions when the installed version differs, while `--check` still fails.

## Tests

```sh
node --test packages/dsh-locale-ja/test/*.test.mjs
# or
pnpm test:locale
```

`stage2.test.mjs` covers single ownership (including the removed mobile ja
pack), 64 registrations with disposers, the immutable 83-value seed fixture and
its hash, en/ja parity and status counts for both the explicit incomplete
fixture and a complete 2906-key catalog with zero fallback, intentional-blank
acceptance and ordinary-blank rejection, intentional English/Intl keeps,
placeholder preservation, duplicate-key/value checks, batch coverage/hashes,
reviewed merge, stale hashes, all-or-nothing validation, generated `--check`
drift, and that `work/` is gitignored and absent from the package files.

`distribution.test.mjs` packs the real package with `npm pack` and checks the
standalone install: both exports resolve, no `work/` directory ships or is
created, the installed client is the single `ja` owner with side-effect-free
dispose, and `scripts/pack-all.mjs` refuses an incomplete locale while
accepting only the complete 64/2906 zero-fallback status.
