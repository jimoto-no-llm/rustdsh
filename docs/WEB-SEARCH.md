# Web検索 / Web search

`rdsh search-web` は SearXNG または Ollama Web Search API から検索結果を取得します。
検索先は `--provider searxng|ollama` で選択します。既定は `searxng` です。
これはネイティブCLIの検索先の指定です。DSH本体の検索ツールやモデルのルート設定は変更しません。

## Web Search APIサービスの案内

Web検索用APIを探している場合は [Tavily](https://www.tavily.com/) を案内しています。
APIキーの取得と利用手順は [公式Quickstart](https://docs.tavily.com/documentation/quickstart)、
検索の入出力は [Search APIリファレンス](https://docs.tavily.com/documentation/api-reference/endpoint/search) を参照してください。
`rdsh search-web --help` にも同じ案内があります。

rustdshの組み込み検索先はSearXNGとOllamaです。Tavilyはサービスの紹介で、
`--provider tavily` や `TAVILY_API_KEY` による実行にはまだ対応していません。

## 有効にする

Web検索は既定で無効です。両方の検索先に同じスイッチが適用されます。

```sh
rdsh features on search-web
```

`extras.enable` に `search-web` を含める従来の設定も使えます。
`features.search-web=false` の明示指定があると、そちらが優先されます。

## SearXNG（既定）

```sh
rdsh search-web "Rust async" --limit 5
rdsh search-web "Rust async" --provider searxng --json
```

APIキーは不要です。接続先は `SEARXNG_URL`、`search.searxng_url`、
`http://127.0.0.1:8888` の順で決まります。既存のHTTP接続とHTML結果の解析を使います。
SearXNGの検索結果上限は既存の50件で、`--limit` は表示件数を指定します。

### 停止中はオンデマンド起動（`--auto-start`）

SearXNGが停止しているときに `--auto-start` を付けると、同梱の
`docker-compose.searxng.yml` を `docker compose up -d`（無ければ
`docker-compose`、`podman compose`、`podman-compose`）で起動し、最大10秒
待ってから検索します。起動した場合は1行だけ通知します。

```sh
rdsh search-web "Rust async" --auto-start
docker stop rdsh-searxng                              # 停止
```

- 接続先がループバック（`127.0.0.1`、`::1`、`localhost`）のときだけ起動します。
  リモートのSearXNGでは起動せず、そのまま検索します。
- どのランタイムも見つからない場合や、起動しても応答しない場合は、理由を
  1行返して終了します。他の作業を止めたり、別の検索先へ自動で切り替えたり
  しません。
- 初回はイメージ取得のためにDocker Hubへ接続します。以後の通信はローカルの
  コンテナとの間だけで発生します。
- composeプロジェクトと設定ファイルはバイナリに同梱しています。未設定なら
  `~/.cache/rdsh/searxng/` に書き出して起動します（リリース配布物はバイナリのみで、
  インストーラーは追加メンバーを拒否するため、実行ファイルの隣に置く方法は使えません）。
  `RDSH_SEARXNG_COMPOSE_FILE` を設定すると、そのファイルをそのまま使います。
- 同梱プロジェクトの公開ポートと `SEARXNG_BASE_URL` は接続先
  （`SEARXNG_URL`、`search.searxng_url`）に合わせて書き換えます。`localhost` は
  Dockerが要求する 127.0.0.1 にバインドします。
- `rdsh doctor` はSearXNGの到達性、コンテナランタイム、composeファイルの位置を
  表示します。doctor はコンテナを起動しません。

## Ollama Web Search API

[OllamaのAPIキー](https://ollama.com/settings/keys)を取得し、実行環境の
`OLLAMA_API_KEY` に設定してから検索します。キーをコマンド引数に渡す必要はありません。

```sh
rdsh search-web "Rust async" --provider ollama --limit 5
rdsh search-web "Rust async" --provider ollama --json
```

ローカルのOllamaサーバーやモデルは不要です。
接続先は [公式API仕様](https://docs.ollama.com/capabilities/web-search)の
`POST https://ollama.com/api/web_search` です。Bearer認証と
`{"query":"Rust async","max_results":5}` を送信します。
`OLLAMA_HOST` や推論用の `baseURL` とは独立しており、接続先の上書きは受け付けません。

件数は `--limit`、未指定なら `search.web_limit`（既定10）を使い、
Ollama APIの上限に合わせて1〜10に収めます。検索結果はAPIの順序を保ちます。
キーがない場合、空または形式が不正な場合は送信前に失敗します。
HTTPエラー、リダイレクト、不正なJSONや結果形式、15秒のタイムアウト、2 MiB超の応答も失敗として返します。
`results: []` は正常な0件の結果です。エラー本文や認証情報は診断へ出力しません。

Ollama APIの利用条件と制限は利用者のアカウントに従います。
キーの存在だけではOllamaを選択せず、失敗時の別プロバイダーへの自動切り替えも行いません。

## 出力

両方ともテキストはタイトル、URL、最大240文字の本文スニペットを表示します。
`--json` は同じ形式で本文を省略せず返します。

```json
{
  "query": "Rust async",
  "engine": "https://ollama.com/api/web_search",
  "results": [
    {"title": "Example", "url": "https://example.com/", "content": "Snippet"}
  ]
}
```

`engine` は使用した接続先です。SearXNGを選んだ場合は従来どおりSearXNGのベースURLになります。

## 検証

`cargo test websearch --bin rdsh` と `cargo test --test web_search_providers` は
ローカルの模擬HTTPサーバーとダミーキーを使います。外部APIやモデルは呼び出しません。
POST本文・認証・件数・結果順序・エラー・応答サイズ・タイムアウトと、CLIの検索先選択、
機能スイッチ、三言語のキーエラー、キーがあっても既定はSearXNGであることを確認します。
Ollamaアカウントの認証や実サービスの検索品質の確認は含みません。
