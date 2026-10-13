# Muse Code 定額接続の確認記録

2026-10-13。ローカルのMuse Code接続試作を `plugins/rdsh-llm-muse-code-subscription/` へ移し、PC固有の実行ファイルパスを設定可能にした。プラグインは明示的に追加する方式で、既存のプロバイダーや既定モデルは変更しない。

前半は初回の固定2モデル接続の記録。現行の全モデル取得とContributor対応は、後半の追加検証に記録した。

## 実モデルと実画面（初回移植時）

Harness `0.2.1-alpha.1`、公式SDK `1.4.6`、Muse Code `1.4.6-R6000.1`、有効な既存定額ログインを使用。

- 移植したアダプターからWonderが「Muse Code 定額接続 OK」を返した。Windows側の実行は10,660 ms、WSLアダプターからWindows補助Nodeへ標準入出力で接続する実行は7,825 ms。別々の短い疎通試験であり、性能比較ではない。
- 定額OAuth/device-codeログインを補助プロセスが確認し、Muse Code自身が認証とモデル要求を担当した。Harnessへ資格情報をコピーせず、従量課金APIキーへのfallbackを追加していない。
- 両実行でトークン使用量通知はなかった。確認記録のusageは `null` とし、ゼロや推定料金を作っていない。
- 資格情報を渡さない隔離Webプロファイルで、実際のHarnessのモデル選択を確認した。追加前はMuseの項目がなく、追加後に通常のWonderとFullが表示され、Fullを選択できた。この画面検査はモデルを呼び出していない。

[実モデルの記録](muse-code-subscription/live-verification.json)、[実画面の記録](muse-code-subscription/ui-verification.json)。画像は1100×820の実ブラウザー画面から、モデル選択と入力欄の領域を直接キャプチャしたPNG。

追加前:

![Muse接続を追加する前](muse-code-subscription/before.png)

追加後:

![Muse接続を追加した後](muse-code-subscription/after.png)

モデル選択の変更を文字でも示す:

```diff
 DeepSeek
   DeepSeek-V41-Flash
   DeepSeek-V4-Pro
+Muse Code · 定額契約
+  Muse Wonder · Muse Code 定額
+  Muse Wonder Full · Muse Code 定額
```

## 回帰検査（初回移植時）

Windows NodeとWSL/Linux Nodeでプラグインの14テストを通過。認証条件、APIキー除外、許可されたHarnessツール名とJSON引数、任意の使用量通知、SDKのschema不一致と独自ツール使用の拒否、SDK iterator待機中の停止、実子プロセスでの応答・キャンセル・タイムアウト・異常終了、Harnessイベントへの変換とdisposeを検査した。これらの回帰テストはプロバイダーを呼び出さない。

リポジトリの必須検査も通過:

- `cargo fmt --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test --release --locked`（136 unit / 12 credential lock / 16 native E2E / 12 token query）
- `cargo test --release --example benchmark_extended` と `benchmark_models`
- `node --test tests/model_benchmark/fence.test.mjs`
- releaseビルドと `BIN=…/release/rdsh sh tests/regress.sh`（62 checks）
- `RDSH_E2E_BIN=…/release/rdsh npm test --prefix tests/e2e`（既存ブラウザーE2Eと更新バナー13 flows）

実際のモデル選択を再確認する場合は、プラグインに `npm ci` を実行したうえで、インストール済みの元Harnessを指定する:

```sh
RDSH_HARNESS_BIN=/path/to/original/dsh npm run test:muse --prefix tests/e2e
```

この任意テストは一時HOME/DSH_HOMEだけを使い、ユーザーのプロファイルや認証を変更しない。Windows Nodeを呼ぶWSL設定例は [プラグインの導入手順](../../plugins/rdsh-llm-muse-code-subscription/README.md) を参照。

## 確認範囲（初回移植時）

