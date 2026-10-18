# OpenCode models in rdsh Web and TUI

This recovered helper targets legacy Node-based DSH 0.2.0-rc.2. Compatibility
with newer DSH versions and coordination with concurrent credential/profile
writers still require review. Do not run it against an active installation
while another process may update those files.

The sync command shares an existing authenticated **OpenCode Go** route between
profiles and imports the **OpenCode Zen** catalog when a Zen API key exists.
Web and TUI then use the normal DSH model selector and agent loop;
this does not run an OpenCode agent or import conversation history.

Requires Node.js, OpenCode, and a Node-based dsh installation with
`@deepseek-ai/dsh-llm-pi-ai` (validated with DSH 0.2.0-rc.2). The original dsh
launcher must be available as `dsh-orig`, or set `DSH_ORIG_BIN` to its path.
Set `RDSH_OPENCODE_BIN` if OpenCode is installed under another executable name.
The profiles must already exist; see [TUI setup](TUI-SETUP.md).

From this repository:

```sh
node scripts/sync-opencode-models.mjs web tui
rdsh tui
```

In the TUI, run `/model` and choose **OpenCode Go** or **OpenCode Zen** and a model.
In the Web UI, use the model selector and choose the same provider. Zen models
using the Responses or Anthropic protocol appear as separate provider entries, so a
model is never routed through the wrong protocol. Restart the Web service if
the new catalog is not hot-reloaded; when running from inside that service,
use the [independent restart helper](WEB-AUTO-RESTART.md#restarting-from-inside-the-web-gui).

Run the sync command again after OpenCode model or credential changes. For Zen,
it reads `opencode models opencode --verbose` and the effective OpenCode configuration,
then replaces only its managed block in each requested profile patch. Existing
provider routes are preserved. The latest generated block holds a snapshot of
the existing pi-ai configuration; resync after changing that configuration.
An existing Go route with a stored or exported credential reference is copied
to the other requested profiles; its model catalog comes from DSH's installed
pi-ai adapter. Custom OpenCode providers and provider-specific OAuth sessions
are not imported. Existing DSH routes remain intact.

For Zen, an API key is resolved from OpenCode's effective `provider.opencode.options.apiKey`,
`OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`, or its API-key auth record. It is
stored under a dedicated reference in `$DSH_HOME/.credentials.yaml` with mode
0600; the model configuration contains the reference name, never the key.
OpenCode's source credentials are unchanged. The anonymous free route is not
imported: it rejects use outside OpenCode with HTTP 403. Without a Zen API key,
the sync shares Go if an authenticated Go route already exists; otherwise it
fails before changing files. A key's presence does not itself verify account
entitlements; a real model response must be tested separately.
An existing dedicated DSH key is retained when OpenCode supplies no replacement.

Before saving, all requested profile patches are validated. Private backups
of modified files are created under `$DSH_HOME/backups/opencode-models-*`.
Remove the `BEGIN/END RDSH OPENCODE MODELS` block from a profile to remove its
imported routes; the original profile patch remains above it. The dedicated
credential reference can be removed separately when no profile uses it.

Endpoint protocols: [OpenCode Zen documentation](https://opencode.ai/docs/en/zen/).

## 日本語

同期後、TUIの `/model` またはWeb画面のモデル選択で **OpenCode Go** または
**OpenCode Zen** を選びます。Zenの匿名無料枠はOpenCode本体専用です。
モデルの追加・削除や認証変更後は、上記の同期コマンドを再実行してください。
OpenCodeの会話データは読み取りません。既存のモデル選択や初期モデルは変更せず、
利用するモデルは画面で選びます。
