# 旧ブランチの自動テストと実機追試

このページはmain `96dbcbb`への統合前の記録。[旧ソースsnapshot](source-manifest.json)に対応し、統合後のソース・テスト結果・実機再試験を表さない。[統合後の検証](current-integration.md)は別記する。

## 自動テスト

2026-10-08、Node v22.23.3。WindowsのcheckoutとWSLのnative filesystem上の同一ソースを使用。

```sh
cd dashboard
node --test test/*.test.mjs
```

| 環境 | 結果 | ログ |
| --- | --- | --- |
| Windows | tests 74 / pass 74 / fail 0 / skipped 0 | [Windows](logs/windows-final.txt) |
| WSL Linux | tests 74 / pass 74 / fail 0 / skipped 0 | [WSL](logs/wsl-final.txt) |

このコマンドは`package.json`のtestスクリプトと同じだが、npm経由の実行とは記載しない。認証案内の変更直前は同じ両環境で64/64成功し、追加10件と既存64件が成功した。今回は提出用文書をまとめるための再実行は行っていない。

追加10件は初回/状態更新/SSE/回答/共有/QRの401、403/500/通信失敗の区別、SSEだけ切れてAPIが成功した場合の接続表示を検査する。修正前に認証案内の不足とSSE表示の誤りで失敗することを確認してから修正した。

当時の変更済み9ファイルへの軽量チェックは指摘0件。コードレビューと会話を引き継がない要件レビューを実施し、SSE切断中の表示の指摘を修正・再確認した。当時の対象コードは[source-manifest.json](source-manifest.json)で特定する。ログは原記録の内容を保った公開用`.txt`コピー。

提出用レポートは既存CLIで57件の形式・証拠参照を検査してHTMLを生成した。PCの実ブラウザーで53pass/4blockedの表示、「未確認」で4行への絞り込み、「mobile＋戻る」でローカル表示幅の履歴と実機WSL/Tailscaleの計3行、および実機の証拠リンクを確認した。これは提出物の表示確認であり、製品の57経路を再試験したものではない。

## 実機・実ブラウザーの追加確認

端末はiPhone 15。後半の確認で本人がiOS 26.5と申告。古い試行で取得していなかったOS版を過去へ遡って測定済みとは記載しない。

| 追試 | 観測と範囲 |
| --- | --- |
| Safariで同一タブの別ページ→戻る | about:blankから戻り、未送信本文を保持。認証済みconfig/stateは200、POST0・feedback0。WSL/Tailscaleの同一試行として2セルに対応 |
| 完全URL貼り付け | 質問一覧へ到達 |
| 完全URLのリンクタップ | 保存キーなしの起動でURLキーを受け取り、config/state200、本人が質問一覧を確認 |
| コマンド画面 | 本人が「拡大せず、スクロール・閉じるもできる」と確認。表示領域の実測と照合 |
| 回答済みの開閉 | 見出し付近を1回タップして開けることを本人確認。当時は未認証・件数0で、実機のサンプル本文展開まで確認済みとは扱わない |
| PCと携帯の参考情報の配置 | 統合前のソースをPC実ブラウザーの1440px/390px幅で確認。両方で質問文→閉じた参考情報→回答欄。PCで開閉可能。画像は[当時の画面](visual-evidence.md) |
| 接続・共有 | 通常Project CLIでもQR表示を確認。iPhoneで完全URL貼り付け後のQR表示を本人確認。最終QRの別端末読み取りは未試験 |
| 認証失敗の案内 | iPhoneのアプリ内ブラウザーの写真で「接続し直してください」と最新URL/QR案内の可読性を確認。通常Safariの外観とは区別 |
| 有効URLで復旧 | 本人が「案内が消えて、質問一覧が表示された」と確認。iPhoneのconfig401→config/state200、期待キー一致をログで確認。追加回答POST0 |

認証案内はPCブラウザー390px幅でも画面横幅390px、案内幅362pxで表示を確認した。共有更新・QR取得・回答送信後の401は自動テストで確認しており、すべてをiPhoneで個別に再実施したとは扱わない。

## 認証原因の実サーバー再現

同じProject・ポート・保存データを維持しサーバーだけ再起動すると、元のタブの保存キーは拒否され、新しい完全URLで200に復旧した。キーをURLから取り除くのは起動時のアプリ処理であり、認証後の現在URLは元の完全URLとは異なる。別ブラウザーや再起動後にそのURLだけを渡すことは、接続情報の引き継ぎを保証しない。

元の完全URLのリンクタップ自体はiPhoneで成功している。過去の19:33の失敗にはその操作のログがないため、特定のコピー方法やSafariの挙動を原因と断定しない。新しい案内はこの未確定部分を推測せず、利用者が復旧できる手順を示す。

## 証拠と停止状態

### 変更のないRust・CLIの既存チェック

| コマンド | 既存結果と条件 |
| --- | --- |
| `cargo fmt --check` | 2026-10-08 15:24 JST、Windows Rust1.93.1、exit0 |
| `cargo clippy --all-targets -- -D warnings` | 同上、警告0、exit0 |
| `cargo clippy --release --all-targets -- -D warnings` | 同上、警告0、exit0 |
| `cargo test --release --locked` | 同上、65/65、exit0 |
| `sh tests/regress.sh` | 以前の隔離WSL実行で42 checks成功。隔離HOMEとstub DSHを使用 |

旧ブランチの文書整理ではこれらを再実行していない。Rustの既存チェック時点`2de41e6`およびCLIの参照版`58165b1`から、その旧提出ソースまでCargoファイル・src・tests・scripts・install関連の実行対象に差分がないことを照合した。main `96dbcbb`への統合後はこの継承条件の対象外。原記録はローカルの `answer-recovery/rust-checks.txt` と `rust-linux-regress.log`、実行手順 `run-regress-linux.sh`。DSH本体の実モデル実行を含む試験ではない。

dashboardの依存manifest・lockfileも基準版から変更なし。最新の74件は上に示したNode直接実行の結果で、`npm ci`をこの文書整理で再実行したものではない。

ローカルの原記録ラベルは `issue-52-navigation-auth/notes.md`、`issue-52-mobile-ui/browser-observations.json`、`issue-52-auth-cause/notes.md`、`issue-52-auth-notice/notes.md` および同名フォルダの観測ログ。公開時は個人情報を含む原ファイルを転載せず、この要約と必要な安全な集計を提供する。対象ごとの詳しい経路結果は[レポート証拠](report/README.md)を参照。

実機検証に使用した一時Serveと合成サーバーは停止済み。Windows/WSLの試験ポート待受がないことを確認した。ユーザーの通常プロジェクトやDSHの設定は試験用データへ置き換えていない。
