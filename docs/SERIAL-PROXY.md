# Serial proxy (同時リクエスト数制限プロキシ)

**English summary:** `rdsh serial-proxy` is a native Rust reverse proxy that caps
concurrent upstream requests (default 1) with a FIFO queue. Point every client
(dsh, rdsh, opencode) at it when a provider such as
HAI allows only one concurrent request per API key. Loopback only by default;
only clients routed through the same proxy process are serialized.
Optional extras: `--tool-choice-default` adds a default `tool_choice` to
`chat/completions` requests that carry `tools` but no `tool_choice` (for
Sarashina, which otherwise treats it as `required`), and `--rpm` caps upstream
requests per fixed 60-second window. Neither guarantees answer quality or
correct tool calls; there is no automatic retry on 429.

## 目的

一部の OpenAI 互換プロバイダ（例: HAI）は API キーあたり同時 1 リクエストしか
許可しません。dsh はチャットとセッションタイトル生成、サブエージェントなどで
並列にリクエストを送り、opencode など他のツールが同じキーを共有することもあります。
dsh / rdsh にはプロバイダ単位の同時実行数上限がないため、全クライアントの
baseURL をこのローカルプロキシに向けて直列化します。

## 使い方

```sh
rdsh serial-proxy --upstream https://hai-api.hcloud.ltd/v1
```

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `--upstream <url>` | (必須) | 転送先 (http/https)。パス部分はベースパスになる |
| `--port <n>` | `18080` | 待受ポート。`0` でランダム。実際の URL を stderr に出力 |
| `--host <addr>` | `127.0.0.1` | 待受アドレス。ループバック以外は `--allow-remote` が必要 |
| `--allow-remote` | off | ループバック以外の `--host` を許可 (認証なしで公開される点に注意) |
| `--max <n>` | `1` | 上流への同時リクエスト数 |
| `--queue-timeout <sec>` | `600` | 待機がこの秒数を超えると 503 (JSON) |
| `--max-queue <n>` | `64` | 待機キュー上限。超過は 429 (JSON) |
| `--tool-choice-default <none\|auto\|required>` | (無効) | `tools` が空でない配列で `tool_choice` が無い `POST …/chat/completions` に、この値を補う (後述) |
| `--max-body-bytes <n>` | `8388608` | `--tool-choice-default` が本文を読み取る上限 (8 MiB)。超えた本文は無変更で転送 |
| `--rpm <n>` | (無効) | 固定 60 秒窓あたりの上流への送信件数の上限 (後述) |

### パスの対応規則

上流 URL のパスを `B` (例: `/v1`)、プロキシが受けたパスを `P` とすると、上流へは
`B + P'` を送ります。`P` が `B` と一致するか `B/` で始まる場合は先頭の `B` を 1 回だけ
取り除いたものを `P'` とし、それ以外は `P' = P` です。そのため baseURL は
`http://127.0.0.1:18080` でも `http://127.0.0.1:18080/v1` でも使えます
(`/chat/completions` も `/v1/chat/completions` も上流の `/v1/chat/completions` になります)。
クエリ文字列はそのまま転送されます。

### 挙動

- メソッド・クエリ・ヘッダ・リクエストボディをストリームで転送し、レスポンス (SSE を含む) も
  チャンクごとに流します。`Authorization` は変更せず、ヘッダ値・ボディはログに出しません。
- スロットは上流リクエスト開始からレスポンス本文の終了・エラー・クライアント切断まで保持され、
  切断時は上流リクエストも中止します。待機中に切断したリクエストはキューから外れます。
- リクエスト本文の受信期限はキュー待ち上限と本文受信猶予5分を合計した値です。ヘッダーは別に60秒でタイムアウトします。
  待機中の本文をアプリケーション側へ無制限に蓄積せず、枠が空いた後も大きな本文をストリームで受信できます。
- 上流レスポンスの読み取りは下流の backpressure に従い、遅いクライアント向けに本文を無制限にバッファしません。
- `GET /__proxy/status` は転送せず `{active, queued, max, upstream}` を返します。
  `--rpm` 指定時は `rpm`、`window_count` (現在の窓での送信件数)、`next_slot_in`
  (次に送れるまでの秒数。送れる状態なら `0`) も含みます。
