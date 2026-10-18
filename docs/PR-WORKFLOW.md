# PR対応フロー

正本は `jimoto-no-llm/rustdsh`です。受付、レビュー、準備、マージ判定を分け、
レビューと検証の結果をPR番号・head SHA・base SHAに結びつけます。
参考にしたのは[OpenClawのPR準備フロー](https://docs.openclaw.ai/reference/scripts/pr-preparation)です。
このリポジトリではRust製のローカルCLIとGitHub Actionsを使います。

## 前提とコマンド

Rust toolchain、Git、Node.js 22以降、認証済みのGitHub CLIが必要です。
`scripts/pr`はこのチェックアウトのRust exampleをビルドして実行します。
初回以外はCargoのキャッシュを使います。新しい配布バイナリや追加依存はありません。

```sh
sh scripts/pr queue
sh scripts/pr inspect 123
sh scripts/pr review 123 --verdict needs-work --notes .local/review-notes.md
# 修正後、最新の差分をもう一度レビューする
sh scripts/pr review 123 --verdict ready --notes .local/review-notes.md
sh scripts/pr prepare 123
sh scripts/pr gate 123
```

1. **受付**: `queue`は最大100件をP0〜P3、PR番号の順に表示します。
   優先度がないPRは表示上P2として扱います。ラベルや担当者は変更しません。
   draft、レビュー待ち、CI失敗、競合、取り込み候補を区別して`inspect`に進みます。
2. **レビュー**: `inspect`が最新メタデータと差分を`.local/pr/123/`へ保存します。
   問題、変更前後の挙動、境界条件、必要なテスト、UI画像、性能の測定値を確認します。
   `review`は自分が終えたレビューの記録です。自動でコードを読んで判定する機能ではありません。
   notesには指摘の重要度、ファイル・行、根拠、確認したテストを記載します。
3. **修正・検証**: 指摘を修正して差分を再確認し、`ready`を記録します。
   `prepare`はレビュー済みheadのクリーンなチェックアウトで実行します。
   HEADの違いや未コミット・未追跡の変更があれば止まるため、作業中のチェックアウトからは実行しません。
   fmt、clippy、releaseテスト、benchmark example、PR判定テスト、releaseビルド、
   benchmark fence、回帰テストを実行します。dashboard・workflow-board・installer/releaseの変更には
   対応する追加検証を選びます。他のプラグインやUIの検証は下記の手動確認も必要です。
4. **マージ判定**: `gate`がGitHubの最新状態を再取得します。
   head/baseの一致、完成したレビュー記録、全ローカル検証、OPEN、非draft、main対象、
   MERGEABLE、CLEAN、APPROVED、および必須チェックのSUCCESSが必要です。
   任意チェックの失敗・保留も止めます。必須チェックの欠落・skip・重複した失敗、
   不完全な変更ファイル一覧、未知の状態も成功扱いにしません。
5. **取り込み**: 全条件を満たすと`--match-head-commit <SHA>`付きの
   `gh pr merge`コマンドを表示します。実行はマージの明示承認後です。
   GitHubのブランチ保護も最終操作に適用されます。baseが動いた場合は再レビュー・再検証します。

CLI自身のGitHub操作は一覧・メタデータ・差分の取得だけです。
コメント投稿、レビュー投稿、push、マージ、ブランチ削除、管理設定の変更を実行しません。
外部PRのコードを検証するときは、認証情報のない隔離環境を使ってください。
チェックアウト・rebase・修正は明示的に対象を選び、他の作業ツリーを巻き戻さないでください。

## レビューと追加検証

- ブロッカー: 正しさ、権限境界、データ損失、互換性、検証漏れ。直して再レビューします。
- 小さな改善: 表現や好みだけの変更。取り込みを妨げる指摘と分けます。
- DSHへの委譲は`--passthrough`を基準に比較し、agent loopを再実装しません。
- プラグインを変えたらそのテストを実行します。Web/HTTP/UIは`tests/e2e/README.md`も確認します。
- UIの変更は実際のbefore/after PNG、動きはGIFを添付します。性能改善は測定値を添えます。
- installer・リリース包装は隔離インストール検証が必要です。
  リリース自体は`docs/RELEASING.md`の別フローです。
- GitHubの他者レビューと会話解決は維持します。ローカルのレビュー記録で代用しません。
- 記録は`.local/`に置きGitに含めません。SHA照合は取り違え防止であり、
  ローカルJSONに対する署名やGitHubのマージ権限の代わりにはなりません。

## 自動チェックと導入

`PR policy`はPRのopened/synchronize/reopened/edited/ready_for_reviewで実行します。
テンプレートの概要・変更・検証・注意点の4節が空なら失敗します。HTMLコメントの雛形は内容に数えません。
変更パスに応じた追加検証をログに示します。本文や差分をログに丸ごと出しません。
Actionsは`pull_request`、`contents: read`で動き、投稿用トークンや外部レビューサービスは使いません。

`.github/project-settings.json`の必須チェック一覧にも`PR policy`を追加しています。
ファイルを変更するだけではGitHub管理設定は変わりません。ワークフローがmainに入った後、
実際のPR headで同名チェックが作成・成功することを確認してから必須チェックに登録します。
既存のレビュー条件や保護設定は維持してください。

```sh
cargo test --locked --example pr
sh scripts/pr --help
# オフラインの本文確認: event.jsonにはpull_request.bodyとhead.shaを入れる
sh scripts/pr policy --event .local/event.json
```
