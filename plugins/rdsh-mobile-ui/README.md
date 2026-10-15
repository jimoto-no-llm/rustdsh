# rdsh-mobile-ui

Phone-width layout for the DSH Web chat, bundled with
[rdsh](https://github.com/jimoto-no-llm/rustdsh).

## What it changes

At 767px and below the plugin appends one `<style>` element and sets
`html[data-rdsh-mobile-rail="closed"]`:

- the chat column and the composer use the full viewport width instead of
  upstream's 680px content floor, so a phone no longer shows a squeezed body;
- the collapsed sidebar becomes a 56x64 logo button that opens the session list
  in one tap, without its tooltip, sticky hover tint or Android tap flash;
- question and plan-review cards fit the phone width and wrap their footer.

Above the breakpoint the attribute is removed and no rule matches, so the stock
desktop layout stays. No rule answers, submits or mutates a question: they only
size and hide what upstream already renders.

## Credit

The rules are adapted from the mobile rail of **Smart-DSH** by
[hikarioyama](https://github.com/hikarioyama) (MIT):
<https://github.com/hikarioyama/Smart-DSH>. Smart-DSH ships that responsive
layer inside its `dsh-notify-push` browser bundle together with Web Push
notifications; rdsh bundles only the phone layout. This plugin sets its own
`data-rdsh-mobile-rail` attribute, so upstream Smart-DSH and this bundle can be
installed side by side without either half deleting the other's state. The exact
upstream revision and the MIT text are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Install

`./plugins/install.sh` installs this plugin together with the other bundled
rdsh plugins. For one profile:

```sh
dsh plugin --profile web add "$(pwd)/plugins/rdsh-mobile-ui"
```

Refresh the Web UI afterwards; a profile with live patch reload picks the client
half up without a service restart. Remove it with
`dsh plugin --profile web remove rdsh-mobile-ui`.

## Verification

- `node --test tests/rdsh-mobile-ui.test.mjs` runs the shipped browser half in a
  VM host: media query, rail attribute lifecycle, cleanup and the credit line.
- Layout was checked against a real DSH `0.2.0-rc.2` Web page at a 390x844
  viewport: the chat column and composer grow from 334px/327px (56px icon rail
  taking the rest) to 390px/383px, the document keeps
  `scrollWidth == innerWidth == 390`, and the same page at 1280px keeps the
  stock sidebar with no rail attribute.
- Upstream class names are CSS-module hashes and change between DSH releases.
  `.pI_x6G_rightbarCol` (0.2.0-rc.2) is matched next to the older
  `.pI_x6G_detailsCol`; a future rename only stops that rule from matching and
  leaves the stock layout. Re-check `dsh-client-ui-layout`,
  `dsh-client-ui-sidebar` and `dsh-client-ui-conversation` after a DSH upgrade.
- Captures and exact boxes: [phone-width layout evidence](../../docs/evidence/rdsh-mobile-ui/README.md).
