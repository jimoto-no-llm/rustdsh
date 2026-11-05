# 2026-11-04の文書監査への対応

確認日: 2026-11-05。監査対象と同じ main b6aac05 を起点に、記述と実装・公開配布物を照合しました。
公開済みのタグ・配布アセットは変更していません。

| 指摘 | 照合結果と対応 |
| --- | --- |
| F1 保護付き委譲の版 | コードの6組に対して英語・日本語READMEが3組でした。READMEを実装と一致させ、機能別の互換性表への参照を追加しました |
| F2 プラグイン照合表 | 本体のlatestはv0.15.0、プラグインはv0.12.0でした。pinスクリプトは3台帳を更新する一方、workflowの `git add` が本体用2台帳だけだったことを確認しました。3台帳をステージするよう修正し、v0.12.1〜v0.15.0のプラグイン行を公開APIのdigestから補完しました |
| F3 通信の既定値 | Rustの機能カタログではupdate_check / update_notifications / search-webがONでした。PRIVACYを訂正し、既定ONのweb_search_bridgeと、管理下プラグイン・rustxngの条件付き自動更新も記載しました |
| F4 日次更新 | 日次スケジューラは `rdsh update auto on` で明示的に設定するもので、導入だけでは有効になりません。DSHとの関係を説明する文書から、自動導入・常時起動サービスが常にあるような案内も修正しました |
| F5 npmのlatest | 日付付きの古いlatest記述を削除し、変動する配布タグと検証済みの版を区別しました |
| F6 公開インストーラのDSH導入 | **WindowsにnpmでDSHを入れる処理がない、という監査の記述は誤りです。** 公開v0.15.0を取得・照合し、npm既存・対話端末・CI外・NoSetupなし・本人の確認後に導入するコードを確認しました。Unixは案内のみで、Node.js / pnpmの一括準備は両者ともありません。SETUPはOSと条件を分けて訂正しました。包括的な自動導入は別PR #1059です |
| F7 機能ごとの範囲 | Rustの保護付き委譲、ACP、固定更新、peer宣言、同梱プラグインの検証を別の表にしました。追加の食い違いとして、ACPの実装カタログはrc.2だけなのに文書がalpha.1も記載していたため訂正しました |

## プラグイン配布物の検証

v0.15.0の `rdsh-plugins.tar.gz` を実際に取得し、SHA-256をGitHub Releases APIのasset digestと照合しました。

```text
fab6b5c5afbff0a3aba24ff2c209a295fc19a47735c2854c93ba75a4c042222b
```

アーカイブには `dsh-mobile-maxxing`、`dsh-intelligent-ui`、`rdsh-web-search-searxng` がすべて存在しました。
補完した値は [plugin-assets.json](plugin-assets.json) に記録しています。
本体用のUnix・Windows台帳はバイト単位で変更していないことも確認しました。
`.sha256` sidecarを根拠に新しいpinを作っていません。

## 公開インストーラの確認

公開v0.15.0の `install.sh` と `install.ps1` も実取得し、GitHubのasset digestと一致しました。
Windowsの条件付きDSH導入は `install.ps1` の466〜476行付近にあります。
[配布物の照合結果](installer-assets.json)にSHA-256を保存しています。公開配布物とタグの両方で確認し、監査文の記述だけを根拠にはしていません。

## 回帰防止と検証

`tests/test_release_audit_contracts.py` を追加しました。

- READMEの保護付き対応版とRustのallowlistが一致する。
- ACP文書の版とDashboardのカタログが一致する。
- 主要スイッチの既定値がRustと設定文書で一致する。
- 3台帳のlatestが一致し、必要なアセットがそろっている。
- pinスクリプトで生成した3台帳を、workflowから取り出した実際の `git add` コマンドがすべてステージする。

修正前のb6aac05から作った一時fixtureでは、5テストのうち6箇所（英日READMEを含む）のassertionが失敗し、問題を再現できました。
修正後は5テストすべて成功しています。リリース関連159テストも成功しました。
`sh scripts/check.sh changed` の選択チェックが成功し、Markdown lintは別途実行して問題なしでした。
workflow全体のGitHub上での実行はCIで確認します。

## 残る境界

- 保護付き委譲の追加対応PR #1054だけで、ACP・固定更新・全プラグインの対応版が広がるとは扱いません。
- 同梱mobileプラグインのREADMEが明記するのはrc.2 / rc.3です。上流の別コミットでのalpha.2検証を、同梱物へ自動的に適用しません。
- 上流のrc.5依存の指摘も、コードを実行しないlockfile解決とnpm auditで再現しました。[解決した版とadvisory](upstream-rc5-audit.json)に記録しています。この変更で上流の配布パッケージを修正したとは報告しません。
- 自動導入PR #1059の固定対象alpha.3でも同じ4ライブラリの問題を確認し、[証拠](upstream-alpha3-audit.json)を記録しました。同PRは依存修正・互換性検証までDraftへ戻しました。
- 未リリースの自動導入、コード修正、依存修正を、公開済みv0.15.0に入っているとは案内しません。
