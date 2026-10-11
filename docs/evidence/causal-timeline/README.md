# 因果タイムラインのブラウザー検証

結果は `runtime-observations.json` に記録されています。検証対象のコードは
`8131026b9ead463882dcb62b17f0abdeccb954b8` です。隔離したプロジェクト画面とローカルHTTP APIを使い、要約と問題詳細、
保存した実行コマンドIDから受入証拠、受入証拠IDから質問・回答への明示リンク、
再読込後のID保持、入力変更後の受入検証の古さ、390px幅の表示を確認しました。
結果は `PASS`、ページエラーは0件です。

native入力の受領・処理結果は明示的な保存済みfixtureです。リンクIDは人が記録した参照で、
成功した実行の証明ではありません。この検証ではproviderやモデルを呼び出さず、認証情報や
DSH profileも使いません。ローカルの受入コマンド結果はnative実行fixtureと区別して記録しています。

リポジトリのルートで再実行できます。

```sh
RDSH_QA_SOURCE_HEAD=8131026b9ead463882dcb62b17f0abdeccb954b8 \
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
