# プライバシーと外部通信の既定

rdsh の既定値は [機能スイッチ](RDSH-SETTINGS.md#機能スイッチonoff)と
[`src/rdsh_config.rs`](../src/rdsh_config.rs)に対応します。セッション telemetry と
Discord は既定OFFです。Web検索や更新関連の機能には既定ONのものもあり、
すべてのバックグラウンド通信を止める設定ではありません。

対象は rdsh 本体と rdsh が起動する子プロセスです。委譲先の設定や、利用者が追加した
プラグイン・MCP サーバーが独自に行う通信は、それぞれの実装に従います。

## 通信経路と既定値

| 経路 | 既定 | 動作する条件・設定 |
| --- | --- | --- |
| 委譲先 DSH のセッション telemetry（OpenTelemetry） | off | 子プロセスへ `DSH_TELEMETRY_DISABLED=1` を渡す |
| Discord Rich Presence | off | `features.discord`。既存の明示的な有効設定は保持する |
| 更新バナー・通知 | on | `update_check`・`update_notifications`。同梱プラグインが保存された更新状態を表示・通知する。画面からの更新操作も提供する |
| 日次の自動更新 | 未設定 | `rdsh update auto on` でスケジューラを明示的に導入したときに実行する |
| release qualification probe | off | `features.release_probe`。固定更新の適格性確認用で、通常の更新バナーとは別の機能 |
| Web検索（`rdsh search-web`） | on | 利用者が検索コマンドを実行したときに問い合わせる。必要に応じた rustxng の導入を含む |
| 委譲先のローカル検索ブリッジ | on | `web_search_bridge`。導入済みプラグインと利用可能なローカル検索先があるときに `DSH_WEB_SEARCH_PROVIDER=rdsh-rustxng` を渡す。利用者の明示値が優先 |
| 同梱プラグインの自動更新 | 条件付きで有効 | release 版プラグインを使う対象プロファイルの利用時に、既定24時間間隔で確認する。`RDSH_PLUGINS_SKIP_UPDATE=1` で停止 |
| 管理下 rustxng の自動更新 | 条件付きで有効 | `rdsh search-web` / `rdsh rustxng start` の利用時に、既定24時間間隔で確認する。`RUSTXNG_SKIP_UPDATE=1` で停止 |

導入・更新では GitHub Releases 等への問い合わせと配布物の取得が発生します。
`update_check` をOFFにしても、日次スケジューラやプラグイン・rustxng の更新設定は別に残ります。
各経路は [Web検索](WEB-SEARCH.md)、[同梱プラグインの更新実装](../src/plugins_release.rs)、
[日次自動更新](AUTO-UPDATE.md)の手順で確認してください。

`DSH_TELEMETRY_DISABLED` は upstream DSH の opt-out で、**空でない値なら
`0` や `false` でも無効**として扱われます（upstream の `session-telemetry-otel`
行を `disabled: true` にする）。rustdsh は委譲するすべての起動経路（`rdsh boot`、
`rdsh` 互換起動、`rdsh plugin`、dump-config など）にこの変数を既定で設定します。

## 有効化・無効化の方法

### セッション telemetry

```sh
rdsh features on telemetry     # features.telemetry=true を rdsh.json に保存
rdsh features off telemetry    # 既定に戻す
```

設定を書かずに 1 回だけ試す場合は `RDSH_TELEMETRY=on` を付けます。どちらも
「rustdsh が opt-out 変数を設定しない」という意味です。環境にすでに
`DSH_TELEMETRY_DISABLED` がある場合は upstream 側で無効のままなので、有効化する
ときは合わせて unset してください（空でない値はすべて無効扱いです）。

### Discord Rich Presence

```sh
rdsh features on discord                 # 新しいスイッチ
rdsh settings set discord.enabled true   # 旧キーも引き続き有効
```

後方互換のため、既存の `rdsh.json` に `discord.enabled: true` または
`features.discord: true` が明示されていれば、それらは尊重されて有効のままです。
両方ある場合は `features.discord` が優先されます。

## モデル・検索・ローカル画面の通信

- 設定済み LLM プロバイダへの推論・モデル一覧取得などの API リクエスト
- 利用者が明示的に実行した Web 検索・Web ページ取得（SearXNG、`--provider ollama` で選んだ Ollama Web Search API、DSH の検索ツールなど）
- 上記に必要な認証・トークン更新
- `rdsh serve` / `rdsh setup --web` は `127.0.0.1` のローカル待受だけを使います

`rdsh search-web` の既定は SearXNG です。`OLLAMA_API_KEY` が設定されているだけでは
Ollama へ送りません。`--provider ollama` の指定時は検索語と件数を
`https://ollama.com/api/web_search` へ、API キーを Bearer 認証ヘッダーとして送信します。
リダイレクトは追跡せず、失敗時に別の検索先へ切り替えません。[Web検索](WEB-SEARCH.md)を参照してください。

## 制約と保証できない範囲

- rdsh 全体の通信を一括遮断する仕組みではありません。任意の保護付きツール
  サンドボックスは対象ツールだけを制限します。各機能のOFFは、その機能が行う
  処理を止める設定です。
- 委譲先 DSH、利用者が導入したプラグイン、登録した MCP サーバーは、それぞれ
  自身の設定に従って外部通信できます。
- 委譲先 DSH が既定で持つ送信経路（例: profile の `session-log-deepseek` による
  `dsh_session_log`）は upstream の設定に従います。rustdsh は profile を改変
  しないため、無効化する場合は profile 側の設定（`enabled: false`）を使って
  ください。
- デスクトップアプリ (Electron) は upstream ランタイムが起動し、その通信は
  rustdsh の管理外です。上記の既定は CLI・Web・TUI・ヘッドレスでの委譲起動に
  適用されます。
- 実行環境の制約で通信を遮断できない場合でも、既定 off は「rustdsh がその
  通信を起こさない」ことだけを意味します。OS 全体の通信制御は対象外で、
  委譲先 DSH が実際に何を送るかは upstream の実装に依存します。rustdsh の
  テストは、委譲する子プロセスの env に opt-out が入ることを検証します。

## 確認方法

```sh
rdsh features --json            # discord / telemetry の enabled と default を確認
rdsh --dry-run boot --profile web   # 委譲コマンドの env に DSH_TELEMETRY_DISABLED=1 が出る
```

関連: [docs/RDSH-SETTINGS.md](RDSH-SETTINGS.md)、
[README の Safety Design](../README.ja.md#安全設計)（英語は
[README](../README.md#safety-design)）。
