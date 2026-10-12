# Muse Code 定額接続（互換アダプター）

既存のMuse Code定額契約で **Muse Wonder** / **Muse Wonder Full** をHarnessから利用する、明示的に追加するプラグインです。公式 `@muse-code/sdk@1.4.6` でMuse Code CLIを操作し、認証はCLIの既存ログインに任せます。Harnessのツール要求はJSONで受け取り、実行・承認・サンドボックス・履歴はHarnessが担当します。

この接続は試作です。テキストとHarnessのツール呼び出しが対象で、各モデルステップに独立したMuse Codeセッションを使います。返答はJSON検証とCLI終了確認後に一括表示します。画像・動画・音声、暗号化された思考状態の再利用、長時間タスクの品質は未対応または未評価です。

## 導入

Node.js 22以上、Harness `0.2.1-alpha.1` とMuse Code `1.4.6-R6000.1` の組み合わせが検証対象です。Muse Codeを通常の手順でインストールし、使いたいアカウントの有効な定額契約でログインしてから追加します。CLIとSDKのスキーマが一致しない場合はモデルを呼び出しません。

```sh
npm ci --prefix /path/to/rustdsh/plugins/rdsh-llm-muse-code-subscription
```

使用するWebまたはheadlessプロファイルの `cordis.patch.yml` に次の **insert** を追加してください。通常のpatch行だけでは新規プラグインは追加されません。既存プロバイダーや既定モデルを変更する必要はありません。

```yaml
- insert:
    - id: llm-muse-code-subscription
      name: /path/to/rustdsh/plugins/rdsh-llm-muse-code-subscription/index.js
      config:
        museCommand: /absolute/path/to/muse
```

Harnessを再起動すると、モデル選択の **Muse Code · 定額契約** に通常のWonderとFullが表示されます。利用できるモデルは契約プランに依存します。削除するときはこのinsert項目を外して再起動します。

### WSL Harness → Windows Muse Code

上の `npm ci` をWindows側で実行し、WSLから起動するWindows NodeとWindows側のCLI実行ファイルを指定できます。`workerPath`、`museCommand`、`authFile` は補助Nodeから見えるパス、`nodeCommand` はHarnessから見えるパスです。資格情報そのものを設定へ書く項目はありません。

```yaml
      config:
        nodeCommand: /mnt/c/path/to/node.exe
        workerPath: M:/path/to/rustdsh/plugins/rdsh-llm-muse-code-subscription/worker.mjs
        museCommand: M:/path/to/muse-bin-1.4.6-R6000.1.exe
```

`authFile` の既定は補助Node側のホーム配下 `.config/muse/auth.json`。アダプターはOAuth/device-codeログインと有効な定額契約のメタデータを確認し、トークンをHarnessへ取り込みません。`META_API_KEY` / `MODEL_API_KEY` を子プロセスへ渡さず、追加の従量課金キーへ切り替える処理を持ちません。Contributor modeはOFFです。

補助CLIは毎回空の一時フォルダーで起動し、shell/writeを無効化して承認を拒否します。CLI自身のツールが使われた応答は破棄します。停止・プラグイン終了時はMSPのキャンセルとSDKの終了処理を待ちます。既定のリクエスト上限は10分、終了待ちは15秒です。`timeoutMs` / `shutdownGraceMs` で変更できます。モデルステップの自動再試行は無効です。

利用量はMuse Codeが返した場合だけ記録し、不明なトークン数や金額をゼロとして表示しません。定額の使用量上限・更新時刻・料金はMuse Code側で確認してください。

## 検証

```sh
npm test --prefix plugins/rdsh-llm-muse-code-subscription
```

回帰テストはプロバイダーを呼び出さず、認証条件、APIキー除外、ツール名検証、SDK停止、実子プロセスでのJSON通信・キャンセル・タイムアウト・異常終了、Harnessのイベント変換を検査します。実モデルでの確認範囲は [確認記録](../../docs/evidence/muse-code-subscription.md) を参照してください。

公式資料: [SDK / MSP](https://meta-models.github.io/muse-code-sdk/1.4/)、[定額契約](https://dev.meta.ai/docs/muse-code/subscriptions)。定額資格情報の利用先はMuse Code CLIです。直接Meta APIへ接続するキーを追加すると従量課金になります。
