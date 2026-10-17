# rdsh-agent-ui

エージェントが会話の途中で提示したUIを**DSHのWebチャット内**に表示し、人間の選択を
**同じセッションへ返す**プラグインです。見本の展示ではなく、往復を目的としています。

## 動き

1. エージェントが surface を公開する（`DSH_HOME/agent-ui/surface.json`、または認証付き POST）
2. チャットの各ターン末尾にパネルが表示され、グラフ・表・選択肢・差分・テスト結果を描画する
3. 人間が選択すると、選択内容が**通常のユーザーメッセージ**として同じセッションへ送信される
4. 選択内容は `DSH_HOME/agent-ui/actions.jsonl` にも記録される（送信に失敗した場合の控え）

## 出る場所

パネルは**会話の流れの中**に表示されます。エージェントがメッセージに記述した目印（anchor_text）の
ターンへ固定され、目印がない場合は最初に表示されたターンで一度だけ固定されます（sessionStorage）。

新しい surface を最初に表示したターンの末尾がその surface を
引き取り、その位置に固定されます（`surface.turn`）。会話が進んでも末尾へ移動せず、
履歴と一緒にスクロールします。次の版を出せば、その時点のターンが新しく引き取ります。

送信後は「送信済み」と表示され、**選び直す**で同じ surface に対しもう一度答えられます。

surface を削除すればパネルも消えます。

## ファイル

- `store.js`：surface の検証と保存、操作の追記（重複は request_id で排除）
- `index.js`：認証付きHTTPルート（`/api/rdsh-agent-ui/surface`、`/api/rdsh-agent-ui/action`）
- `client.js`：チャットのターン末尾に表示するパネル（React、DSHのテーマ変数を使用）
- `test/store.test.mjs`：検証・保存・追記の単体テスト

## 安全側の約束

- 値はテキストまたはSVG要素としてのみ描画し、**エージェント由来のHTML/JSは実行しない**
- 未知の種別や破損したデータは描画せず、理由を表示する
- 数値が未取得のときは `null` を使い、**0で埋めない**
- ルートはDSHのGUIセッションとHost/Origin検証を通過した要求だけを受け付ける
- ボタンは選択・入力の返送のみを行い、実行権限は発行しない（要求型は記録のみ）

## 使い方（配布先プロファイルへ）

```sh
dsh plugin --profile web add /path/to/rustdsh/plugins/rdsh-agent-ui
```

## 検証

```sh
node --test plugins/rdsh-agent-ui/test/store.test.mjs
```
