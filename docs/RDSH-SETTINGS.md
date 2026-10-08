# rdsh の設定画面

DSH の「設定」を開き、左のメニューから「rdsh」を選ぶと、rdsh の設定を変えられます。

## できること

- 予算の変更（トークン上限など）
- 検索・圧縮・記憶のオン／オフ
- 作業メモ（目標、作業中ファイル、未解決タスク）の記入
- 過去の決定事項や制約の保存
- 実験的機能のオン／オフ

## 開き方

1. DSH の左下「設定」を開く
2. 左メニューの「rdsh」を押す（見えないときは下へスクロール）
3. 変えたら「保存する」を押す

## 入っていないとき

```sh
PROFILE=web ./plugins/install.sh
```

で入ります。`headless` の場合は `PROFILE=headless`（初期値）で同じです。

## コマンドから見る

```sh
rdsh settings show    # 今の設定を見る
rdsh settings keys    # いじれるキー一覧
rdsh settings get search.max
rdsh settings set search.max 50
rdsh settings set context.goal "dsh互換性を維持する"
rdsh settings set guard.deny '["rm -rf /*","*token*"]'
rdsh settings unset search.max   # 既定値に戻す
rdsh settings set beta.context_engine true  # 実験機能を使う場合だけ
rdsh context status   # 有効化後に記憶の状態を見る
```

設定は `$DSH_HOME/rdsh.json` に保存され、コマンドと画面で共有されます。
旧 `rdsh-context.json` は `rdsh.json` に context がないときだけ読みます。

ローカル状態画面とWeb検索のオン／オフは `setup --web` のExtras、または
`rdsh settings set extras.enable serve,search-web` で変更します。
ローカル状態画面の既定ポートは38080です。

設定破損時は読み込みを止めます。元のファイルを退避し、既定値へ戻すと決めた
場合だけ `rdsh settings init --force` を実行してください。
[復旧後の確認と利用の流れ](USER-FLOW.md#4-設定が読めないとき)。

## context engine（実験的、既定OFF）

```sh
rdsh settings set beta.context_engine true   # 使うときだけON
rdsh context status
rdsh context build --query "認証" --json
```

優先度は goal > constraints > related_files > git_diff > decisions >
open_tasks > retrieved の順で、予算超過時は retrieved から削ります。
