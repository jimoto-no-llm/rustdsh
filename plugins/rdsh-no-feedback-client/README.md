# rdsh-no-feedback-client

Browser half of [`rdsh-no-feedback`](../rdsh-no-feedback), bundled with
[rdsh](https://github.com/jimoto-no-llm/rustdsh).

## What it hides

DSH's sidebar account menu is built from a fixed list in
`@deepseek-ai/dsh-client-ui-settings-account`: **Settings**, **Feedback**, **Sign in**.
The host half turns the feedback surface off, but that launcher row is hard-coded in the
component, so it survives and opens a request form against a Remote this profile never
serves. No slot, option or config removes it.

This bundle's client script watches the menu and hides the row whose label is
`Feedback` / `意见反馈` / `フィードバック` **and** which carries the paper-plane glyph. It only
acts on the signed-out menu (`[data-signed-out="true"]` on the trigger) and leaves a
signed-in menu untouched. The pass is idempotent, so re-renders keep the row hidden.

## Why a separate package

The client module graph keys on package name, and a package that declares both
`dsh.bundle.patch` and `dsh.client` gets one graph id for two different jobs. Keeping the
browser half in its own package gives each half its own row: the host bundle owns the
patch layer, this package owns the browser module.

## Install

`plugins/install.sh` attaches this package together with the host half whenever
`features.feedback` is off (the default). By hand:

```sh
dsh plugin --profile web add "$(pwd)/plugins/rdsh-no-feedback-client"
dsh plugin --profile web remove rdsh-no-feedback-client   # revert
```

## Caveats

- The match keys on the shipped label and glyph. A DSH upgrade that renames the row makes
  the selector match nothing, so the stock menu stays visible instead of the sidebar
  breaking. Re-check after an upgrade.
- The Web profile is the only one with a browser; on `headless` this package is inert.
