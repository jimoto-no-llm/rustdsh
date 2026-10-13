# 同時接続を制限するローカルプロキシ

`scripts/serial-proxy.mjs` は、1つのHTTP(S) upstreamへ送るリクエストをFIFOで制御するNode.jsのリバースプロキシです。追加パッケージやrdshバイナリは不要です。Node.js 22以降で実行できます。

~~~sh
node scripts/serial-proxy.mjs --upstream https://api.example/v1 --port 3000 --max 1
~~~

`--upstream`にはプロバイダのbase URLを指定します。認証情報はコマンドラインやURLへ書かず、dshや他のクライアントで通常どおり設定してください。受信した`Authorization`ヘッダーはupstreamへ転送されます。リクエスト本文・ヘッダー・Authorization値をログへ記録しません。URLにユーザー名、パスワード、query、fragmentを含めることはできません。

## クライアント設定

dshの **Settings → Models → Custom model API** でbase URLを `http://127.0.0.1:3000/v1` にします。OpenAI互換クライアントも同じプロキシのbase URLを指定します。upstreamのbase URLが`/v1`で、クライアントが送信先に`/v1/chat/completions`を含める場合は、そのprefixを重複させずに転送します。クライアントが`/chat/completions`だけを送る場合は、upstreamのprefixを追加します。

同じプロバイダ鍵を使うクライアントは、すべてこの同じプロキシを通してください。プロキシを通らない呼出しや、別プロセスのプロキシは、このFIFO上限の対象外です。1プロセスが扱うupstreamは1つです。

## 制限と応答

- `--max` は同時に処理するupstreamリクエスト数です。既定値は`1`です。
- `--max-queue` は待機リクエスト数の上限で、既定値は`128`です。上限超過は`429 proxy_queue_full`を返します。
- `--wait-timeout-ms` はFIFOで待つ時間の上限で、既定値は`60000`ミリ秒です。時間超過は`503 proxy_queue_timeout`を返します。
- 待機中または応答中のクライアントが切断すると、その待ち行列枠またはupstream枠を解放します。
- Server-Sent Eventsは上流の完了までバッファせず、受信したchunkを順次転送します。
- 上流接続・応答が失敗した場合は、詳細や認証情報を含めない`502`を返します。

`GET /__proxy/status`は、認証情報やリクエスト内容を含まず、`active`・`queued`・設定上限だけを返します。

既定では`127.0.0.1`のみで待ち受けます。`--host 0.0.0.0`など非loopback addressには`--allow-remote`が必須です。このプロキシは認証ゲートウェイではありません。remote listenを有効にすると、到達可能なクライアントがupstreamへリクエストできます。必要な場合は到達元をVPN・firewall側で制限し、インターネットへ公開しないでください。

## 検証

ローカルのmock upstreamだけを使うテストは次で実行します。実プロバイダや資格情報への接続は行いません。

~~~sh
node --test tests/serial_proxy/
~~~

dshのcustom model API経由で実際に1ターン応答する手動確認は、dshとupstreamの設定後に行います。mockテスト合格だけでは、その実機確認を完了したことにはなりません。
