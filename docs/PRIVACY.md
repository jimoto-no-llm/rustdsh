# プライバシーと外部通信の既定

rustdsh は、委譲先の DeepSeek Harness (DSH) を起動するランチャーです。既定では
**モデル推論のための LLM API リクエスト**、**利用者が明示的に実行した Web 検索・
Web ページ取得**、およびその動作に必要な認証・トークン更新だけを外部通信として
許可し、それ以外のテレメトリやバックグラウンド通信は既定で止めます。

対象は rustdsh 本体と、rustdsh が起動する子プロセスです。DSH 本体のコードや既定
設定は変更しません。

## 既定で止めているもの

| 経路 | 既定 | rustdsh 側の仕組み |
| --- | --- | --- |
| 委譲先 DSH のセッション telemetry（OpenTelemetry） | 無効 | 子プロセスへ `DSH_TELEMETRY_DISABLED=1` を渡す |
| Discord Rich Presence | 無効 | `features.discord`（旧 `discord.enabled`）の既定を off |
| 更新確認・リリース探索 | 無効 | `features.release_probe` は既定 off。日次更新は `rdsh update auto on` を明示したときだけ |
| Web 検索（`rdsh search-web`） | 無効 | `features.search-web`（`search-web` extra）は既定 off |
| DSH 本体の Web 検索プロバイダ | 変更しない | `search.dsh_search_provider` を設定したときだけ子プロセスへ `DSH_WEB_SEARCH_PROVIDER` を渡す（シェルの明示値が優先） |

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

## 既定で許可する通信

- 設定済み LLM プロバイダへの推論・モデル一覧取得などの API リクエスト
- 利用者が明示的に実行した Web 検索・Web ページ取得（`rdsh search-web` を
  有効化した場合の SearXNG、`--provider ollama` で選んだ Ollama Web Search API、DSH の検索ツールなど）
- 上記に必要な認証・トークン更新
- `rdsh serve` / `rdsh setup --web` は `127.0.0.1` のローカル待受だけを使います

`rdsh search-web` の既定は SearXNG です。`OLLAMA_API_KEY` が設定されているだけでは
Ollama へ送りません。`--provider ollama` の指定時は検索語と件数を
`https://ollama.com/api/web_search` へ、API キーを Bearer 認証ヘッダーとして送信します。
リダイレクトは追跡せず、失敗時に別の検索先へ切り替えません。[Web検索](WEB-SEARCH.md)を参照してください。

## 制約と保証できない範囲

- rustdsh はネットワークを遮断しません。ファイアウォールやサンドボックスの
  強制は行わず、既定 off は「rustdsh がその通信を起こさない・有効化しない」
  という意味です。
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
