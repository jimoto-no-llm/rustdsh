# 公式Desktop・SDKの取り込み

公式のElectron製Desktopを固定コミットから取り込み、rdsh向けの差分を重ねます。
会話・エージェント・RPC・プロセス管理は公式の実装を使います。
取り込み先は生成用の別checkoutで、既存の作業ツリーや個人設定を上書きしません。

| 項目 | 管理方法 |
| --- | --- |
| 公式Desktop / Harness / SDK | `upstream.lock.json` の固定コミット・バージョン |
| rdshのアプリ版 | Rustの `Cargo.toml` にあるバージョン |
| 設定・会話の保存先 | OSのappData配下 `rdsh-desktop/harness` |
| Electronの保存先 | OSのappData配下 `rdsh-desktop/electron` |
| 配布・更新 | `jimoto-no-llm/rustdsh` の専用 `rdsh-desktop` チャンネル |

公式Desktopの「同梱DSHと同じ版」というランタイム検証は残します。
インストールされるアプリの版はrdshの版とし、同梱Harnessの版と元コミットを別に記録します。
製品名・アプリID・URLスキーム・CLIのアプリ参照・更新先・Rustバイナリの同梱を変更します。
公式の強制更新ポリシーサービスは使わず、更新の確認・ダウンロード・再起動は既存の操作を使います。
既存の公式アプリの保存先を共有しません。必要なら `RDSH_DESKTOP_HOME` と
`RDSH_DESKTOP_USER_DATA` にそれぞれ絶対パスで専用の場所を指定します。

## 準備

```sh
cargo build --locked
npm ci --prefix desktop/sdk --ignore-scripts
npm ci --prefix tests/e2e
node desktop/prepare.mjs --checkout target/rdsh-desktop-fork --rdsh-bin target/debug/rdsh
node desktop/verify-prepared.mjs target/rdsh-desktop-fork
```

Windowsのネイティブビルドでは `--rdsh-bin target/debug/rdsh.exe` を指定します。
SDK本体のAPI・配布用tgzの作り方は[SDKのREADME](sdk/README.md)にあります。

準備処理は固定した公式ソースと元ファイルのSHA256を確認し、変更箇所を検査してから書き込みます。
ソースの改行はLFへ正規化して検査し、GitのWindows用改行設定にも対応します。
同じ入力では再実行しても書き換えません。利用者の変更や無関係なファイルがある場合は停止します。
Rustバイナリ、公式コミット、差分生成コードが変わった場合は、新しいcheckoutを指定してください。
古いcheckoutは削除・リセットしません。公式ソースのLICENSEと履歴も保持します。

## Windows・macOSでのアプリ検証

Windows x64またはmacOS arm64/x64のネイティブホストで実行します。
準備にはリリース用のRustバイナリを渡し、公式と同じアーキテクチャを使います。
公式の固定pnpm版をインストールしたうえで、依存関係・ランタイムを取得します。

```sh
# WindowsではRustバイナリに target/release/rdsh.exe を指定
cargo build --release --locked
node desktop/prepare.mjs --checkout target/desktop-native-fork --rdsh-bin target/release/rdsh
pnpm --dir target/desktop-native-fork install --frozen-lockfile
node desktop/build.mjs --checkout target/desktop-native-fork
npm ci --prefix tests/e2e
node desktop/smoke-packaged.mjs --checkout target/desktop-native-fork --output target/desktop-native-evidence
node desktop/archive.mjs --checkout target/desktop-native-fork --output target/desktop-native-artifacts
```

`build.mjs` は公式のツールチェーン検査・全体ビルド・依存パッケージ生成・
ランタイム準備・Electronパッケージング・Host/Office検証を実行します。
署名なしの検証はリリース設定ファイルを読みません。署名済みビルドの検査は保持します。
公式バイナリと同梱パッケージの整合性検証も維持します。
macOSではアドホック署名を実行し、Rustの元バイナリと記録したSHA256を保持します。
ビルドの標準出力と保存する診断ログは、接続トークン・認証値・メールアドレスを伏せます。

`smoke-packaged.mjs` は新規の一時ホームだけを使い、Rustの版・同梱公式CLIへの委譲・
アプリ名・版・保存先・同梱記録・初期画面と正常な終了を確認します。
モデルの呼び出しやアカウント接続は行いません。
PNGと検査結果JSONは指定した出力先に保存します。

`.github/workflows/desktop-native.yml` はWindows/macOSで同じ工程を実行し、
検査結果と署名なしアプリのzip・SHA256を14日間のCIアーティファクトとして保存します。
zipは実機検証用で、インストーラーや公開リリースではありません。
Linuxでは公式のパッケージング対象に合わせて、この工程を拒否します。

## 公式の変更を取り込む

```sh
node desktop/check-upstream.mjs
# 元の差分位置が維持されることを検査したうえで、明示的に固定情報を更新する：
node desktop/check-upstream.mjs --update-lock
npm install --prefix desktop/sdk --package-lock-only --ignore-scripts
```

更新後は新しいcheckoutを準備し、通常のPR・CIで確認します。
SDKの依存版とDesktopのソースを同じ公式コミットで管理します。
元の差分位置が変わった場合は自動適用を止め、変更内容を確認します。
`.github/workflows/desktop-sdk.yml` は3 OSのSDKテスト・SDKの配布用アーティファクトと、
別ディレクトリへインストールしたtgzの公開API・通信を検証します。
固定した公式ソースへの適用・バージョン管理・macOS更新設定も検証します。

## 現時点の検証範囲

公式SDKの実パッケージに対する生成・環境分離・更新先設定を検証しています。
公式ソースへ差分を適用し、元のバージョン管理とmacOS更新ヘルパーを実行して、
Rust/Harnessの版の分離と専用チャンネルを確認しています。
ソースの構文・変換と、ローカル変更の拒否も検証します。
取り込みの単体テストは合成Gitリポジトリを使い、無関係な編集・無視対象の既存出力・
リンク切れのシンボリックリンク・改変された管理情報への書き込みを拒否することを確認します。

Linuxで公式ソースの全体ビルドを確認済みです。
Windows/macOSのDesktop実行は上記CIで検証します。
署名済みインストーラーのビルドと更新前後の実機受入は未完です。
現在の公式Desktopのパッケージング対象はWindows/macOSです。LinuxではSDKとソース準備を検証しています。
既存のRust CLI用リリースにDesktopの更新メタデータがない間は、Desktopの更新は成立しません。
配布時は署名・専用の更新メタデータ・ダウンロード後の検証を含む受入が必要です。
この作業では実アプリの配布、npm公開、バージョン更新、タグ作成はしていません。

公式の参照：[Desktop](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/apps/desktop)、
[SDK](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/sdk/client)。
