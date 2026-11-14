# responses-emulator

OpenAI と xAI の Responses API の形（`/v1/responses` と `/v1/responses/compact`）と、
Anthropic の Messages API の形（`/v1/messages`。圧縮は 2 つの形とも）で答える、試し用の代役です。
裏には、OpenAI 互換の Chat Completions の接続先を 1 つ置きます。

`rdsh-llm-native` を、本物のプロバイダなしで最後まで動かすために使います。

```sh
EMULATOR_UPSTREAM_KEY=... node server.mjs --upstream http://127.0.0.1:8000/v1 --model your-model
```

起動すると、待ち受けのアドレスを 1 行で出します。その後は、リクエストごとに経路と件数を 1 行で出します。本文は出しません。

## 確かめられること

- 圧縮の項目は、この代役が出した値と同じ時だけ受け付けます。変えられた値は 400 で断ります。
- 圧縮の項目を受け取ると、対応する要約をモデルに見せます。
- Anthropic の形では、ブロックが先頭に 1 つだけあること、ベータのヘッダーが付いていることも見ます。
- しきい値の形の発動点は、既定で 50,000 トークン以上だけを受け付けます。試す時は `--min-trigger` で下げます。

## 確かめられないこと

- OpenAI、xAI、Anthropic のサービスそのものの動きは分かりません。
- 圧縮の項目は、暗号ではなく、要約を引くための合言葉です。要約はメモリに置き、止めると消えます。
- 圧縮の結果として返すのは、圧縮の項目 1 つだけです。本物が返す並びと同じとは限りません。
