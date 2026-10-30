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

Web検索は既定で有効です（search-web 機能、既定ON）。無効化は明示的に行います。

```sh
rdsh features off search-web
```

既定の検索先 SearXNG に届かないときは、ローカルの rustxng サイドカーを
自動で導入して使います（`rdsh rustxng install` で先に導入しておくこともできます）。
導入を止めたいときは `RUSTXNG_SKIP_INSTALL=1` を付けます。

### サイドカーの自動更新

rdsh が導入した `~/.local/bin/rustxng` だけが更新の対象です。`RUSTXNG_BIN` で指した
バイナリ、`RUSTXNG_URL` の外部インスタンス、PATH 上の別の場所にある rustxng は
利用者の管理物として一切触りません。

- `rdsh search-web` と `rdsh rustxng start` は、最後の確認から 24 時間以上たっていれば
  バックグラウンドで最新リリースを確認します（`RUSTXNG_UPDATE_INTERVAL_HOURS` で間隔を
  変更、`0` で毎回）。確認と更新は切り離したプロセスで行うので、検索は待たされません。
  更新が終わっていなければ今回は古い版で動き、次回から新しい版になります。
  ネットワークに失敗しても何も表示せず、失敗が続くと間隔を 1 時間から倍々に（上限 24 時間）
  伸ばします。状態は `$DSH_HOME/rustxng-update.json` に記録します。
- 取得先は RustXNG のリリース（https、リダイレクトも GitHub 系のみ）だけです。
  ダウンロードしたバイナリの sha256 を API の `digest` と `.sha256` に照合し
  （食い違い・両方取得不可なら拒否）、同じディレクトリの一時ファイルで `--version`
  が動くのを確かめてから atomic に置き換えます。置換後の起動確認に失敗すれば
  直前の版（`rustxng.prev`、Windows は `rustxng.prev.exe`）へ戻します。
- rdsh が起動して記録しているサイドカーだけは、更新後の次の利用時に再起動して新しい版に
  します。利用者が自分で起動したプロセスは止めません。
- `rdsh rustxng update` で手動更新、`rdsh rustxng update --check` で取得も置換もせずに
  「導入済み / 最新 / 更新あり」だけ確認できます（`--json` 対応）。
  `rdsh rustxng status` は導入版・確認済みの最新版・最終確認・自動更新の有効/無効を、
  `rdsh doctor` は古い場合の警告を（ネットワークなしで）示します。
- 自動更新だけを止めるには `RUSTXNG_SKIP_UPDATE=1`。`RUSTXNG_SKIP_INSTALL=1` のときも
  更新は止まります。

サイドカーは依存の無い単一バイナリで、Docker 版 SearXNG のような
常設スタック（Python・Redis・コンテナ）を要求しません。目安:
バイナリ約 14MB（初回ダウンロードのみ）、常駐メモリー約 10MB、
アイドル時 CPU 0%、起動から応答まで 0.3 秒程度です。

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

## 接続先の信頼境界（既定はループバック）

`rdsh search-web` の接続先は、既定ではループバック（`127.0.0.1`、`::1`、
`localhost`）のインスタンスだけを許可します。`.envrc` やCI環境など設定を
書ける経路を通った不当な指定が、内部サービスへのポート探測（SSRF）に
使われないための既定値です。

- ループバック以外のインスタンスへ接続するときは `SEARXNG_ALLOW_REMOTE=1`
  を明示します。LAN内の自前インスタンスや、`https://` の外部ゲートウェイ
  が対象です。
- リンクローカル帯（IPv4 `169.254.0.0/16`、IPv6 `fe80::/10`）と
  キャリア級NAT帯（`100.64.0.0/10`）は、明示的な許可があっても常に拒否
  します。メタデータや自動発見の宛先を探らせないためです。
- `https://` のURLもそのまま使えます（rustlsで接続）。平文 `http://` は
  ループバックか、`SEARXNG_ALLOW_REMOTE=1` の明示があるときだけ使えます。
- ログ・`--json` の `engine`・エラー文言には、接続先のパス（トークン付き
  プレフィックス）を出しません。`scheme://host:port/…` にマスクします。
- 検索結果のタイトル等に現れた制御文字（`&#27;` を含む）は端末へ届く前に
  除去します。表示の書き換えを防ぐためです。

## DSH本体の検索先を固定する（任意）

`rdsh search-web` はDSH本体の検索ツールを変更しません。エージェントの
`web_search` をローカルのSearXNGへ向けたい場合は、DSH側でプロバイダ
プラグインを導入したうえで、そのプラグインが登録するIDを設定します。

```sh
dsh plugin --profile web add dsh-web-search-searxng
rdsh settings set search.dsh_search_provider searxng
```

上の例の `dsh-web-search-searxng` は `searxng` というIDを登録します。
パッケージ名とIDは異なることがあるため、使うプラグインのREADMEで確認してください。

設定すると、rdshは委譲するDSHの子プロセスへ `DSH_WEB_SEARCH_PROVIDER` を渡します
（`--passthrough` でも渡します）。

- 既定は空で、何も渡しません。
- シェルで `DSH_WEB_SEARCH_PROVIDER` を明示している場合はそちらが優先され、
  rdshは上書きしません。
- プロバイダIDとして扱えない値（空白や制御文字を含むもの）は渡しません。
- **登録済みのIDを指定してください。** 未登録のIDではupstreamが
  `WEB_PROVIDER_CONFIGURED_MISSING` で検索を失敗させます。
- 対象は委譲したDSHだけで、`rdsh search-web` 自身の検索先は
  `SEARXNG_URL` と `--provider` のままです。

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
