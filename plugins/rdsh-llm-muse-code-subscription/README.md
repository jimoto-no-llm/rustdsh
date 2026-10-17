# Muse Code 定額接続（互換アダプター）

既存のMuse Code定額契約を利用し、Muse Codeから返されるモデル一覧をHarness上で使用するために明示的に追加するプラグインです。公式の `@muse-code/sdk@1.4.8` の `model/list` からモデル、コンテキスト上限、出力上限、推論段階を取得するため、固定のモデルallowlistは保持していません。認証はCLIの既存ログインを利用し、ツールの実行、承認、サンドボックス、履歴管理はHarnessが担当します。

対応するHarness LLM peerは、検証済みの `0.2.1-alpha.1` または `0.2.1-alpha.3` のみです。SDK `1.4.8` において、両バージョンの正式なWebプロファイルおよび無料の読み取り専用カタログの取得を確認しています。旧バージョンには新しい画像メタデータAPIが存在しないため、該当APIの継承確認はalpha.3のみを対象としています。

この接続は試作段階のものです。テキスト生成およびHarnessのツール呼び出しを対象としており、モデルのステップごとに独立したMuse Codeセッションを使用します。返答は、JSONの検証とCLIの終了確認を行った後に一括で表示されます。画像・動画・音声への対応、暗号化された思考状態の再利用、および長時間タスクにおける品質については、未対応または未評価です。

## 導入

Node.js 22以上、Harness `0.2.1-alpha.1`・`0.2.1-alpha.3`、およびMuse Code `1.4.8-R6256.1` の組み合わせが検証対象です。Muse Codeを通常の手順でインストールし、利用するアカウントの有効な定額契約でログインした状態にしてから追加してください。CLIとSDKのスキーマが一致しない場合、モデルの呼び出しは行われません。

```sh
npm ci --prefix /path/to/rustdsh/plugins/rdsh-llm-muse-code-subscription
```

使用するWebまたはheadlessプロファイルの `cordis.patch.yml` に、次の **insert** を追加してください。通常のpatch行のみでは新規プラグインは追加されません。既存のプロバイダーや既定のモデルを変更する必要はありません。

```yaml
- insert:
    - id: llm-muse-code-subscription
      name: /path/to/rustdsh/plugins/rdsh-llm-muse-code-subscription/index.js
      config:
        museCommand: /absolute/path/to/muse
```

Harnessを再起動すると、**Muse Code · 定額契約** にCLIの全カタログが表示されます。2026-10-13の実機環境では、Wonder、Wonder Full、Spark 1.3、Spark 1.2の4件を確認しました。一覧は60秒間キャッシュされますが、推論開始前にも現在のカタログと推論段階を再確認します。利用可能なモデルは契約プランに依存します。削除する際は、このinsert項目を削除して再起動してください。

### 表示言語

`rdsh.json` の `general.language` に `en`・`zh-CN`・`ja` のいずれかを設定すると、プロバイダー名、rdshが追加するモデル名の接尾辞、説明文、および利用者向け診断の表示言語が切り替わります。未指定または `auto` の場合は、`RDSH_LANG`、`LC_ALL`、`LC_MESSAGES`、`LANG` の中で最初に見つかった空でない値を使用し、いずれも設定されていない場合はNodeの実行環境ロケールに従います。外部カタログ独自の表示名や説明、モデルID、プロバイダーID、モデルの応答、および外部診断の本文は原文のまま維持されます。一覧の取得中に設定が変更された場合でも、取得を開始した時点の言語で結果を返します。表示言語を変更しても、モデルの選択、Contributor設定、および認証方法には影響しません。

### Contributor

**Muse Code · Contributor（学習利用）** は、CLIのContributor modeを有効にする独立した選択枠です。モデルIDには、CLIから取得した実際のIDを使用します。現在のMuse Codeでは同一の4件が両モードに表示され、Meta Model APIの `muse-spark-1.3-contributor` などを架空のIDとしてこの接続へ直接追加することはありません。

Contributorを選択したモデル呼び出しでは、入力および出力がMetaのモデル学習に使用される可能性があります。通常の `muse-code` では無効（OFF）であり、明示的に `muse-code-contributor` を選択した場合にのみ有効（ON）になります。CLIの `--contributor-mode` はその実行時のみの指定であり、既存の既定モデルやMuse Codeの保存済み設定を変更することはありません。CLIから返される推論段階や既定値は、モードごとに使い分けられます。