- 1 リクエスト 1 行で stderr に `method path status wait dur id` を出力します。
- SIGINT / SIGTERM で終了します。

## `tool_choice` の既定値 (`--tool-choice-default`)

指定したときだけ有効です。対象は `POST` で、上流へ送るパスが `/chat/completions` で終わり、
`content-type` が JSON (`application/json`、`+json`、charset は UTF-8 のみ) で、
`content-encoding` が無いリクエストです。条件を満たすと、本文を `--max-body-bytes` まで
読み取って解析し、`tools` が空でない配列で `tool_choice` がキーとして存在しないときだけ
指定値を補い、`content-length` を付け直して `transfer-encoding` を外します。
`tool_choice` が既にある (`null` を含む)、`tools` が無い・空、その他のパスやメソッド、
JSON として読めない本文、上限を超える本文は、バイト単位で無変更のまま転送します
(上限超えは、読み取り済みの分と残りをそのまま流し、上限を超えて溜め込みません)。
指定が無いときは本文を一切バッファしません。

- 本文の読み取りは、`--max` の枠を得た後に行います。待機中の本文を読まない既存の挙動
  (キューにバッファが溜まらない) を保つためです。読み取り中の切断はスロットを解放します。
- ログに出すのは `tool_choice defaulted id=<n>` だけです。本文と `Authorization` は出しません。
- 書き換えは `tool_choice` の既定値の追加だけです。他のフィールドは変更せず、
  補った後の応答の質やツール呼び出しの正しさは保証しません。

## 送信回数の制限 (`--rpm`)

`--rpm <n>` を指定すると、上流への送信を固定 60 秒窓あたり `n` 件までに制限します。
窓は最初の送信で開き、60 秒後に閉じてカウントが 0 に戻ります。窓が満杯のとき、
次のリクエストは `--max` の枠を保持したまま FIFO で待ちます。待機は `--queue-timeout` の
対象で (超過は 503 JSON、この待機には `--queue-timeout` を改めて適用)、
待機中にクライアントが切断すると枠を解放して取り除かれます。
カウントは実際の上流送信時点で行い、制限はプロキシ単位です。429 の自動リトライはしません。

## Sarashina での使い方

Sarashina は `tools` があって `tool_choice` が無いと `required` として扱い、毎ターンでツール
呼び出しを強制します。また固定窓のレート制限があり (mini は 6 RPM、nano は 60 RPM)、
429 に `Retry-After` は付きません。制限はモデルごとなので、モデルごとに別のプロキシを
別ポートで立ててください。

```sh
# mini (6 RPM)
rdsh serial-proxy --upstream https://api.sarashina.ai/v1 --tool-choice-default auto --rpm 6 --port 18081
# nano (60 RPM) は別ポートで --rpm 60
```

rdsh 側は `rdsh provider add sarashina --base-url http://127.0.0.1:18081/v1` で
プロキシに向けます。Sarashina のプリセットと注意点は `docs/PROVIDERS.md` の
Sarashina 節（すでに main にあります）を参照してください。
dsh は 1 ターンで本体とタイトル生成の 2 件以上を送るため、`--rpm` を超える分は待機になります。

## dsh の設定

Settings → Models → Custom model API:

- Base URL: `http://127.0.0.1:18080/v1`
- API key: 空欄なら環境変数による認証を使用。入力する場合はそのキーが上流へそのまま渡されます。

## opencode の設定例

```json
{
  "provider": {
    "hai": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:18080/v1" }
    }
  }
}
```

## 制限

- 直列化されるのは同じプロキシプロセスを経由するクライアントだけです。プロキシを
  介さないアクセスや別マシンからのアクセスは制御できません。
- 既定ではループバック専用です。認証機能はないため `--allow-remote` は信頼できる
  ネットワークでのみ使ってください。
- 長いストリーミング応答はその間スロットを占有します。

## 動作確認

```sh
cargo test --test serial_proxy
curl -s http://127.0.0.1:18080/__proxy/status
```
