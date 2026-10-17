# rdsh Desktop SDK

公式 `@deepseek-ai/dsh-sdk-client` を使うNode.js 24向けの小さな窓口です。
DSHのエージェントループやJSON-RPCは再実装していません。
SDKパッケージはGitHubのソースコードとCIアーティファクトとして提供しており、npmへの公開はしていません。

```js
import { createHarness } from '@jimoto-no-llm/rdsh-desktop-sdk';

const harness = createHarness({
  sdkHome: '/absolute/path/to/your/private-sdk-home',
  dshBin: '/absolute/path/to/bundled/dsh/lib/bin.js',
  cwd: '/absolute/path/to/selected-folder',
  provider: 'your-configured-provider',
  model: 'your-selected-model',
  env: {},
});
try {
  const session = harness.session();
  const result = await session.run('このフォルダの資料を確認してください');
  // result.finalResponse / result.events / result.notifications
} finally {
  await harness.close();
}
```

上記の例にあるパス、プロバイダー、モデルは、アプリで選択した実際の値へ置き換えてください。
`dshBin` はJavaScriptのDSHエントリです。Rustの `rdsh` を渡すと拒否されます。
親プロセスの環境は自動継承されません。必要な環境変数だけを `env` に渡します。
`NODE_OPTIONS` / `NODE_PATH` は大文字・小文字の違いがあっても子プロセスへ渡されず、DSHホームは `sdkHome` に固定されます。
モデルとプロバイダーは省略できないため、呼び出し側から明示します。
実際のモデル接続やルーティングは、DSHプロファイルの設定と公式実装に従います。

権限、ツール、モデル接続は、選択したDSHホームの `sdk` プロファイルが担当します。
この窓口だけでPC全体を隔離するものではありません。
公式SDKにはターン途中のキャンセル用プロトコルがなく、終了処理はこのSDKが所有する
ランタイムを `close()` する方式です。既存Desktopの別プロセスを停止することはありません。

`desktopPaths()` はrdsh専用ホームと同梱されているRustバイナリの場所を返します。
`configureUpdater()` はrustdshのGitHub Releasesと `rdsh-desktop` チャンネルを指定します。
ダウンロードやインストールは別の操作であり、ダウングレードや未公開版への自動切り替えは許可されません。

```sh
npm ci --ignore-scripts
npm test
npm pack --ignore-scripts
# tgzを別の利用者用ディレクトリへ入れ、公開APIと実際のstdio通信を検証する：
npm run test:packed -- ../../target/desktop-sdk-consumer .
```

テストの通信相手は、合成データだけを扱うNode.jsプロセスです。
初期化の失敗、タイムアウト、突然の終了、終了処理の重複呼び出しを検証し、
SDKが所有する子プロセスの終了を確認します。実際のモデルや個人のDSH設定は使いません。

対応する公式SDKは **0.2.1-alpha.2** です。
参照：[公式SDK](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/sdk/client)。