### WSL Harness → Windows Muse Code

上記の `npm ci` をWindows側で実行することで、WSLから起動するWindows環境のNodeと、Windows側のCLI実行ファイルを指定できます。`workerPath` および `museCommand` には補助Nodeから参照できるパスを、`nodeCommand` にはHarnessから参照できるパスを指定します。設定内に認証情報そのものを記述する項目はありません。

```yaml
      config:
        nodeCommand: /mnt/c/path/to/node.exe
        workerPath: M:/path/to/rustdsh/plugins/rdsh-llm-muse-code-subscription/worker.mjs
        museCommand: M:/path/to/muse-bin-1.4.8-R6256.1.exe
```

推論時は、補助Node側のホームディレクトリ配下にある `.config/muse/auth.json` でOAuthやdevice-codeによるログイン状態および有効な定額契約のメタデータを確認しますが、トークン自体をHarnessへ取り込むことはありません。CLIのHOME、USERPROFILE、XDG_CONFIG_HOMEをその検査対象と一致させ、異なる保存先への `authFile` 指定は拒否します。`META_API_KEY` や `MODEL_API_KEY` を子プロセスへ渡すことはなく、追加の従量課金キーへ切り替える処理も備えていません。一覧取得時にはモデル推論を行わないため、認証ファイルを読み込むことはありません。

補助CLIは毎回空の一時フォルダーで起動し、shellやwriteを無効化して承認を拒否します。CLI自身のツールが使用された応答は破棄されます。停止時やプラグイン終了時には、MSPのキャンセルとSDKの終了処理を待機します。既定のリクエストタイムアウトは10分、終了待機時間は15秒です。これらは `timeoutMs` や `shutdownGraceMs` で変更できます。モデルステップの自動再試行は無効化されています。

利用量はMuse Codeから返された場合のみ記録され、不明なトークン数や金額をゼロとして表示することはありません。定額契約の使用量上限、更新時刻、料金については、Muse Code側でご確認ください。

## 検証

```sh
npm test --prefix plugins/rdsh-llm-muse-code-subscription
```

回帰テストではプロバイダーを呼び出さず、認証条件、APIキーの除外、ツール名の検証、SDKの停止処理、実際の子プロセスを用いたJSON通信・キャンセル・タイムアウト・異常終了のハンドリング、およびHarnessのイベント変換を検査します。実モデルでの確認範囲については、[確認記録](../../docs/evidence/muse-code-subscription.md) を参照してください。

2026-10-15には、公式配布のMeta Platforms署名済みmacOS ARM64 CLI `1.4.8-R6256.1` とSDK `1.4.8` のスキーマが完全に一致すること、および未ログインかつ独立したホーム環境での実際の `model/list` 実行と正常終了を確認しました。なお、この環境の `bundledCatalog` は0件であり、契約プランで利用可能なモデルの存在や推論の成功を示す結果ではありません。セッションの開始、モデルへのリクエスト、およびログインは実行していません。SDK `1.4.6` との組み合わせでは、スキーマの不一致により一覧取得の前に拒否されます。また、正式なHarness `0.2.1-alpha.1`・`0.2.1-alpha.3` Webプロファイルへの追加、起動の完了、2種類の日本語プロバイダー表示、モデル一覧の取得、および新しい基底Adapterの画像送信先メタデータAPIについても、モデルへのリクエストを行わずに確認しました。`alpha.1` のexact peer指定は `alpha.3` の互換性検査で拒否されるため、依存関係もexact `alpha.3` に統一しています。[公式の一覧取得例](https://meta-models.github.io/muse-code-sdk/next/cookbook/list-models-and-switch-mid-session/)でも、未ログイン状態でのカタログ照会と、認証を必要とするモデルリクエストは区別されています。

公式資料: [SDK / MSP](https://meta-models.github.io/muse-code-sdk/1.4/)、[モデルと提供範囲](https://dev.meta.ai/docs/models)、[定額契約とContributor mode](https://dev.meta.ai/docs/muse-code/subscriptions)。定額資格情報の利用先はMuse Code CLIです。直接Meta APIへ接続するキーを追加すると、従量課金の対象になります。

既知のログイン不足やタイムアウトなど、アダプターが定義する診断メッセージは英語・簡体字中国語・日本語で表示されます。エラーコード、provider/model ID、カタログ独自の解説文、およびモデルの応答本文は変更されません。
