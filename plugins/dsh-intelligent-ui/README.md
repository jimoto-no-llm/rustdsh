# dsh-intelligent-ui

モデルが文章の代わりに**対話的なビジュアル回答**を返せるようにする Web プラグインです。
宣言的な `render_ui` ツールと、その描画ビュー（表・グラフ・比較・手順・入力欄など）を足します。

DSH 本体（`dsh-base`）には入っていないため、rdsh が同梱して配布します。
Web / Desktop プロファイルで既定で入り、`INTELLIGENT_UI=0` または
`--recommended=none` で外せます。

## 何を足すか

- Host 側: `render_ui` ツールと、要素カタログの skill
- Client 側: ツール結果を会話の流れの中にウィジェットとして描画

設定はすべて任意です（`cordis.patch.yml` の既定値で動きます）。

```yaml
- insert:
    - id: intelligent-ui
      name: "dsh-intelligent-ui"
      config:
        enabled: true      # false で丸ごと無効
        posture: auto      # auto / encourage / off
        # maxBlocks: 40
        # maxNodes: 240
        # promptOrder: 3200
        # extraGuidance: ''
```

`posture` はモデルが自発的にビジュアル回答を使う頻度です。`auto` は追加のプロンプトを
使わず（0 トークン）モデルに判断させ、`encourage` は比較・データ・手順・計算で
ビジュアル提示を優先させ、`off` はユーザーが明示的に求めたときだけ使わせます。

## 検証

```sh
node --check index.js && node --check client.js
node test/smoke.mjs     # 100 checks
```

## 由来とライセンス

cwd514 氏の [dsh-intelligent-ui](https://github.com/cwd514/dsh-intelligent-ui)（MIT）を
同梱しています。変更点と上流のライセンス全文は
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にあります。

同じターン末尾（`conversation.chat.turnTail`）へ描く [rdsh-agent-ui](../rdsh-agent-ui/README.md)
とは別物です。両方を入れると表示順が重なるため、併用する場合は順序を確認してください。
