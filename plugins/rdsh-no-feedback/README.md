# rdsh-no-feedback

Turn the DSH message-feedback surface off, bundled with
[rdsh](https://github.com/jimoto-no-llm/rustdsh).

## What it disables

DSH ships the feedback feature as three entries in the Web profile's loader
tree. This bundle carries one patch layer that sets `disabled: true` on all
three:

| Loader entry | Package | What it provides |
| --- | --- | --- |
| `message-feedback` | `@deepseek-ai/dsh-message-feedback` | the server-side `messageFeedback` Remote: per-message ratings and notes |
| `ui-message-feedback` | `@deepseek-ai/dsh-client-ui-message-feedback` | Like/Dislike in the assistant-message action strip, the dialog behind Dislike and `/feedback`, and the acknowledgement toast |
| `command-feedback` | `@deepseek-ai/dsh-command-feedback` | the log-only `sessionFeedback` Remote and the human-facing `/feedback` slash command |

### Why all three, not just the UI

The browser plugin declares `remote.messageFeedback` and
`remote.sessionFeedback` as **required** injects, and
`@deepseek-ai/dsh-message-feedback` is the only package that registers the
first of those namespaces. Disabling the server half on its own would therefore
leave the client plugin unable to load rather than cleanly hiding the buttons,
and disabling the browser half on its own leaves a live `/feedback` command and
two served Remotes with no reader. The three rows are a set.

Disabling an entry does not remove it from the composed tree: the row keeps its
`name` and `config` and gains `disabled: true`, which the loader honors.
Existing messages, the action strip's other buttons and every other Remote are
untouched.

## Install

The bundle is attached only when the feature switch is off, on every profile:

```sh
rdsh features off feedback
PROFILE=web ./plugins/install.sh     # or: rdsh plugins install --profile web
```

Then restart DSH. The switch is a normal `rdsh.json` setting, so
`rdsh settings set features.feedback false` and `rdsh features on feedback`
work too. With the switch on (the default) the bundle is not attached and the
stock DSH surface stays exactly as shipped.

For one profile by hand:

```sh
dsh plugin --profile web add "$(pwd)/plugins/rdsh-no-feedback"
dsh plugin --profile web remove rdsh-no-feedback   # revert
```

## Verification

- `node --test tests/no-feedback.test.mjs` parses this bundle's patch, asserts
  the three ids and the package each row names, and — when a `dsh` CLI and a
  `web` profile are present — composes the real tree with
  `dsh --profile web --patch .../cordis.patch.yml --dump-config` and checks that
  each entry came out `disabled: true`. It also runs `plugins/install.sh`
  against a hermetic `$DSH_HOME` to prove the bundle is attached for
  `features.feedback=false` on web, headless and desktop, and not otherwise.
- `node --test tests/plugin-catalog.test.mjs` keeps the catalog entry, this
  bundle's directory and the installer's conditional in agreement.

## Caveats

- The ids and package names are upstream DSH API. A rename makes the patch rows
  match nothing, which the loader reports as a skipped patch and then boots with
  the feedback surface still on (fail open). The test above composes against the
  installed profile, so a rename shows up there; re-check the three packages
  after a DSH upgrade.
- The patch is applied by the profile's bundle layer, so it needs the package
  attached. Editing a profile's own `cordis.patch.yml` by hand is an
  alternative, but it is not what this bundle does.
- Only the Web profile ships the browser half. On `headless` the same patch
  disables the server Remote and the slash command, which are present there too.
