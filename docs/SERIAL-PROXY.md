# Serial proxy (同時リクエスト数制限プロキシ)

**English summary:** `scripts/serial-proxy.mjs` is a zero-dependency Node.js (>=22)
reverse proxy that caps concurrent upstream requests (default 1) with a FIFO
queue. Point every client (dsh, rdsh, opencode) at it when a provider such as
HAI allows only one concurrent request per API key. Loopback only by default;
only clients routed through the same proxy process are serialized.

## 目的

一部の OpenAI 互換プロバイダ（例: HAI）は API キーあたり同時 1 リクエストしか
許可しません。dsh はチャットとセッションタイトル生成、サブエージェントなどで
並列にリクエストを送り、opencode など他のツールが同じキーを共有することもあります。
dsh / rdsh にはプロバイダ単位の同時実行数上限がないため、全クライアントの
baseURL をこのローカルプロキシに向けて直列化します。

## 使い方

```sh
node scripts/serial-proxy.mjs --upstream https://hai-api.hcloud.ltd/v1
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
- Node の request-body 受信期限は既定のヘッダー期限60秒、キュー待ち上限、本文受信猶予5分を合計した値です。
  待機中の本文をアプリケーション側へ無制限に蓄積せず、枠が空いた後も大きな本文をストリームで受信できます。
- 上流レスポンスの読み取りは下流の backpressure に従い、遅いクライアント向けに本文を無制限にバッファしません。
- `GET /__proxy/status` は転送せず `{active, queued, max, upstream}` を返します。
- 1 リクエスト 1 行で stderr に `method path status wait dur` を出力します。
- SIGINT / SIGTERM で終了します。

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
node --test "tests/serial_proxy/*.test.mjs"
curl -s http://127.0.0.1:18080/__proxy/status
```
