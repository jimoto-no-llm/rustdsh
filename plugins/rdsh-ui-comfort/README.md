# rdsh-ui-comfort

Make Enter deliberate in the DSH Web chat, bundled with
[rdsh](https://github.com/jimoto-no-llm/rustdsh).

## What it changes

Two DOM-level hooks, both registered on `window` in the capture phase so the
shell's own React and Lexical handlers see a decision before they act.

### Composer: Enter twice sends

A plain Enter no longer sends. The first Enter inserts a line break, and a
second Enter inside 1.5 seconds sends the message. The line break is the
shell's own Shift+Enter path and the send is its own Enter path, so chips,
attachments, streaming and the send button behave exactly as before.

### Goal strip: Enter never commits

While the goal editor is open, Enter no longer commits the edit — including the
Enter that confirms an IME conversion, which upstream passes to the same
`onKeyDown` handler as a typed Enter. The editor stays open, Ctrl/Cmd+Enter
(or the check button) commits, and Escape cancels as before.

## Keys

| Key | Composer | Goal editor |
| --- | --- | --- |
| Enter | line break; a second Enter within the window sends | nothing (the edit stays open) |
| Shift+Enter | line break (stock) | nothing |
| Ctrl/Cmd+Enter | send (stock) | commit the edit |
| Escape | stock | cancel the edit (stock) |
| IME confirmation Enter | left to the shell | never commits |

Enter inside a completion menu (`[data-trigger-menu]`), Enter while composing
(`isComposing`, `keyCode 229`), key auto-repeat and every modified Enter are
left untouched, so the slash menu, the `@` mention menu, the workspace picker
and Ctrl+Enter keep their own meaning. The queue-dock textarea
(`[data-queue-dock]`) is not a composer input and is not hooked.

## Settings

The plugin reads `localStorage["rdsh-ui-comfort:v1"]` on every key press, so a
change applies without a reload. The **rdsh 入力** section in DSH Settings edits
the same store; `window.__rdshUiComfort` exposes it from the console.

| Member | Default | Meaning |
| --- | --- | --- |
| `doubleEnter` | `true` | Enter twice sends; `false` restores stock Enter-to-send |
| `goalGuard` | `true` | protect the goal editor from Enter; `false` restores upstream |
| `windowMs` | `1500` | how long the first Enter keeps the "second press sends" arm open (200–5000) |

Both behaviours default to on, so the plugin is useful with no configuration.
An unknown or unreadable value falls back to the defaults.

## Install

`./plugins/install.sh` installs this plugin when it is listed among the
bundled plugins. For one profile:

```sh
dsh plugin --profile web add "$(pwd)/plugins/rdsh-ui-comfort"
```

Refresh the Web UI afterwards; a profile with live patch reload picks the client
half up without a service restart. Remove it with
`dsh plugin --profile web remove rdsh-ui-comfort`.

## Verification

- `node --test plugins/rdsh-ui-comfort/test/logic.test.mjs` drives the shipped
  bundle in a VM and checks the pure decision tables: first/second/expired
  Enter, the window boundary, another composer, `isComposing`, `keyCode 229`,
  Shift/Ctrl/Meta/Alt, auto-repeat, an open completion menu, and both switches
  off.
- `node --test plugins/rdsh-ui-comfort/test/dom.playwright.test.mjs` loads the
  real bundle into a fixture page in Chromium, presses Enter from the keyboard
  and asserts the fake shell's own handlers: line break on the first Enter,
  send on the second, stock send for Ctrl+Enter, and no goal commit on a plain
  or composing Enter. The test skips when no Chromium is available.
- The anchors were read from the shipped DSH client:
  `[data-composer-input]` is the contenteditable in
  `@deepseek-ai/dsh-client-ui-conversation`, `[data-goal-bar]` and its
  `input[type=text]` are in `@deepseek-ai/dsh-client-ui-goal`, and
  `[data-trigger-menu]` is in `@deepseek-ai/dsh-client-ui-input-trigger`.

## Caveats

- Upstream ships hashed CSS-module class names; this plugin matches only the
  stable data attributes above. A DSH rename removes the hook and leaves the
  stock Enter behaviour in place (fail closed), so re-check the three packages
  after a DSH upgrade.
- The goal strip is a single-line `<input>`, so Enter cannot insert a newline
  there; it is a no-op rather than a commit.
- The plugin changes what Enter does, not how a message is sent: it never calls
  the send path itself. The second Enter is the shell's own key.
