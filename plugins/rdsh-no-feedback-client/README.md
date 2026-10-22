# rdsh-no-feedback-client

Browser half of [`rdsh-no-feedback`](../rdsh-no-feedback), bundled with
[rdsh](https://github.com/jimoto-no-llm/rustdsh).

## What it hides

DSH's sidebar account menu is built from a fixed list in
`@deepseek-ai/dsh-client-ui-settings-account`: **Settings**, **Feedback**, **Sign in**.
The host half turns the feedback surface off, but that launcher row is hard-coded in the
component, so it survives and opens a request form against a Remote this profile never
serves. No slot, option or config removes it.

This bundle's client script hides the row whose label is `Feedback` / `意见反馈` /
`フィードバック` **and** which carries the paper-plane glyph. It acts only on the signed-out
menu, which the component marks with its `signedOutMenu` CSS-module class; the menu is
portalled out of the trigger, so the trigger's `data-signed-out` flag is not an ancestor.
A signed-in menu is left untouched, and the pass is idempotent across re-renders.

## Why a separate package

The client module graph keys each registered factory by the Loader entry name, and a
package that is both a patch layer and a browser module answers to two different ids.
Keeping the browser half in its own package gives the host bundle the patch layer and
this package the client row.

The row id must equal that Loader entry name (`rdsh-no-feedback-client`). A scoped id
loads without registering, and the whole application batch fails with it.

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
