# rdsh-agent-ui

エージェントが会話の途中で出したUIを**DSHのWebチャット内**に表示し、人間の選択を
**同じセッションへ返す**プラグインです。見本の展示ではなく往復が目的です。

## 動き

1. エージェントが surface を公開する（`DSH_HOME/agent-ui/surface.json`、または認証付き POST）
2. チャットの各ターン末尾にパネルが出る。グラフ・表・選択肢・差分・テスト結果を描画する
3. 人間が選ぶと、選択内容が**通常のユーザーメッセージ**として同じセッションへ送られる
4. 選択は `DSH_HOME/agent-ui/actions.jsonl` にも記録される（送信に失敗した場合の控え）

## 出る場所

パネルは**会話の流れの中**に出ます。エージェントがメッセージに書いた目印（anchor_text）の
ターンへ固定し、目印が無い場合は最初に見たターンで一度だけ固定します（sessionStorage）。

新しい surface を最初に見たターンの末尾がその面を
引き取り、その位置に固定されます（`surface.turn`）。会話が進んでも末尾へ移動せず、
履歴と一緒にスクロールします。次の版を出せば、その時点のターンが新しく引き取ります。

送信後は「送信済み」と表示し、**選び直す**で同じ面にもう一度答えられます。

surface を消せばパネルも消えます。

## ファイル

- `store.js`：surface の検証と保存、操作の追記（重複は request_id で排除）
- `index.js`：認証付きHTTPルート（`/api/rdsh-agent-ui/surface`、`/api/rdsh-agent-ui/action`）
- `client.js`：チャットのターン末尾に出すパネル（React、DSHのテーマ変数を使用）
- `test/store.test.mjs`：検証・保存・追記の単体テスト

## 安全側の約束

- 値はテキストかSVG要素としてのみ描画し、**エージェント由来のHTML/JSは実行しない**
- 未知の種別・壊れたデータは描画せず、理由を表示する
- 数値が未取得のときは `null` を使い、**0で埋めない**
- ルートはDSHのGUIセッションとHost/Origin検証を通った要求だけを受ける
- ボタンは選択・入力の返送のみ。実行権限は発行しない（要求型は記録だけ）

## 使い方（配布先プロファイルへ）

```sh
dsh plugin --profile web add /path/to/rustdsh/plugins/rdsh-agent-ui
```

## 検証

```sh
node --test plugins/rdsh-agent-ui/test/store.test.mjs
```
