# dsh-mobile-maxxing

DeepSeek Harness（DSH）の Web UI を、スマートフォンとタブレットで快適に使うためのプラグイン群です。
PWA、モバイルレイアウト、通知、Markdown 表、日本語 UI を、必要なものだけ導入できます。

**[最新リリース v1.0.0](https://github.com/kuraneko1/dsh-mobile-maxxing/releases/tag/v1.0.0)** · **[リリースノート](RELEASE-NOTES-v1.0.0.md)** · **[English](README.en.md)**

- モバイル本体は素の DSH にそのまま導入でき、通知用の外部ライブラリも不要です。
- 画面幅ではなく端末を判定するため、狭い PC ウィンドウやタッチ対応 Windows PC をモバイル扱いしません。
- PC ではモバイル用の UI・表スタイルを構築せず、標準の DSH を保ちます。
- 端末側の見た目や入力設定はブラウザごとに保存し、ホストの共有設定を書き換えません。

## コンポーネント

| コンポーネント | 役割 | 現在の版 | ソース |
| --- | --- | --- | --- |
| `dsh-mobile-maxxing` | PWA、通知、モバイル UX | 1.0.0 | このリポジトリ |
| `dsh-md-rendering` | モバイルの Markdown 表表示 | 0.1.3 | [kuraneko1/dsh-md-rendering](https://github.com/kuraneko1/dsh-md-rendering) / [`packages/dsh-md-rendering`](packages/dsh-md-rendering) |
| `dsh-locale-ja` | 65名前空間・2915キーの日本語 UI | 0.1.1 | [kuraneko1/dsh-locale-ja](https://github.com/kuraneko1/dsh-locale-ja) / [`packages/dsh-locale-ja`](packages/dsh-locale-ja) |

3つは独立しています。プラグイン画面で個別に有効・無効を切り替えられます。
CJK の自動リンク修正は、PC の描画を変えない方針のため、別パッケージ `rdsh-markdown-cjk` に分離しています。

## 動作条件

- 検証対象の DSH: **0.2.1-rc.2 / 0.2.1-rc.3**
- ブラウザ: 現行の Chrome / Edge / Safari。iOS・iPadOS を含みます
- PWA と Web Push: **HTTPS または localhost** で DSH へアクセスしていること
- OS 通知: ブラウザと OS の両方で通知が許可されていること

実機の OS・ブラウザ・Push サービスにも依存するため、導入後は設定画面のテスト通知を使って確認してください。

## クイックスタート

### 3コンポーネントをまとめて導入

次の1つのインストール用URLから導入できます。

```sh
curl -fsSL https://raw.githubusercontent.com/kuraneko1/dsh-mobile-maxxing/main/scripts/install-mobile-bundle.mjs | node --input-type=module
```

既定では `web` プロファイルへ、本体と日本語化は各リポジトリの `main`、表表示は `v1.0.0` の `0.1.3` 成果物を導入します。
導入後は DSH を再起動し、ブラウザを再読み込みしてください。

別のプロファイルを使う場合:

```sh
curl -fsSL https://raw.githubusercontent.com/kuraneko1/dsh-mobile-maxxing/main/scripts/install-mobile-bundle.mjs | DSH_PROFILE=web-mobile node --input-type=module
```

### 本体だけを導入

```sh
dsh plugin --profile web add https://github.com/kuraneko1/dsh-mobile-maxxing
```

### 日本語 UI だけを追加

```sh
dsh plugin --profile web add github:kuraneko1/dsh-locale-ja
```

### Markdown 表だけを追加

```sh
dsh plugin --profile web add https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v1.0.0/dsh-md-rendering-0.1.3.tgz
```

`dsh plugin --profile web add` は依存と bundle の両方を更新します。`cd ~/.dsh/profiles/web` は不要です。
日本語化はモバイル本体に同梱されず、導入した場合だけ言語一覧に追加されます。

## 最初の設定

1. HTTPS の DSH URL をスマートフォンで開きます。
2. 必要に応じてホーム画面へ追加します。
   - iPhone / iPad: Safari の共有 →「ホーム画面に追加」
   - Android / Chrome: メニュー →「アプリをインストール」または「ホーム画面に追加」
3. DSH の **設定 → モバイル** を開きます。
4. 通知を有効にし、ブラウザと OS の許可を確認して、テスト通知を実行します。
5. 日本語化を導入した場合は、表示言語で日本語を選びます。
6. 更新通知が出たときは、作業中のセッションに支障がないタイミングで再読み込みします。

## 画面

<p>
  <img src="packages/dsh-mobile-maxxing/docs/install-card.png" alt="モバイルのインストールカード" width="360">
  <img src="packages/dsh-mobile-maxxing/docs/settings.png" alt="モバイル設定画面" width="360">
</p>

## 主な機能

### PWA とモバイル UX

- ホーム画面への追加、アプリシェルのオフライン起動、更新のお知らせ
- サイドバーのドロワー化、設定への1タップアクセス、セーフエリアへの対応
- キーボード表示時の入力欄の確保、ターミナル用の Esc / Tab / 矢印 / Ctrl キー
- コードとレビューの折り返し、ツール要約と Bash プレビューのモバイル表示
- ファイル検索、右パネル、モデルメニュー、長押しとスワイプ操作の改善
- ライト / ダーク / 端末に合わせるテーマ、ターミナルだけを暗くする表示

端末モードは幅ではなく端末から判定します。モバイル UI が有効なときだけ、専用のスタイルとイベントを構築します。

### この端末だけの設定

設定 → モバイル では、次の項目をブラウザごとに変更できます。

- 本文・コード・ターミナルの文字サイズ
- 表示言語とテーマ
- 作業の詳細、完了ターンの折りたたみ、実行中の Enter、性能表示
- 通知、通知音、音量
- 新しいセッションで使う権限の既定

これらは `localStorage` に保存され、PC や他の端末の設定、ホストの共有設定は変更しません。

### 通知

| アプリの状態 | 動作 |
| --- | --- |
| 前面で表示中 | アプリ内バナーと通知音。バナーの ACK を受けた端末への Push は省略 |
| 背面・切断・終了時 | Web Push で OS 通知 |
| 通知をタップ | 対象セッションを開く |

既定では、この端末から送信したターンの完了を通知します。質問は送信元に関係なく通知します。
プロファイル側の `notifications.onlyMobileTurns` を `false` にすると、PC 起点を含む全ターンを通知対象にできます。

v1.0.0 では、通知の信頼性と安全性も強化しています。

- 送信を `requestId` と実際のメッセージで対応付け、遅延した要求を別ターンへ割り当てません
- 同一 User-Agent の別端末を推測で削除せず、明示された旧 endpoint と Push サービスの 404 / 410 だけを整理します
- 端末ごとに並列配信し、10秒の期限を設けます
- 明示的に有効化した購読は、起動・オンライン復帰・可視化時に復旧します
- 公開 origin と待機中の送信識別子をプロファイル別に保存します
- Push endpoint は HTTPS に限定し、DNS の全回答を検証して検証済みアドレスへ接続します。リダイレクトは追跡しません

通知の暗号化と VAPID は Node 標準モジュールで実装しています。外部の `web-push` ライブラリは不要です。

### Markdown 表

- 横スクロール、文字サイズ、罫線、余白、テーマに沿った背景をモバイル向けに調整します
- モバイル本体なしの単体インストールでも、端末情報からモバイルを判定します
- 明示された desktop / mobile モードを優先し、PC では React の読み込みとスタイル登録を行いません
- Markdown の解析や表以外の本文は変更しません

詳しくは [`packages/dsh-md-rendering/README.md`](packages/dsh-md-rendering/README.md) を参照してください。

### 日本語 UI

- 65名前空間・2915キーを翻訳し、英語フォールバックは0です
- モバイル本体には含めず、独立した `dsh-locale-ja` だけが日本語を所有します
- DSH 0.2.1-rc.2 / rc.3 の peer 依存に対応しています
- 不完全なカタログは `pack-all` が `REFUSED` と表示し、配布しません

詳しくは [`packages/dsh-locale-ja/README.md`](packages/dsh-locale-ja/README.md) を参照してください。

## インストーラーの設定

| 環境変数 | 用途 | 既定 |
| --- | --- | --- |
| `DSH_PROFILE` | 導入先プロファイル | `web` |
| `DSH_BUNDLE_TAG` | 本体を固定する Git ref と、表 tarball を含むリリースタグ | `v1.0.0`（本体は `main`） |
| `DSH_BUNDLE_BASE_URL` | 表 tarball のダウンロード元 | 指定タグの GitHub Releases |
| `DSH_LOCALE_REF` | 日本語化を固定する Git ref | `main` |
| `DSH_MD_VERSION` | 表パッケージの版 | `0.1.3` |

例:

```sh
DSH_PROFILE=web-mobile \
DSH_BUNDLE_TAG=v1.0.0 \
DSH_LOCALE_REF=main \
DSH_MD_VERSION=0.1.3 \
  node scripts/install-mobile-bundle.mjs
```

`DSH_BUNDLE_TAG` を指定すると本体もその Git ref に固定されます。指定したリリースに、対応する表 tarball が必要です。

## トラブルシューティング

### モバイル表示にならない

- 画面幅だけではモバイル判定されません。UA・platform・touch 情報を確認してください。
- 古いオフラインシェルを使っている場合は、オンラインで開き直して HTML とクライアントを更新してください。
- DSH 更新後に装飾だけが外れた場合は、上流 DOM の変更による fail closed の可能性があります。標準 UI のまま動作します。

### 通知が届かない

1. HTTPS または localhost で開いているか確認します。
2. ブラウザと OS の通知許可を確認します。
3. 設定 → モバイル で購読状態とテスト通知を確認します。
4. 既定の `onlyMobileTurns: true` では、PC から送ったターンは通知されません。モバイル端末側の設定とプロファイル設定を確認してください。
5. リバースプロキシを使う場合は、ブラウザから見た公開 origin から一度アプリを開き、購読を登録し直してください。

### 古い版がインストールされる

pnpm は URL 単位でキャッシュします。版なし URL の内容だけを更新せず、版付きの tarball または Git ref を指定してください。
公開済みリリースの資産を同じ URL で差し替えることも避けてください。

### PC で表の見た目が変わらない

仕様です。`dsh-md-rendering` はモバイルだけに適用され、PC ではスタイルを登録しません。

## ドキュメント

- [詳しい使い方（日本語）](packages/dsh-mobile-maxxing/docs/USAGE.ja.md)
- [Detailed usage (English)](packages/dsh-mobile-maxxing/docs/USAGE.en.md)
- [本体パッケージの README](packages/dsh-mobile-maxxing/README.md)
- [開発メモ](CONTRIBUTING.md)
- [実装の参考元](CONTRIBUTING.md#実装の参考元)
- [v1.0.0 リリースノート](RELEASE-NOTES-v1.0.0.md)

## 開発

検証には Node.js 24 を使用しています。

```sh
npm test
npm run test:locale
npm run check:locale
npm run check:locale:generated
node scripts/pack-all.mjs
```

主な構成:

```text
packages/dsh-mobile-maxxing/  本体の host / client / service worker / tests
packages/dsh-md-rendering/    独立した Markdown 表プラグイン
packages/dsh-locale-ja/       日本語辞書と生成物
scripts/                     インストーラーとパッキング
tools/                       日本語辞書の生成・検証
```

共通のビルド工程はありません。ブラウザ側は生の JavaScript を配信し、ホスト側は Node 標準モジュールで動作します。
チェックアウトを直接導入する場合:

```sh
dsh plugin --profile web add link:/path/to/dsh-mobile-maxxing
```

## リリース

```sh
export DSH_RELEASE_TAG="v$(node -p "require('./package.json').version")" # 別タグにする場合は変更
node scripts/pack-all.mjs --require-locale && \
gh release create "$DSH_RELEASE_TAG" \
  "dist/dsh-mobile-maxxing-$(node -p "require('./package.json').version").tgz" \
  "dist/dsh-mobile-maxxing.tgz" \
  "dist/dsh-md-rendering-$(node -p "require('./packages/dsh-md-rendering/package.json').version").tgz" \
  "dist/dsh-locale-ja-$(node -p "require('./packages/dsh-locale-ja/package.json').version").tgz"
```

`DSH_RELEASE_TAG` は tarball 内の案内URLと GitHub リリースタグの両方に使われます。
`dist/` 内の過去の成果物は保持されますが、リリースには今回の4ファイルだけを添付します。日本語化の検証に失敗した場合は公開しません。
README の版付きURLは `pack-all` が更新します。版なしURLを再利用して pnpm のキャッシュ問題を起こさないでください。

## 貢献者

- [@kuraneko1](https://github.com/kuraneko1)（`_ryu15_` 名義のコミットを含む）— 実装、レビュー対応、日本語化、検証、配布整備
- [@AliceSaikawa](https://github.com/AliceSaikawa) — iOS の PWA、キーボード表示、モバイル UI の改善
- コードレビューと検証に協力いただいた皆さん

貢献内容の詳細は [v1.0.0 リリースノート](RELEASE-NOTES-v1.0.0.md) にも記載しています。

## License

MIT. See [LICENSE](LICENSE).
