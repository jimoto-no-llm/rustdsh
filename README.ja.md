<img src="assets/icon.png" width="96" alt="rdsh icon">

# rdsh — `dsh` を速く・安全に起動する Rust 製ランチャー

[![ci](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/ci.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/ci.yml)
[![dashboard](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/dashboard.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/dashboard.yml)
[![docs](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/docs.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/docs.yml)
[![release](https://img.shields.io/github/v/release/jimoto-no-llm/rustdsh.svg)](https://github.com/jimoto-no-llm/rustdsh/releases)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![rust](https://img.shields.io/badge/rust-1.85%2B-orange.svg)](https://www.rust-lang.org/)

[English](README.md)

独立したコミュニティプロジェクトです。DeepSeek や DeepSeek Harness の公式ではありません。

`rdsh` は [dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness の CLI）を
速く使うためのランチャーです。全部を書き換えるのではなく、よく使う速い処理だけ Rust にして、
会話やモデルの実行は本家の `dsh` にそのまま任せます。今お使いの引数はそのまま動きます。

## rdsh を選ぶ理由

- 起動が速く、メモリも軽いです。Linux x86_64 の `--version` で約0.90ミリ秒・最大約2.9MB を測定しました（本家 `dsh` は約88ミリ秒・約66MB）。短い CLI 呼び出しの数値で、常駐する Desktop 全体やモデル通信の軽さを表すものではありません。
- 互換性を壊しません。rdsh 固有のサブコマンド以外は引数を変えずに本家へ渡すので、既存のスクリプトはそのまま動きます。
- 便利な高速コマンドがあります。トークン見積りや検索、圧縮、セッション一覧、状態確認を Node なしで実行できます。
- 初期状態から安全です。参照系は書き込みをせず、サーバー機能は有効化するまで動きません。対応する Linux ではエージェントのツールを隔離して動かします。

## 目次

- [はじめに](#はじめに)
- [動作環境](#動作環境)
- [インストール](#インストール)
- [使い方](#使い方)
- [`dsh` として使う](#dsh-として使う)
- [Smart-DSH との併用](#smart-dsh-との併用)
- [Web UI](#web-ui)
- [実測](#実測)
- [安全設計](#安全設計)
- [資料](#資料)
- [コミュニティ](#コミュニティ)
- [よくある質問](#よくある質問)
- [謝辞](#謝辞)
- [ライセンス](#ライセンス)

## はじめに

```sh
rdsh --version && rdsh doctor   # 導入と本家 dsh の確認
rdsh setup --web                # 表示される #key=... 付き URL を開き、モデルに接続します
rdsh tui                        # 会話を始め、選んだモデルの返答まで確かめます
```

詳しい [導入・利用・復旧の流れ](docs/USER-FLOW.md)、[設定画面](docs/RDSH-SETTINGS.md)、
[構成図](docs/ARCHITECTURE.md)も用意しています。会話の委譲には本家の DSH が必要です。

## 動作環境

| 項目 | 内容 |
| --- | --- |
| OS | Linux、macOS、WSL、Windows（ネイティブ）。エージェントの隔離には Linux x86_64 + bubblewrap + prlimit が必要です。 |
| DSH 本体 | 会話には本家の `dsh` が必要です。実行アダプターが対応する監査済み版は 0.2.0-rc.2 です。 |
| Rust | ソースから作る場合のみ 1.85 以上が必要です。ビルド済みバイナリには Rust はいりません。 |
| 任意 | [Node.js ダッシュボード](dashboard/README.md)には Node.js 22 以上、`search-web` には SearXNG、正確な圧縮見積りには `zstd` CLI が必要です。 |

## インストール

いちばん手軽な方法（ビルド済み、Rust 不要）：

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

ソースから作る場合：

```sh
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
./install.sh                 # ビルドして ~/.local/bin/rdsh に入れます
./install.sh --as-dsh        # `dsh` 名でも使えるようにします（元は dsh-orig に退避）
./install.sh --restore       # 置き換えを元に戻します
./install.sh --prefix=DIR    # 入れ先を変えます（既定 ~/.local/bin）
```

install.sh は Linux / macOS / WSL 用です（WSL を自動検出、cargo がなければ
rustup で自動導入します。`--no-rustup` で止められます）。Windows ネイティブは install.ps1 です：

```powershell
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
.\install.ps1              # ビルドして %LOCALAPPDATA%\rdsh\bin に導入します（PATH 追加付き）
.\install.ps1 -AsDsh       # `dsh` 名でも使えるようにします（元は dsh-orig に退避）
.\install.ps1 -Restore     # 置き換えを元に戻します
.\install.ps1 -Wsl         # WSL 側にも install.sh で連動導入します
```

| OS | スクリプト | 備考 |
| --- | --- | --- |
| Linux / macOS | `./install.sh` | cargo か curl が必要です（rustup で自動導入）。 |
| WSL | ディストロ内で `./install.sh` | 自動検出します。ネイティブ併用は `install.ps1 -Wsl` です。 |
| Windows（ネイティブ） | `.\install.ps1` | Rust が必要です（`winget install Rustlang.Rustup`）。コンパイルには MSVC ビルドツールが必要です。 |

モデル未接続で初めて起動したときは、DeepSeek のプロンプトで止めずに設定の案内を出します。
`rdsh setup` を実行してください（`rdsh setup --login` なら Codex や opencode の
OAuth をその場で開きます）。直接作る場合は `cargo build --release` で
`target/release/rdsh` ができます。

## 使い方

### dsh 互換（委譲）

```sh
rdsh tui                          # dsh --profile tui と同じです（slim 環境変数付き）
rdsh --profile web --patch x.yml  # 追加設定を重ねて起動します
rdsh --passthrough tui            # slim なしで起動します（実行隔離は残ります）
rdsh --dry-run tui -- --resume abc  # 実行内容だけ表示します
```

slim は必要最小限の環境変数を足すだけです。本家が知らないキーは無視されます。
`--passthrough` は環境変数の調整を切り替えるだけで、実行隔離を外しません。
詳しくは[構成図](docs/ARCHITECTURE.md)を見てください。

### 高速コマンド（Node を起動しません）

```sh
rdsh tokens ./AGENTS.md             # 入力トークン見積りです（約4文字=1トークン、日本語などは1字1トークン）
echo ... | rdsh prune --max-tokens 4000   # 前後を残して予算内に切り詰めます
rdsh search TODO --dir . --max 100 # 再帰検索です（並列、出力順は逐次と同じ）
rdsh compact ./s.jsonl --max-tokens 8000 # セッション JSONL を圧縮します（元ファイルは不変）
rdsh sessions --limit 20 --tokens  # セッション一覧と展開後のトークン見積りです
rdsh logs --tail 50 --grep ERROR   # 起動ログの確認です
rdsh profiles / rdsh skills        # プロファイル・スキル一覧です
rdsh doctor                        # 本家 dsh・DSH_HOME・slim 設定の確認です
rdsh bench --n 5                   # rdsh と dsh の起動比較です
```

### 認証情報は明示的に取り込みます（`rdsh auth`）

他のツールで済ませたログインを、dsh が読む `$DSH_HOME/.credentials.yaml` へ写します。
`rdsh auth --import --provider openai-codex` を使います：

- Codex CLI（`~/.codex/auth.json`、ChatGPT OAuth）
- opencode（`$XDG_DATA_HOME/opencode/auth.json`、`openai` OAuth は `openai-codex` になります）

```sh
rdsh auth            # 状態確認です。見つかったログインと認識済みの一覧を出します
rdsh auth --import --provider openai-codex   # 不足・古い分だけ書きます（0600、他は不変）
rdsh auth --json     # 機械可読の状態出力です
rdsh setup           # 初回ウィザードです。取り込み、キー貼付、--login/--open に対応します
rdsh setup --web     # localhost の設定画面です（ブラウザが自動で開き、起動ごとの #key=... が必要）
```

起動・診断・setup は他のアプリの認証情報を勝手に写しません。
OAuth は `rdsh auth --import --provider openai-codex --source codex` のように
対象を選んで取り込み、API キーは `--ref OPENAI_API_KEY` で指定します。
一括取り込みと `RDSH_AUTH_AUTOSYNC` は使えません。`setup --yes` は環境変数の
既知キーの保存だけを許可し、外部ログインは取り込みません。

### 追加機能（初期状態では OFF）

サーバー型の機能は有効化するまで動きません。初期状態は高速な dsh として動きます。
設定画面（`rdsh setup --web` の追加機能欄）か CLI で有効にします：

```sh
rdsh settings set extras.enable serve,search-web
rdsh settings get extras.enable
```

| 機能 | コマンド | 備考 |
| --- | --- | --- |
| `serve` | `rdsh serve`（既定 :38080） | 手元の状態ページです。localhost のみ、起動ごとの鍵が必要です。 |
| `search-web` | `rdsh search-web "調べたい語" --limit 5` | SearXNG が必要です。 |

`rdsh serve` は dsh の Web GUI（:3080）と競合しません。`--port 0` で空きポートを使えます。
API とダッシュボードの詳しくは [Web UI](#web-ui) を見てください。

### エージェント実行の隔離

Linux x86_64 で bubblewrap・prlimit・監査済み DSH がそろった場合、モデルのツールは
`rdsh_inspect` に限ります。利用者が指定したファイルの写しだけを読み取り専用で渡し、
ネットワークとホスト・プロジェクトへの書き込みをカーネルで拒否します。
認証ストアやホストの環境変数は渡しません。隔離内の使い捨て一時領域は使えます。

```sh
rdsh --share-file README.md --share-file src/main.rs --profile tui
```

共有した内容はモデルへ渡ります。秘密を含むファイルは指定しないでください。
隠しファイル、リンク、複数のハードリンクを持つファイルは共有できません。
対応していない OS や DSH の版、変更されたツール実装、bubblewrap 不在では保護なしに動かさず止めます。
`--passthrough` は環境調整の切り替えだけで、隔離を外しません。
この保護は rustdsh 経由の新しいプロセスに適用されます。直接 DSH を起動した場合や
実行中のプロセスには適用されません。設定済みのプラグイン・プロファイルは信頼するコードとして扱います。

### hooks.json での使い方（`rdsh guard`）

標準入力（フック JSON または生テキスト）を走査し、拒否パターンに当たれば exit 2 と理由で止め、
当たらなければ exit 0 で通します。`--json` は止めるとき `{"decision":"block"}`、
当たらないとき `{}` を返します。当たらないことは実行の許可ではなく、ホスト側の権限確認が別に必要です。
パターンの `*` は任意文字列に当たります。起動約1ミリ秒・約3MB のため、毎回のフック費用はほぼゼロです。

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

コンテキスト生成は過去セッションを自動で取り込みません。旧設定の
`context.max_sessions` が正でも同じです。履歴は明示的な
`rdsh context search` で確認してください。

Unix の context と再帰 search は、ディレクトリハンドルを基準に各パスを開き、
リンク差し替え・複数のハードリンク・特殊ファイルを拒否します。
Windows では安全な実装が入るまで、ネイティブ search を拒否し、context の
ファイル読取りを省きます。

## `dsh` として使う

`dsh` 名で呼ばれたときの振舞いです。rdsh 固有の先頭サブコマンド
（`tokens`・`guard`・`serve`・`sessions`など）以外は、引数を変えずに本家へ exec 委譲します
（`dsh --version`・`dsh --profile tui`・`dsh --help` は完全互換）。探索順の詳しくは[構成図](docs/ARCHITECTURE.md)を見てください。

- 一時退避： `RDSH_PASSTHROUGH=1 dsh ...`（slim なし）、`RDSH_DRY_RUN=1 dsh ...`（実行内容のみ表示）
- 既定プロファイル： `RDSH_DEFAULT_PROFILE`、次にローカルの `tui`、なければ案内付きエラーです
- 注意： `dsh tokens` のようにプロファイル名が予約語と重なるときは `dsh --profile tokens` で起動してください
- `node "$(... dsh ...)"` 形式のスクリプトは置換中に壊れます。`dsh`・`rdsh` を直接実行してください。対象は `rdsh doctor` が一覧表示します

## Smart-DSH との併用

[Smart-DSH](https://github.com/hikarioyama/Smart-DSH)は DSH の web プロファイル用プラグイン集
（モバイル UI・Web Push 通知・Esc 停止）で、競合バイナリではありません。rdsh と共存できます。

```sh
rdsh doctor                                    # dsh のバージョンと Smart-DSH バンドルも表示します
rdsh --profile web --dump-config | grep notify-push   # 構成の読み取り確認です
rdsh plugin --profile web add /path/to/dsh-notify-push  # dsh plugin と同じです
rdsh --profile web                             # slim 環境変数付きで起動します（プラグインに影響なし）
```

併用時の注意点：

- ポートは競合しません。dsh Web GUI は 3080、`rdsh serve` は既定 38080 です（`--port 0` で自動選択）。
- 置換時は Smart-DSH の補助スクリプトに `dsh-orig` を使うか `DSH_PACKAGE_DIR` を指定します。
- `rdsh doctor` のバージョン表示で差異を先に確認できます。

## Web UI

DSHの会話GUIに読み取り専用のworkflow進捗ボードを追加する場合は、[対応sourceへの適用・診断ツール](plugins/workflow-board/README.ja.md)を隔離した対応checkoutに使います。boardと共通表示projectionを変更する18ファイルのpatch・fixtureテストを同梱し、patched DSHのbuild・採用は別工程です。

```sh
rdsh settings set extras.enable serve  # 有効な補助機能の一覧を置き換えます
rdsh serve
# 起動時に表示される #key=... 付き URL を開きます（localhost のみ）
# dsh Web GUI（:3080）と競合しません。--port 0 で自動選択もできます
```

| API | 内容 |
| --- | --- |
| `GET /api/version` | バージョン（キー不要） |
| `GET /api/doctor` | 状態確認 |
| `POST /api/tokens` | トークン推定（`{"text"}`） |
| `POST /api/prune` | 切り詰め（`{"text","max_tokens"}`） |
| `GET /api/bench?n=3` | 起動計測 |
| `GET /api/sessions?limit=20` | セッション一覧 |
| `GET /api/skills` / `/api/profiles` | 一覧 |

`GET /api/version` 以外の API は起動ごとの鍵が必要です。画面が URL から読み取り、
`X-RDSH-Token` ヘッダーで送ります。CDN 不要・オフラインで使えます。

手元の状態確認だけなら `serve` を有効化して `rdsh serve` を使います。
プロジェクトの指標・質問と回答・スマホ接続には [Node.js ダッシュボード](dashboard/README.md) を使います（Node.js 22 以上が必要です）。
`rdsh-dashboard project --project <ディレクトリ>` でプロジェクト用、`rdsh-dashboard harness` で元の Harness Web 画面を起動します。

Windows ネイティブ用の `rdsh-dashboard` ランチャーでは、`project`・`harness` が通知領域のトレイに常駐します。
右クリックの Open / 開く で画面を開き、Exit / 終了 でその Dashboard と管理対象の Harness を止めます。
止める対象の確認に失敗したときは終了せず、再試行できます。独立したセッションは続きます。
ダブルクリックでも画面を開けます。隠しアイコンに入れるかは Windows の通知領域設定で選びます。
端末に表示して動かす場合は `--no-tray` を付けてください。
導入・更新は `pwsh -NoProfile -ExecutionPolicy Bypass -File dashboard/install-windows.ps1` です。
このトレイは Node.js Dashboard 用です。`rdsh serve` は端末から起動します。

本家 Harness の更新通知は、実際の更新直後・更新時刻から 2時間ごと・ページの再読み込みで表示します。
Dismiss・X、または更新確認の成功でその回の通知を閉じます。閉じても 2時間の周期は続きます。
配布バイナリが変わっていない確認では、新しい更新通知を記録しません。
プロジェクトを切り替えてもその回は閉じたままで、次の 2時間枠で再表示します。
閉じる操作は同じ OS ユーザーの別ポートにも届きます。
新しいコードの適用時だけ通常の GUI 再起動・画面再読み込みが必要です。[ブラウザ検証](docs/evidence/update-notice-repeat/README.md)も参照してください。

## 実測

手元環境（Linux x86_64）での測定値です。条件をそろえた前後比較も含みます。

| 項目 | rdsh | 比較対象 | 倍率 |
| --- | --- | --- | --- |
| `--version` 起動（中央値、n=5） | 約0.90ms | 本家 dsh 約88ms | 約98倍 |
| `--version` メモリ（最大RSS） | 約2.9MB | 本家 約66MB | 約1/23 |
| フック相当処理のメモリ | 約2.7MB | node 同等 約45MB | 約1/16 |
| search（300ファイル・60万行） | 約17ms | 改修前 約41ms | 約2.4倍 |
| tokens（9.6MBテキスト） | 約12ms | 改修前 約35ms | 約2.9倍 |
| sessions --tokens（20件展開） | 約0.41秒 | 改修前 約1.65秒 | 約4.0倍 |
| 配布サイズ | 単一バイナリ約806KB | Node ツリー約508MB | — |

測定コマンドは `rdsh bench --n 5` と `/usr/bin/time -v` です。詳しくは[docs/BENCHMARKS.md](docs/BENCHMARKS.md)を見てください。

現在のソースには、検索の並列処理・メモリ使用量の改善、認証情報とツールの境界の強化、更新通知の 2時間ごとの再表示も含まれます。
高密度の検索フィクスチャでは中央値 197.77 ms から 4.61 ms でした。Linux の特定条件での測定です。
[測定の証拠](docs/evidence/performance-security-audit.md)とリリースノートを確認してください。
v0.2.0 公開後のソース修正は、その公開済みバイナリには含まれません。

## 安全設計

1. agent loop・profile boot の再実装はしません。`exec` 委譲のみです
2. slim は環境変数の追加だけです。本家が知らないキーは無視されます
3. `desktop` プロファイル拒否・dump 排他など本家のエラー条件を Rust 側でも再現します
4. 読取り系（tokens/search/compact/dump --native/serve API/inspect）は元ファイルを書き換えません
5. `--passthrough` は slim 調整を無効化します。`./install.sh --restore` で元の DSH へ戻す場合は rustdsh の保護も外れます

現在の checkout は `cargo test` と `tests/regress.sh`、[必須チェック](CONTRIBUTING.md)で検証します。
[再現可能な性能測定](docs/BENCHMARKS.md)では、入力と修正前後の出力一致も確認します。

## 資料

| 資料 | 内容 |
| --- | --- |
| [docs/USER-FLOW.md](docs/USER-FLOW.md) | 導入から設定・利用・復旧までの流れです。 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 委譲と設定管理、クレート構成です。 |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | 再現できる測定手順です。 |
| [docs/RDSH-SETTINGS.md](docs/RDSH-SETTINGS.md) | 設定画面と CLI キーです。 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 今後の方向性です。 |
| [docs/RELEASING.md](docs/RELEASING.md) | リリース手順です。 |
| [CHANGELOG.md](CHANGELOG.md) | バージョンごとの主な変更です。 |

## コミュニティ

- まず [CONTRIBUTING.md](CONTRIBUTING.md)（PR は 4行、スクリーンショット規定）を見てください。
- バグ・要望：[Issue フォーム](https://github.com/jimoto-no-llm/rustdsh/issues/new/choose)（日本語 OK）です。
- 質問・相談：[Issues](https://github.com/jimoto-no-llm/rustdsh/issues) です。
- 脆弱性は公開 Issue に書かず [SECURITY.md](SECURITY.md) を見てください。
- 支援：[SUPPORT.md](SUPPORT.md) です。行動規範：[Code of Conduct](CODE_OF_CONDUCT.md) です。

## よくある質問

- ポートが使用中と言われる：dsh Web GUI は 3080、`rdsh serve` は既定 38080 です。`--port 0` で空きポートを使えます
- プロファイル名がサブコマンドと重なる：`dsh --profile <name>` 形式で起動してください
- 元に戻したい：`./install.sh --restore`（退避した本家を復元します）
- `--tokens` の `?` 付き表示：zstd CLI がない環境では圧縮サイズからの概算である印です

## 謝辞

本家 DeepSeek Harness の開発者・貢献者の皆さんに感謝します。本家のランタイムが rustdsh の基盤です。

アイコン制作：[PENTACoXIAN](https://x.com/PENTACoXIAN)。

- [GrEarl](https://github.com/GrEarl)、[PENTACoXIAN](https://x.com/PENTACoXIAN)：脆弱性の報告・セキュリティレビューです。
- [StudioYebisu](https://github.com/yebisu0529-ship-it)、[RNA4219](https://github.com/RNA4219)、[eightman999](https://github.com/eightman999)：実装・改善・問題の報告です。
- [@remydre8](https://x.com/remydre8)：アイディアと製品提案です。

Issue、レビュー、検証を通じて協力してくださる皆さんにも感謝します。

## ライセンス

MIT（[LICENSE](LICENSE)）です。本家 DeepSeek Harness と依存ライブラリにはそれぞれのライセンスが適用されます。