PR内の移植版は、Wonderの実応答、WSL→Windows通信、実画面でのFull選択、プロバイダーを使わない回帰検査を確認した段階。元のPC固有試作には2026-10-13のFull/Bashツール往復と実モデル停止の記録があるが、移植版での実AgentLoopを通じたFullの長時間実行、headlessのタスク実行、画像・動画・音声は今回確認していない。CLIとSDKの更新時には再検証が必要。

## モデル一覧とContributorの追加検証

2026-10-13、ユーザーのSpark・Contributor追加依頼に対応。固定allowlistを除去し、公式SDKの `model/list` が返す全モデルを採用した。モデルID、コンテキスト・出力上限、推論段階・既定値をカタログから読み、モード別に60秒キャッシュする。各推論の開始前にも現在のCLIカタログを確認する。

実CLI `1.4.6-R6000.1` の取得結果は両モードとも次の4件だった:

- `muse-wonder-1.0`
- `muse-wonder-full-1.0`
- `muse-spark-1.3`
- `muse-spark-1.2`

カタログのsourceは `providerCatalog`。contextLimitは1,007,997、outputLimitは128,000。Spark 1.2の推論段階にmaxはなく、Spark 1.3はモードによってカタログの既定値が異なる。これらを固定のWonder値で上書きしない。取得は `model/list` のみで、モデル推論やユーザープロンプトの送信は行っていない。[カタログの実取得記録](muse-code-subscription/catalog-20261013/catalog-verification.json)。

Muse Codeでは同じモデルIDに `--contributor-mode on` を指定するため、`muse-code`（通常・OFF）と `muse-code-contributor`（Contributor・ON）を独立した選択枠にした。Contributorの名称に「学習利用」を表示する。CLIヘルプはこの指定が実行単位であり保存されないことを明記している。既存の既定モデルや保存設定は変更しない。[公式のContributor説明](https://dev.meta.ai/docs/muse-code/subscriptions)、[直接Meta APIのモデルIDとの違い](https://dev.meta.ai/docs/models)。

実Harnessの隔離Webプロファイルで、4モデル×2モードの表示、通常のFull選択、ContributorのSpark 1.3選択を確認した。Contributorの生成は実施していない。[画面の確認記録](muse-code-subscription/catalog-20261013/ui-verification.json)。

![追加前の実モデル選択](muse-code-subscription/catalog-20261013/before.png)

![全モデルの通常枠とContributor枠](muse-code-subscription/catalog-20261013/after.png)

![Contributor枠の4モデル](muse-code-subscription/catalog-20261013/contributor.png)

追加した通常モデルでは、Spark 1.3（Windows、10,055 ms）とSpark 1.2（WSL→Windows、6,785 ms）が「Muse Code 定額接続 OK」を返した。どちらも短い疎通試験で、使用量通知はなくnullを保持した。[追加モデルの実応答記録](muse-code-subscription/catalog-20261013/live-verification.json)。

WindowsとWSL/Linuxで21回帰テストを通過。将来の追加モデルを固定allowlistの編集なしに使えること、カタログにないID・非対応の推論段階を推論前に拒否すること、Contributorの明示的なルーティング、モード別キャッシュ、未取得の上限を推定で埋めないことを検査した。PRレビューで指摘された別authFileとCLI認証ストアの不一致も修正し、CLIのHOME等と検査対象を一致させた。

更新済みmainを取り込んだHEADでfmt・clippy・releaseテスト（143 unit / 12 credential lock / 16 native E2E / 12 token query）・両benchmark例・fenceテスト・regress・ブラウザーE2Eを再確認した。regressはWindowsチェックアウトのTSV改行を、Git blobと同じLFで確認した。

任意の実画面検査をWSL→Windowsで再実行する場合、`RDSH_MUSE_NODE_COMMAND`、`RDSH_MUSE_WORKER_PATH`、`RDSH_MUSE_COMMAND` でREADMEの3つの実行パスを指定する。認証情報を渡す変数はなく、モデル一覧取得と画面選択だけを確認する。

Contributorは一覧・選択・回帰検査まで。Contributorの実生成、長時間品質、Fullの移植版AgentLoopタスク、headlessタスク、画像・動画・音声はこの追加検証では確認していない。
