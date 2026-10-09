# 因果タイムラインのブラウザー検証

結果は `runtime-observations.json` に記録されています。検証対象のコードは
`3f90288c423145455889666779de88f798db30ef` です。隔離した実プロジェクト画面と
ローカルHTTP APIを使い、要約と問題詳細、安定ID、再読込後のリンク、入力変更後の
受入検証の古さ、390px幅の表示を確認しました。結果は `PASS`、ページエラーは0件です。

native入力の受領・処理結果は明示的な保存済みfixtureです。この検証ではproviderや
モデルを呼び出さず、認証情報やDSH profileも使いません。実際に動かすのはローカルの
受入コマンドだけで、その結果はnative実行fixtureと区別して記録しています。

リポジトリのルートで再実行できます。

```sh
RDSH_QA_SOURCE_HEAD=3f90288c423145455889666779de88f798db30ef \
RDSH_TIMELINE_E2E_OUTPUT=docs/evidence/causal-timeline \
npm run test:timeline --prefix tests/e2e
```

スクリーンショット:

- [要約](after-summary.png)
- [受領記録が欠落した状態](after-missing-receipt.png)
- [未確認のintent](after-intent.png)
- [関連記録の一覧](after-correlated-records.png)
- [ID相関の詳細](after-exact-links.png)
- [古くなった受入検証](after-stale-check.png)
- [390px幅](after-mobile.png)
