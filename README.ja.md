# rdsh — dsh の Rust 高速ランチャー（安全な移植）

[English](README.md)

rustdsh は独立したコミュニティプロジェクトです。DeepSeek および DeepSeek Harness の公式プロジェクトではありません。

[![ci](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/ci.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/ci.yml)
[![dashboard](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/dashboard.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/dashboard.yml)
[![docs](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/docs.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/docs.yml)
[![release](https://img.shields.io/github/v/release/jimoto-no-llm/rustdsh.svg)](https://github.com/jimoto-no-llm/rustdsh/releases)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

<img src="assets/icon.png" width="96" alt="rdsh icon">

フル移植ではなく**ホットパスだけ Rust 化＋残りは本家 dsh に委譲**する設計です。
Linux上の `--version` で起動約98倍・最大RSS約1/23を測定しています。
この数値は短いCLI呼び出しの結果です。Desktop全体の常駐メモリやモデル通信の
削減量を表すものではありません。

- `--version` 起動中央値 **約0.90ミリ秒**（本家約88ミリ秒、Linux）
- `--version` 最大RSS **約2.9MB**（本家約66MB、Linux）
- `dsh`名で置換しても引数を一字も変えず委譲するため、既存の使い方・スクリプトはそのまま動きます

## 目次

- [最初に進める順番](#最初に進める順番)
- [実測](#実測)
- [インストール](#インストール)
- [使い方](#使い方)
- [置換モード（dsh として使う）](#置換モードdsh-として使う)
- [Smart-DSH との併用](#smart-dsh-との併用)
- [Web UI（ダッシュボード）](#web-uiダッシュボード)
- [安全設計](#安全設計)
- [コミュニティ](#コミュニティ)
- [よくある質問](#よくある質問)
- [クレジット](#クレジット)
- [ライセンス](#ライセンス)

## 最初に進める順番

1. 下の手順で導入し、`rdsh --version` と `rdsh doctor` で確認します。
2. `rdsh setup --web` が表示する鍵付きURLを開き、接続と必要な補助機能を設定します。
3. 会話は `rdsh tui` から始め、選択したモデルの応答まで確認します。
4. 状態画面は `rdsh settings set extras.enable serve` で有効化してから開きます。
5. 設定破損時は元のファイルを退避し、明示的な復旧後に設定を再確認します。

詳しい[導入・利用・復旧の動線](docs/USER-FLOW.md)、[設定画面](docs/RDSH-SETTINGS.md)、
[構成図](docs/ARCHITECTURE.md)を用意しています。会話には本家DSHが必要です。

## 実測

手元環境（Linux x86_64）での測定値です。条件をそろえた前後比較も含みます。

| 項目 | rdsh | 比較対象 | 倍率 |
| --- | --- | --- | --- |
| `--version` 起動（中央値、n=5） | 約0.90ms | 本家dsh 約88ms | 約98倍 |
| `--version` メモリ（最大RSS） | 約2.9MB | 本家 約66MB | 約1/23 |
| フック相当処理のメモリ | 約2.7MB | node同等 約45MB | 約1/16 |
| search（300ファイル・60万行） | 約17ms | 改修前 約41ms | 約2.4倍 |
| tokens（9.6MBテキスト） | 約12ms | 改修前 約35ms | 約2.9倍 |
| sessions --tokens（20件展開） | 約0.41秒 | 改修前 約1.65秒 | 約4.0倍 |
| 配布サイズ | 単一バイナリ約806KB | Nodeツリー約508MB | — |

測定コマンドは `rdsh bench --n 5` と `/usr/bin/time -v` です。詳しくは[docs/BENCHMARKS.md](docs/BENCHMARKS.md)を見てください。

現在のソースには、検索の並列処理・メモリ使用量の改善、認証情報とツールの境界の強化、更新通知の非表示状態の永続化も含まれます。
高密度の検索フィクスチャでは中央値 197.77 ms → 4.61 ms でした。Linux の特定条件での測定です。
[測定の証拠](docs/evidence/performance-security-audit.md)とリリースノートを確認してください。
v0.2.0 公開後のソース修正は、その公開済みバイナリには含まれません。

## インストール

いちばん速い方法（ビルド済みバイナリ、Rust不要）：

```sh
# Linux / macOS / WSL
curl -fsSL https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

```powershell
# Windows（PowerShell）
$f = Join-Path $env:TEMP 'rdsh-install.ps1'
Invoke-WebRequest -Uri https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.ps1 -OutFile $f -UseBasicParsing
& $f -FromRelease
```

ソースから入れる場合：

```sh
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
./install.sh                 # ビルド＋ ~/.local/bin/rdsh に導入
./install.sh --as-dsh        # rdsh を `dsh` 名でも使えるよう置換（元は dsh-orig に退避）
./install.sh --restore       # 置換を元に戻す
./install.sh --prefix=DIR    # 導入先を変更（既定 ~/.local/bin）
```

install.sh は Linux / macOS / WSL 用です（WSL自動検出、cargoがなければ
rustupで自動導入。`--no-rustup` で無効化）。Windowsネイティブは install.ps1：

```powershell
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
.\install.ps1              # ビルド＋ %LOCALAPPDATA%\rdsh\bin に導入（PATH追加つき）
.\install.ps1 -AsDsh       # `dsh` 名でも使えるよう置換（元は dsh-orig に退避）
.\install.ps1 -Restore     # 置換を元に戻す
.\install.ps1 -Wsl         # WSL側にも install.sh で連動導入
```

| OS | スクリプト | 備考 |
| --- | --- | --- |
| Linux / macOS | `./install.sh` | cargoかcurlが必要（rustup自動導入） |
| WSL | ディストロ内で `./install.sh` | 自動検出。ネイティブ併用は `install.ps1 -Wsl` |
| Windows（ネイティブ） | `.\install.ps1` | Rustが必要。コンパイルにMSVCビルドツールが必要 |

モデル未接続の初回起動は、DeepSeekプロンプトに置き去りにせず案内を出します：
`rdsh setup` を実行してください（`rdsh setup --login` ならCodex/opencodeの
OAuthフローをその場で起動します）。

ソースから直接ビルドする場合は `cargo build --release` で `target/release/rdsh` ができます（Rust 1.85+が必要）。

## 使い方

### dsh 互換（委譲）

```sh
rdsh tui                          # = dsh --profile tui（slim env 付きで委譲）
rdsh --profile web --patch x.yml  # オーバーレイ付き起動
rdsh --passthrough tui            # slim 無し（実行制限は継続）
rdsh --dry-run tui -- --resume abc  # 実行内容だけ表示
```

### 高速ネイティブコマンド（Nodeを起動しない）

```sh
rdsh tokens ./AGENTS.md             # 入力トークン見積（約4文字=1トークン、CJKは1字1トークン）
echo ... | rdsh prune --max-tokens 4000   # head+tailを残して予算内に切り詰め
rdsh search TODO --dir . --max 100 # 再帰grep（並列・出力順は逐次と同一）
rdsh search-web "rust async" --limit 5  # search-web有効化とSearXNGが必要
rdsh compact ./s.jsonl --max-tokens 8000 # セッションJSONLの圧縮（元ファイル不変）
rdsh sessions --limit 20 --tokens  # セッション一覧＋展開後トークン見積
rdsh logs --tail 50 --grep ERROR   # 起動ログの参照
rdsh profiles / rdsh skills        # プロファイル・スキル一覧
rdsh doctor                        # 本家dsh・DSH_HOME・slim設定の確認
rdsh bench --n 5                   # rdsh/dsh の起動比較
rdsh serve                         # serve有効化後の状態画面（:38080）
```

### 選択した認証情報だけを共有する（rdsh auth）

Codex / OpenCode / 環境変数の認証情報を、秘密値なしで一覧にします。
共有元とcredentialを選ぶまでコピーしません。取込先はDSH本来の
$DSH_HOME/.credentials.yamlです。選択は秘密値を含まない
$DSH_HOME/rdsh-auth-sharing.jsonに保存します。

```sh
rdsh auth                                      # 共有元・保存先・選択状態・解除手順
rdsh auth --json                               # 秘密値を含まない機械可読の一覧
rdsh --dry-run auth --select codex:openai-codex --import # previewのみ、ファイル変更なし
rdsh auth --select codex:openai-codex --import    # CodexのOAuthだけ共有
rdsh auth --select opencode:openai-codex --import # OpenCodeのopenaiログインだけ共有
rdsh auth --select codex:OPENAI_API_KEY --import  # CodexのAPIキーは別に選択
rdsh auth --select env:DEEPSEEK_API_KEY --import  # この環境変数だけ永続保存
rdsh auth --unselect codex:openai-codex          # 将来の取込停止、既存コピーは保持
rdsh setup                                    # 選択済みの同期と初回案内
rdsh setup --web                              # 共有元・選択コマンド・個別キー保存
```

--select / --unselectは必要なものだけ個別に繰り返せます。選択すると
boot・dump-config・plugin・dsh名での委譲・setupでも、その共有元から
同期します。--importはすぐに取り込みます。別CLIの未選択トークンが
新しくても採用しません。DSH側の新しいgrantや既存API-key記録・ref、
他のエントリ、コメント、改行形式は保持します。Unixの認証ファイルと
選択ファイルは0600で保存します。

対象はCodexの ~/.codex/auth.json、OpenCodeの
$XDG_DATA_HOME/opencode/auth.json（未設定時はOSのdataディレクトリ）と
旧 ~/.config/opencode/auth.jsonです。OpenCodeのopenaiログインはDSHの
openai-codexへ写すので、選択名はopencode:openai-codexです。
環境変数の保存対象はDEEPSEEK_API_KEY、OPENAI_API_KEY、ANTHROPIC_API_KEYです。
一覧は形式・存在の確認であり、実際の認証成功を意味しません。

すでに渡した環境変数は、DSHとその子プロセスに引き継がれます。
この経路ではrdshはファイルを書かず、JSONにpersistent=false、
共有先、停止・失効手順を表示します。保存するなら別途選択してください。
setup --yesだけでは全環境キーを保存しません。対話setupやWeb画面での
個別の保存は引き続き可能です。

**利用範囲と解除:** 保存した内容は同じDSH_HOMEの全プロファイルで
使えます。選択解除は将来のrdshによる取込を止め、保存済みコピーと
実行中プロセスは残します。コピーの利用を止めるにはDSHを停止して
認証ファイル内の該当record/refを削除します。credential自体の失効は
providerでOAuth grantを取り消すかAPIキーを更新してください。
共有元CLIも使えなくなる場合があります。rdshによるコピーの制御であり、
DSH自身の更新・環境変数の継承・OS sandboxを制御するものではありません。

**従来版からの移行:** 既存のDSH認証情報は残します。選択ファイルが
なければ何も選択せず、従来のauth --importも選択を要求します。
RDSH_AUTH_AUTOSYNC=1で全取込へ戻ることはありません。一覧とpreviewで
確認して必要な共有元を選んでください。RDSH_AUTH_AUTOSYNC=0では
選択を残して自動同期だけを止めます。明示したauth --importは実行できます。
壊れた・読めない選択ファイルでは同期を停止します。

選択変更とrdshの認証書込は共通lockで直列化し、解除完了後に古い選択で
取り込むことを防ぎます。writerの異常終了でlockが残った場合は、
rdsh auth/setupの書込が動いていないことを確認してから
$DSH_HOME/.rdsh-auth-sharing.lockを除去してください。lock中は
launcherが取込をスキップします。

setup --webは毎回アクセス鍵を発行し、#key=...付きURLを表示します。
読み取り・キー保存・終了に同じ鍵が必要です。URLを他人に共有しないでください。
画面では保存前に保存先・利用範囲と、選択解除・コピー削除・provider失効の
違いを確認できます。

一度だけ取り込む場合は `rdsh auth --import --provider openai-codex --source codex` または `rdsh auth --import --ref OPENAI_API_KEY --source codex` を使えます。この指定は継続コピーの選択に保存されず、既存の共有方針を変更しません。継続する場合は別途 `--select` で指定します。

### エージェントの実行制限

Linux x86_64・bubblewrap・prlimit・監査対象DSH 0.2.0-rc.2で、モデルのツールを
`rdsh_inspect` に限定します。ツールには認証ストア・ホスト環境変数を渡さず、
ネットワークとホスト・プロジェクトへの書き込みをカーネルで拒否します。
隔離環境内の使い捨て一時領域は利用できます。利用者が指定したファイルの
コピーだけを、読み取り専用で渡します。例えば：

```sh
rdsh --share-file README.md --share-file src/main.rs --profile tui
```

共有ファイルの内容はモデルへ渡り得るため、秘密情報を含むファイルは指定しないでください。
隠しファイル、リンク、複数のハードリンクを持つファイルは共有できません。
既存bash・read/write/edit・MCP・run_codeツールは拒否します。未対応OS・DSH版、
不一致のツール実装、bubblewrap未導入では保護なしに起動せずエラーにします。
`--passthrough` は環境調整の切り替えだけで、実行制限を解除しません。
この制限はrustdsh経由の新しいプロセスに適用されます。直接DSHを起動する場合や、
既に実行中のプロセスには適用されません。設定されたプラグイン・プロファイルは信頼するコードです。

### 追加機能（既定OFF）

サーバー型の機能は有効化するまで動きません。素のままでは高速なdshです。
セットアップUI（`rdsh setup --web` の追加機能欄）かCLIで有効にします：

```sh
rdsh settings set extras.enable serve,search-web
rdsh settings get extras.enable
```

| 機能 | コマンド |
| --- | --- |
| `serve` | `rdsh serve` 状態ページ |
| `search-web` | `rdsh search-web` Web検索 |

### hooks.json での使い方（`rdsh guard`）

コンテキスト生成は過去セッションを自動で取り込みません。旧設定の
`context.max_sessions` が正でも同じです。履歴の確認は明示的な
`rdsh context search` を使ってください。

Unixのcontextと再帰searchは、ディレクトリのハンドルを基準に各パスを開き、
リンク差し替え・複数のハードリンク・特殊ファイルを拒否します。
Windowsでは安全な実装が入るまで、ネイティブsearchを拒否し、contextの
ファイル読み取りを省略します。

標準入力（フックJSONまたは生テキスト）を走査し、拒否パターンに一致したらexit 2＋理由出力でブロック、それ以外はexit 0で通過します。`--json` はブロック時に `{"decision":"block"}`、一致しない場合は `{}` を返します。一致しないことは実行の承認ではなく、ホスト側の権限確認が必要です。不正・過大なJSON入力も拒否します。パターンの `*` は任意文字列に一致します。

```sh
echo "$input" | rdsh guard --deny "rm -rf /*" --deny "*token*"
```

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "rdsh guard --deny \"rm -rf /*\"" }] }
    ]
  }
}
```

## 置換モード（dsh として使う）

`dsh`名で呼ばれた場合の振る舞いです。

rdsh固有の先頭サブコマンド（`tokens`/`guard`/`serve`/`sessions`等）以外は、**引数を一字も変えず本家へexec委譲**します（`dsh --version`・`dsh --profile tui`・`dsh --help`は完全互換）。探索順などの詳細は[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)を見てください。

- 一時退避： `RDSH_PASSTHROUGH=1 dsh ...`（slim無し）、`RDSH_DRY_RUN=1 dsh ...`（実行内容のみ表示）
- 既定プロファイル： `RDSH_DEFAULT_PROFILE` → ローカルの `tui` → 案内付きエラーの順
- 注意： `dsh tokens` のようにプロファイル名が予約語と衝突する場合は `dsh --profile tokens` で起動してください
- `node "$(... dsh ...)"` 形式のスクリプトは置換中に壊れます。`dsh`/`rdsh` を直接実行してください。対象は `rdsh doctor` が一覧表示します

## Smart-DSH との併用

[Smart-DSH](https://github.com/hikarioyama/Smart-DSH)はDSHのwebプロファイル用プラグイン集
（モバイルUI・Web Push通知・Esc停止）で、競合バイナリではありません。rdshと共存できます。

```sh
rdsh doctor                                    # dsh版＋Smart-DSHバンドルも表示
rdsh --profile web --dump-config | grep notify-push   # 構成の読取確認
rdsh plugin --profile web add /path/to/dsh-notify-push  # dsh plugin と同じ
rdsh --profile web                             # slim env付きで起動（プラグインに影響なし）
```

併用時の注意点：

- ポートは競合しません：dsh web GUIは3080、`rdsh serve`は既定38080です（`--port 0` で自動選択）
- 置換時はSmart-DSHの補助スクリプトに `dsh-orig` を使うか `DSH_PACKAGE_DIR` を指定します
- `rdsh doctor` の版表示で差異を先に確認できます

## Web UI（ダッシュボード）

```sh
rdsh settings set extras.enable serve  # 有効な補助機能の一覧を置き換えます
rdsh serve
# → 起動時に表示される #key=... 付きURLを開く（localhost のみ）
# ※ dsh web GUI（:3080）と競合しません。`--port 0` で自動選択もできます
```

| API | 内容 |
| --- | --- |
| `GET /api/version` | バージョン |
| `GET /api/doctor` | 状態確認 |
| `POST /api/tokens` | トークン推定（`{"text"}`） |
| `POST /api/prune` | 切り詰め（`{"text","max_tokens"}`） |
| `GET /api/bench?n=3` | 起動計測 |
| `GET /api/sessions?limit=20` | セッション一覧 |
| `GET /api/skills` / `/api/profiles` | 一覧 |

`/api/version` 以外のAPIは起動ごとの鍵が必要です。画面がURLから読み取り、
`X-RDSH-Token` ヘッダーで送ります。CDN不要・オフラインで使えます。

手元の状態確認だけなら `serve` を有効化して `rdsh serve` を使います。
プロジェクトの指標・質問と回答・スマホ接続には [Node.jsダッシュボード](dashboard/README.md) を使います（Node.js 22+が必要）。
`rdsh-dashboard project --project <ディレクトリ>` でプロジェクト用、`rdsh-dashboard harness` で元のHarness Web画面を起動します。

Windows ネイティブ版の `rdsh-dashboard` ランチャーでは、`project`／`harness` が通知領域のトレイに常駐します。
右クリックの **Open / 開く** で画面を開き、**Exit / 終了** でその Dashboard と管理対象の Harness を停止します。
停止対象の確認に失敗した場合は終了せず、再試行できます。独立したセッションは継続します。
ダブルクリックでも画面を開けます。隠しアイコンに入れるかは Windows の通知領域設定で選びます。
端末に表示して動かす場合は `--no-tray` を付けてください。
導入・更新は `pwsh -NoProfile -ExecutionPolicy Bypass -File dashboard/install-windows.ps1` です。
このトレイは Node.js Dashboard 用です。`rdsh serve` は端末から起動します。

本家 Harness の更新通知は、実際の更新直後・更新時刻から **2時間ごと**・ページの再読み込みで表示します。
**Dismiss**／**×** はその回の通知を閉じます。閉じても2時間の周期は継続します。
プロジェクトを切り替えてもその回は閉じたままで、次の2時間枠で再表示します。
閉じる操作は同じ OS ユーザーの別ポートにも配信します。
新コードの適用時だけ通常の GUI 再起動・画面再読み込みが必要です。[ブラウザー検証](docs/evidence/update-notice-repeat/README.md)も参照してください。

## 安全設計

1. agent loop・profile bootの再実装はしません。`exec`委譲のみです
2. slimは**環境変数の追加だけ**です。本家が知らないキーは無視されます
3. `desktop`プロファイル拒否・dump排他など本家のエラー条件をRust側でも再現します
4. 読取系（tokens/search/compact/dump --native/serve API/inspect）は元ファイルを書き換えません
5. `--passthrough` はslim調整を無効化します。`./install.sh --restore` で元のDSHへ戻す場合はrustdshの保護も外れます。

現在のcheckoutは `cargo test` と `tests/regress.sh`、[必須チェック](CONTRIBUTING.md)で検証します。
[再現可能な性能測定](docs/BENCHMARKS.md)では、入力と修正前後の出力一致も確認します。

## コミュニティ

- まず [CONTRIBUTING.md](CONTRIBUTING.md)（PRは4行、スクリーンショット規定）。
- バグ・要望：[Issueフォーム](https://github.com/jimoto-no-llm/rustdsh/issues/new/choose)（日本語OK）。
- 質問・相談：[Issues](https://github.com/jimoto-no-llm/rustdsh/issues)。
- 脆弱性は公開Issueに書かず [SECURITY.md](SECURITY.md) へ。
- 設計資料：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)・
  [docs/BENCHMARKS.md](docs/BENCHMARKS.md)・[docs/ROADMAP.md](docs/ROADMAP.md)・
  [docs/RELEASING.md](docs/RELEASING.md)・[CHANGELOG.md](CHANGELOG.md)。

## よくある質問

- **ポートが使用中と言われる**：dsh web GUIは3080、`rdsh serve`は既定38080です。`--port 0` で空きポートを使えます
- **プロファイル名がサブコマンドと被る**：`dsh --profile <name>` 形式で起動してください
- **元に戻したい**：`./install.sh --restore`（退避した本家を復元）
- **`--tokens` の `?` 付き表示**：zstd CLIが無い環境では圧縮サイズからの概算である印です

## クレジット

本家 DeepSeek Harness の開発者・貢献者の皆さんに感謝します。本家のランタイムが rustdsh の基盤です。

- [GrEarl](https://github.com/GrEarl)、[PENTACoXIAN](https://x.com/PENTACoXIAN)：脆弱性の報告・セキュリティレビュー。
- [StudioYebisu](https://github.com/yebisu0529-ship-it)、[RNA4219](https://github.com/RNA4219)、[eightman999](https://github.com/eightman999)：実装・改善・問題の報告。
- [@remydre8](https://x.com/remydre8)：アイディアと製品提案。

Issue、レビュー、検証を通じて協力してくださる皆さんにも感謝します。

## ライセンス

MIT（[LICENSE](LICENSE)）です。本家 DeepSeek Harness と依存ライブラリにはそれぞれのライセンスが適用されます。
