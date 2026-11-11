# rdsh-llm-native

プロバイダ側の圧縮を使う接続先を DSH に加える任意プラグインです。
話せる形は 3 つで、OpenAI の Responses API、xAI の Responses API、Anthropic の Messages API です。

DSH 本体は変更しません。アダプターは DSH の `llm` サービスに登録します。
圧縮結果は、DSH が応答ごとに保存する再送用の記録（`replayState`）に入れます。

## 設定

プロファイルの `cordis.patch.yml` に接続先を書きます。接続先が無い間は何も登録しません。

```yaml
- id: rdsh-llm-native
  config:
    providers:
      my-route:
        baseURL: https://api.example.com/v1
        apiKeyEnv: MY_ROUTE_API_KEY
        models:
          - id: my-model
            contextWindow: 400000
            maxTokens: 8192
            compactAtTokens: 150000
```

| 項目 | 意味 |
| --- | --- |
| `api` | `openai-responses`（既定）、`xai-responses`、`anthropic-messages` のどれか |
| `baseURL` | その API を持つ接続先 |
| `apiKeyEnv` | API キーを入れた環境変数の名前。キーそのものは書きません |
| `compactAtTokens` | 入力がこの大きさに達したら圧縮します。省くと圧縮しません |
| `compactInBackground` | `true` にすると、圧縮を待たずに呼び出しを進め、結果は後の呼び出しで使います |
| `pauseAfterCompaction` | `true` にすると、圧縮した呼び出しはそこで止まります |
| `compaction` | Anthropic だけの設定です。`on_demand`（既定）か `threshold` を書きます |

導入は `rdsh plugins install --profile <名前> --recommended llm-native` です。

`compactAtTokens` を書く接続先は、`rdsh-compaction.json` の `routes` にも書きます。`method` は次の表から選びます。

| `api` と `compaction` | `method` |
| --- | --- |
| `openai-responses` | `openai_standalone` |
| `xai-responses` | `xai_standalone` |
| `anthropic-messages` で `on_demand` | `anthropic_on_demand` |
| `anthropic-messages` で `threshold` | `anthropic_threshold` |

その接続先では DSH の要約による圧縮が止まり、圧縮はこのプラグインだけが行います。
起動の時に rdsh が確かめるのは、プロファイルがその接続先とモデルを `compactAtTokens` つきで持っているかどうかです。
持っていない時は、要約に置き換えずに、起動をエラーで止めます。

## 動き

1. 入力の見積もりが `compactAtTokens` に達すると、今のターンより前の部分を圧縮に出します。
2. 返ってきた圧縮結果の後ろに今のターンをそのまま付けて、モデルを呼びます。
3. 圧縮結果を、その応答の記録に保存します。
4. 次の呼び出しでは、保存した圧縮結果をそのまま先頭に置き、置き換えた部分は送りません。

圧縮結果の中身は読みません。並びも変えません。
圧縮に失敗した時は、圧縮していない入力をそのまま送ります。履歴は捨てません。
保存した圧縮結果が履歴と合わない時は使わず、履歴の全部を送ります。
題名の生成など、会話以外の呼び出しでは圧縮しません。

## Anthropic の 2 つの形

`on_demand` では、しきい値に達した時に、要約だけを返す依頼を 1 回出します。
返ってきた署名つきのブロックを先頭に置き、その後の依頼には毎回ベータのヘッダーを付けます。

`threshold` では、依頼のたびに圧縮の設定を付け、圧縮するかどうかはサーバーが決めます。
この形の `compactAtTokens` は、サーバーへ渡す発動点です。プロバイダが決めた下限より小さい値は、プロバイダが断ります。

## 圧縮の直後に止まる動き

`pauseAfterCompaction: true` の時は、圧縮した呼び出しでモデルに答えさせません。
答えとして返すのは、決まった 1 文だけです。圧縮結果は保存され、今の質問は圧縮結果の後ろに残ります。
次のメッセージを送ると、圧縮結果と、残した質問から続きます。

## 裏での圧縮

`compactInBackground: true` の時は、しきい値に達した呼び出しを、圧縮せずにそのまま送ります。
圧縮は裏で進め、終わった結果を、同じセッションの後の呼び出しで使います。

結果を使うのは、圧縮を始めた時の履歴が、そのまま残っている時だけです。
途中で履歴が変わっていた時は、結果を捨てて、履歴の全部を送ります。古い結果で履歴を置き換えることはありません。

裏の作業はメモリの上にあります。プロセスが終わると消え、次の呼び出しで圧縮し直します。
1 回の依頼ごとにプロセスが終わる headless では、この設定は意味を持ちません。
web では、4 通目で裏の圧縮が始まり、5 通目でその結果が使われることを、代役を相手に確かめました（2026-11-11）。

## データの扱い

圧縮結果は、DSH のセッションの記録に、応答と一緒に保存されます。中身はプロバイダが決めた読めない値です。
置き換えられた元のメッセージも、DSH の記録には残ります。このプラグインは記録を消しません。
このプラグインが出す警告には、本文、圧縮結果、API キーを入れません。
`rdsh compaction report` は、圧縮結果をハッシュと件数だけで出します。

## まだ無いもの

- OpenAI のリクエストの中で圧縮する形（`openai_in_stream`）はありません。
- ZDR の判定は、このプラグインの中にはありません。rdsh が起動の時に行います（`docs/ZDR.md`）。

- 本物の OpenAI、xAI、Anthropic の API では試していません。確かめたのは `tools/responses-emulator` を相手にした動きです。
  要約のプラグインと方式 `openai_standalone` を合わせた形でも、同じ相手で 9 通の会話を通しました（2026-11-11）。
- ストリーミングはしません。応答は 1 回で受け取ります。
- 画像とファイルは送れません。その時はエラーで止まります。
- モデルの推論の中身は、次の呼び出しに戻しません。
- 圧縮を始める大きさは、このプラグインの `compactAtTokens` に書きます。`rdsh-compaction.json` の `policies` からは渡りません。

## テスト

```sh
npm test
RDSH_DSH_RUNTIME=/path/to/runtime npm test
```

2 つ目は、本物の DSH にプラグインを載せ、別々のプロセスで 3 回続けて、圧縮結果が保存されて戻ることを確かめます。モデルは呼びません。
