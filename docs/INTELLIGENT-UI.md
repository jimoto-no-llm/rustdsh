# インテリジェントUI（rdsh-ui/1・双方向プロトコル）

エージェントが会話の途中で構造化UIを提示し、人間の選択・入力が**同じセッションへ戻る**ための
プロトコルです。見本の展示にとどまらず、提示・更新・操作・返送・認可の分離までを実装しています。

> 名前の似た第三者プラグイン [dsh-intelligent-ui](https://github.com/cwd514/dsh-intelligent-ui)（cwd514、MIT、Copyright (c) 2026 cwd514）は**別物**です。本書の `rdsh-ui/1` は rustdsh 自身の実装（dashboard の `dashboard_present_ui` と `plugins/rdsh-agent-ui`）で、上流は DSH ホストに宣言的な `render_ui` ツールと React 描画を足す独立した Web プラグインです（推奨一覧のオプトインとして `plugins/recommended.md` に登録）。
> どちらもターン末尾スロット（`conversation.chat.turnTail`）へ描くため、併用する場合は表示順を確認してください。

## 5つの機構

| 必要な仕組み | 実装 |
| --- | --- |
| UI生成ツール | MCP tool `dashboard_present_ui`（`dashboard/mcp.mjs`） |
| 構造化データ | `rdsh-ui/1` のブロック検証器（`dashboard/ui/registry.mjs`） |
| 双方向通信 | ブラウザ `POST /api/ui/actions` → `feedback` へ記録 → `dashboard_get_feedback` で読み取り |
| 状態管理 | `state.ui_surfaces`（`surface_id`＋単調増加 `revision`、state.json に永続化） |
| 実行権限の分離 | 操作は `client` / `session` / `request` に分類。UI 自体は何も実行しない |

## エージェントからの使い方

```text
dashboard_present_ui({ message_id, blocks, session_id?, surface_id?, observation? })
  -> { surface_id, revision, block_count, actions[], fallback[] }

dashboard_get_feedback({ after })
  -> { messages: [ { type: "ui_action", surface_id, block_id, action_id, value, ... } ] }
```

- `message_id` は1ターンごとに付与します。同じ `surface_id` を渡すと**同じ面を更新**し、`revision` が増えます。
- `actions` にはサーバーが検証した操作IDを返します。既定の操作IDはブロックから補完し、
  明示したIDも検証します。操作の受け付けは現在の提示面・版・ブロック・操作IDに限定します。
- `fallback` は検証に失敗したブロックの一覧です。未知の種別や型の不一致はテキスト表示へ退避し、実行はしません。
- 値が未取得のときは `null` を使います。**0で埋めないでください**（0と未取得は別物です）。

## ブロック種別（19）

`text` `heading` `caption` `code` `callout` `status-badge` `key-value` `simple-table`
`card` `row` `column`（`card`/`row`/`column` は入れ子可、深さ3段まで）
`choice` `button` `form` `dev.diff-split` `dev.test-results` `chart.line` `chart.bar` `agent.approval`

例：テスト結果と次の操作を同時に表示します。

```json
{
  "message_id": "turn-7",
  "blocks": [
    { "id": "results", "kind": "dev.test-results",
      "data": { "suite": "cargo test", "cases": [
        { "name": "a", "status": "pass" }, { "name": "b", "status": "fail" } ] } },
    { "id": "next", "kind": "choice",
      "data": { "prompt": "次に行う操作", "choices": [
        { "id": "fix", "label": "失敗した8件を分析して修正する" },
        { "id": "log", "label": "失敗ログを詳しく表示する" } ] } }
  ]
}
```

## 操作と権限の分離

| 分類 | 種別 | 挙動 |
| --- | --- | --- |
| `client` | `copy` `expand` | ブラウザ内で完結。何も返らない。 |
| `session` | `submit_choice` `submit_form` `approve` `reject` `open_url` | 選択・入力が同じセッションへ戻る。**実行権限は発行しない。** |
| `request` | `request_tool` `request_approval` `interrupt` `apply_patch` `delete` `publish` `charge` | 要求として記録するだけ。実行は既存の認可された経路（質問カード・予算制御・追指示）で行う。 |

記録される feedback は常に `execution_authorized: false` です。UIのボタンを押しただけで
コマンド実行・パッチ適用・公開・削除が行われることはありません。

## 状態管理と再送

- 面は `surface_id` と `revision` の組で識別します。古い `revision` での操作には `409 ui_action_stale` を返します。
- 同じ `action_request_id` の再送には**元の記録を返します**（`replayed: true`）。二重実行はしません。
- `submit_choice` `submit_form` `approve` `reject` は面・版・操作ごとに1回だけ受け付けます。
  2回目は `409 ui_action_already_submitted` を返します。
- ブラウザの再描画は `surface_id@revision` が変わったときだけ行い、入力中の下書きや選択を壊しません。
- 1面あたり200ブロックまでです。記録する操作は2000件とし、古いものから破棄します。
- 保存済みの面が破損している場合は、読み込み時に拒否します（`ui_invalid_store`）。

## 検証

```sh
node --check dashboard/ui/registry.mjs dashboard/ui/blocks.mjs dashboard/ui/surface.mjs
node --test dashboard/test/ui-registry.test.mjs dashboard/test/ui-blocks.test.mjs \
  dashboard/test/ui-surface.test.mjs dashboard/test/ui-safety.test.mjs \
  dashboard/test/ui-roundtrip.test.mjs
```

`ui-roundtrip.test.mjs` は実サーバーを起動し、MCP で提示 → ブラウザ相当の HTTP で操作 →
MCP の `dashboard_get_feedback` で返送を確認する往復試験です。

## 見た目の層

提示面は dashboard と同じ世界観（生成り紙・ヘアライン・意味ごとに1色）で描画します。
ブロックは1枚のカードとし、種別ごとの色はバッジとグラフに限定し、数値は等幅数字で揃えます。
観測の種類は各ブロック右上のチップ、出所と時刻は本文末の1行に示します。
主ボタンだけを濃く、それ以外は輪郭線とし、無効時は灰色にして実行されないことを示します。

- 入力中の下書きを壊さないため、再描画は surface_id と revision が変わったときだけ行います。
- アニメーションは面の出現時の1回のみとし、prefers-reduced-motion で停止します。
- 実画面の記録: [desktop](evidence/ui-review-20261013/after-desktop.png) /
  [mobile](evidence/ui-review-20261013/after-mobile.png) /
  [操作の往復](evidence/ui-review-20261013/choice-flow.gif)

ブラウザ確認で見つかった2件（SVG要素の名前空間と、viewBoxだけでは高さが決まらない件）は、
dashboard/test/ui-styles.test.mjs と dashboard/test/ui-assets.test.mjs で再発を防いでいます。

## テーマ（ライト／ダーク）

配色は2組のトークンで管理します。背景と面、罫線3種、文字3種、強調色、トーン5種
（ok/warn/danger/info/neutral）、グラフ5色、影、選択色です。CSS本体に色リテラルは置かず、
素の :root と ダーク用セレクタの2箇所だけに集約しています。

- 初回は保存済みの選択に従い、なければOSの設定に従います。描画前に決定するため画面がちらつきません。
- ヘッダーの「ダーク表示／ライト表示」で切り替え、選択は localStorage に保持します。
- OS設定の変更は、明示的な選択がないときだけ反映します。
- 実画面の記録: [dark mobile](evidence/ui-review-20261013/after-dark-mobile.png) /
  [light desktop](evidence/ui-review-20261013/after-desktop.png)

dashboard/test/ui-theme.test.mjs が、両テーマのトークン一致・未定義トークン0・
トークン外の色リテラル0・起動スクリプトと切り替え機能の存在を検証します。

## DSHのチャット内で使う（plugins/rdsh-agent-ui）

DSH Webのチャットに、エージェントが提示したUIを表示して、選択を同じセッションへ返す
プラグインです。展示用の見本ではなく、双方向の往復が目的です。

1. エージェントが surface を公開する（DSH_HOME/agent-ui/surface.json、または認証付きPOST）
2. チャットの最新ターン末尾にパネルが表示される（グラフ・表・選択肢・差分・テスト結果）
3. 人間が選択すると、選択内容が通常のユーザーメッセージとして同じセッションへ送られる
4. 同時に DSH_HOME/agent-ui/actions.jsonl へ記録する（送信に失敗したときの控え）

- パネルは会話の流れの中に表示されます。新しい面を最初に確認したターン末尾がその面を引き取り、
  その位置に固定されます（surface.turn）。会話が進んでも末尾へ移動しません。
- 送信後は「送信済み」と表示し、必要なら選び直せます。surface を削除すればパネルも消えます。
- 値はテキストかSVG要素としてのみ描画し、エージェント由来のHTML/JSは実行しません。
- ルートはDSHのGUIセッションとHost/Origin検証を通過した要求だけを受け付けます。
- 導入: dsh plugin --profile web add /path/to/rustdsh/plugins/rdsh-agent-ui
- 検証: node --test plugins/rdsh-agent-ui/test/store.test.mjs

実ブラウザでの確認では、クライアントのバンドル（rdsh-agent-ui/client.js）が読み込まれ、
コンソールエラーが0件であることを確認しています。

## 未実装・注意

- 危険な操作の自動実行はしません。実行は既存の認可経路に残しています。
- MCP Apps のような任意HTML/JSの隔離ホストは未実装です。レンダラーは固定の許可リストのみです。
- `dashboard/model-catalog-ui.mjs` は別作業で追加された静的な見本であり、本プロトコルとは接続していません。
