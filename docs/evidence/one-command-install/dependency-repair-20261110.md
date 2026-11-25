# 自動準備の依存修正（2026-11-10）

## 変更

専用 runtime の manifest に、`undici 8.12.3`、`zod@>=4 <4.6.7` のみ `4.6.7`、
`@modelcontextprotocol/client 2.3.1`、`fflate 0.8.3` を指定します。
Unix / Windows の単独インストーラは同じ処理を内包します。
新規 manifest を作成でき、再実行時は既存 dependencies と無関係な overrides を保持します。
不正 JSON / overrides と symlink manifest は書き換える前に拒否します。
DSH `0.2.2-alpha.3` のソースと版・ハッシュの検証は変更しません。

## 実行結果

macOS arm64、Node.js 26.13.0 で確認しました。実ユーザーの認証・モデルを使わず、
実インストーラは使い捨て HOME とインストール先で実行しました。

- `install.sh --runtime-only`: 新規 runtime への597パッケージ導入、pnpm起動、DSH `0.2.2-alpha.3` 起動に成功。
- 実インストーラが作成した依存ツリーの `npm audit --json`: 脆弱性0件。
  [監査出力](dependency-repair-20261110-audit.json)を保存しました。
- 同じ修正依存で `setup-model-catalog.mjs` を `--experimental-import-meta-resolve` 付きで実行:
  OpenAI / Anthropic / Mistral 合計96モデルを取得。API推論・ログイン・外部モデル探索は未実行。
- DSH入口 SHA256: `b6640801a5a65aae9f53ca21bcce3b2ea28bd9e9554c939c1ff7c4448d91fa18`。
- dsh-tools SHA256: `1889cbf718d64518dd83245d4dba1e1f080b2c5326259c3ed5b1be7a7666a2bd`。
  いずれも #1054 の監査済み値と一致。
- `tests/runtime-dependency-policy.test.mjs`: 7件成功。新規・再実行・無関係設定保持・不正入力保全・symlink（リンク先のない場合も）拒否。
- `tests/runtime-bootstrap.sh`: 不足ツール準備・空白/引用符入りPATH保持・checksum拒否の3項目成功。
- `tests/setup-model-catalog.test.mjs`: 2件成功。
- `cargo test setup_models --bin rdsh`: 14件成功。
  同時実行拒否、中止、要求型/不要provider拒否、子プロセス出力の秘匿、期限切れを含みます。
- alpha.3の改変runtime拒否テスト: 成功。

## 未確認

macOSでは既存の `rdsh_inspect` 実サンドボックス試験が Linux x86_64 必須として拒否されます。
依存の読み込みとハッシュ照合に続く境界での制約です。Linuxで同梱の
`tests/dsh-alpha23.test.mjs` を実行して確認してください。
Windowsインストーラの実行と新しいCIカバレッジ値は未確認です。
この記録は公開版の更新、上流DSH自体の安全性保証、#1059のDraft解除を意味しません。

## PR更新前の再検証（2026-11-11）

更新されたPR head `0ec8317a` に main `fd2f5b6f` を統合して修正を移植しました。
MCP exposure は main の node `2.1.2` を保持し、監査済みDSH rc.4に統一しています。
Rust関連14件、runtime policy / catalog 9件、exposure 22件、OAuth 74件、
Unix bootstrap 3項目、全target Clippy、fmt、build、CLI回帰117項目とpipe終了確認が成功しました。
ShellCheckはbootstrapで成功、install.shでは従来からの未使用変数 `extra`（SC2034）のみを除外して成功しました。
CIのWindows実行・Linux実sandbox・カバレッジはpush後の確認対象です。
