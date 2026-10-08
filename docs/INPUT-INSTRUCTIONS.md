# 同じsessionへの追指示

Issue [#19](https://github.com/sahenjp/rustdsh/issues/19) の追指示投稿・適用タイミング・
同時入力の確認を実装します。[既存の入力順](INPUT-QUEUE-ORDERING.md) と
[回答適用](ANSWER-APPLICATION.md) の契約を使い、元のACPクライアントの
`send` / `interrupt` に配送します。

## 対象と入力処理の確認

`reply-consumer serve` で元のrun/sessionへ明示接続し、表示されたconsumer IDを使います。
ブラウザーの「同じsessionへ追指示を送る」でtask・run・sessionを確認します。
保存は新しいsessionを作らず、切断時にも別sessionへ振り替えません。

保存、対象consumerの読取、送信開始、元のCLIの応答を分けて表示します。
送信開始は永続claimの取得です。結果確認には同じnative commandのACP応答が必要です。
入力処理の完了は、タスクの完了・受入検証・新しい実行権限を意味しません。

## 適用タイミング

| 希望             | 実際の扱い                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------- |
| 次ターンへ追加   | 同じ対象の先行入力の結果確認を待つ                                                       |
| 現ターンへsteer  | 現在のDSH adapterには検証済みsteerがないため、次ターン待ちと明示する                     |
| 明示中断して変更 | 人間が確認した現在の入力だけにcancelを送り、対応する取消し応答を確認してから追指示を送る |

中断の確認は現在のinput command IDに固定します。処理対象が変わればチェックを外します。
native cancelのclaimも一度だけ取得できます。cancelはACP通知なので、送信だけでは
「中断成功」としません。元のpromptのcorrelated cancelled resultと同じowner/runの
cancel記録が必要です。claim前に対象が終わった場合は、native結果を確認して中断不要とします。
結果不明は後続入力を保留し、timeoutで成功や失敗を推測しません。

管理エージェントの中断要求は保存して人間の確認待ちにします。
MCP資格情報では、人間の確認やconsumerの読取・結果ackを発行できません。

## ID、入力順、下書きと競合

ID `input_<UUID>` と投稿内容を保存します。同じID・同じ内容の再送は同じ記録を返し、
JSONのフィールド順は一致判定に影響しません。同じIDで別内容を送れば409です。
ネイティブ送信のclaim取得後は、応答が消失しても再度送信を許可しません。

回答と追指示に共通の単調増加する配送順を付け、同じconsumerに順番に適用します。
従来のMCP feedback sequenceは変更しません。feedbackのみの回答がcursorを進めても、
その後の追指示が取り残されないことを検証しています。

ブラウザーはproject・consumerごとに下書き、ID、書き始めた時点のqueue revisionを
`sessionStorage` に保持します。同じタブの開き直し・対象切り替えで復元し、SSEは本文を
書き換えません。保存応答が不明なら内容を固定して同じIDで確認します。
確認済みの保存応答を受け取ってから下書きを消し、保存領域が使えなければ通知します。

先行入力が追加されqueue revisionが変わった場合、新しい投稿を削除せず確認待ちにします。
先行指示と新しい本文を並べ、人間が「次ターンへ追加」「確認した入力を中断」「取り下げ」
を選びます。比較中にqueueが変われば409となり、再確認が必要です。
本文の意味を自動判定して矛盾を解消する機能ではありません。
概要にも確認待ちの件数を表示し、対応するconsumerへ移動できます。

## 管理エージェントとローカルCLI

既存6つのMCP toolは変更せず、明示的なHTTP/CLI投稿を追加します。

```sh
rdsh-dashboard instruction context --project /path/to/project --consumer-id consumer_id
rdsh-dashboard instruction submit --project /path/to/project --input-file input.json
rdsh-dashboard instruction resolve --project /path/to/project --input-file review.json
rdsh-dashboard reply-consumer inspect --project /path/to/project --command-id input_uuid
```

`context` / `submit` はprojectのMCP資格情報を使い、管理エージェントとして記録します。
`resolve` はローカル管理者の資格情報で人間の確認を明示実行するコマンドです。
これらはproviderを呼ばず、native CLIや新しいsessionを起動しません。
入力JSONはUTF-8の通常ファイルを使い、リトライ時は同じIDと内容を保持します。

`input.json` のconsumer・run・session・revisionは最新のcontextに置き換えます。

```json
{
  "command_id": "input_00000000-0000-4000-8000-000000000019",
  "consumer_id": "<consumer ID>",
  "run_id": "<run ID>",
  "session_id": "<native session ID>",
  "text": "APIの互換性を保ち、先にテストを追加する",
  "mode": "next_turn",
  "expected_queue_revision": 0
}
```

`mode: "interrupt"` の場合は確認する現在の `active_command_id` も必須です。
`review.json` は同じ `command_id`、最新の `expected_queue_revision`、
`decision: "append_next_turn" | "approve_interrupt" | "reject"` を指定します。

HTTPではGET `/api/instructions/context?consumer_id=...`、POST `/api/instructions/submit`、
人間・管理者専用のPOST `/api/instructions/resolve` を使います。
actorは認証から設定し、投稿JSONのactorは拒否します。Host/Originとproject認証を維持します。
consumer専用の中断claimは `/api/replies/control` で扱い、資格情報はlive serverのメモリのみです。

## 検証と限界

実画面の新旧PNG、競合・下書き復元・明示中断・steer待ち・結果不明のPNG、操作GIF、
CLIの新旧出力は [検証記録](evidence/instruction-queue/README.md) にあります。
390×844のブラウザー表示領域からも同じ対象への追指示保存を検証しました。
実機スマホ、実providerによるモデル応答、Tailscale越しの通信は実施していません。
native処理は所有したACP fixtureで確認し、providerの能力や成果品質とは分けます。
stateとnative journalの2ファイルに跨る、停電時の一括transactionは保証しません。

永続state schemaは1のまま任意の `instructions` 拡張を追加し、既存回答の必要なものに
任意の `queue_sequence` が付きます。破損したID・fingerprint・phase・配送順・owner・
中断対象は読み込み時にも拒否し、元のstateファイルを上書きしません。
