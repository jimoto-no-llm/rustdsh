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

`rdsh` は、[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) を高速かつ安全に利用するための Rust 製ランチャーです。
日常的によく使う処理（トークン計算、検索、セッション管理など）をネイティブ化し、エージェントの会話やモデル実行は本家の `dsh` へそのまま透過的に委譲します。今お使いの引数やオプションはそのまま動きます。

## rdsh を選ぶ理由

- ⚡ **超高速・省メモリ起動**: 起動時間は約0.9ms、メモリ消費は約2.9MB。Node.js を立ち上げる本家 `dsh`（約88ms / 約66MB）と比較して圧倒的に軽量です。
- 🔄 **完全な互換性（Drop-in Replacement）**: `rdsh` 独自のサブコマンド以外は本家 `dsh` にそのまま渡すため、既存のスクリプトや使い慣れたオプションがそのまま動作します。
- 🛠 **便利な高速ネイティブコマンド**: トークン見積り、並列コード検索、セッション一覧・圧縮、環境診断（`doctor`）などを Node.js なしで瞬時に実行できます。
- 🛡 **安全設計**: 読み取り系コマンドは元ファイルを一切書き換えず、認証情報の無断外部送信も行いません。Linux 環境では、エージェントツールを明示的に共有したファイルだけに限定できます。

## 目次

- [クイックスタート](#クイックスタート)
- [動作環境](#動作環境)
- [インストール](#インストール)
- [使い方](#使い方)
  - [`dsh` 互換での実行](#dsh-互換での実行)
  - [高速ネイティブコマンド](#高速ネイティブコマンド)
  - [選択した認証情報だけを共有する](#選択した認証情報だけを共有するrdsh-auth)
  - [エージェント実行の安全な隔離](#エージェント実行の安全な隔離)
  - [フック監視](#フック監視-rdsh-guard)
  - [コンテキスト注入](#コンテキスト注入rdsh-context)
  - [依存グラフと変更影響](#依存グラフと変更影響rdsh-deps)
- [Web UI とダッシュボード](#web-ui-とダッシュボード)
- [Smart-DSH との併用](#smart-dsh-との併用)
- [実測ベンチマーク](#実測ベンチマーク)
- [安全設計](#安全設計)
- [よくある質問](#よくある質問)
- [資料](#資料)
- [コミュニティ](#コミュニティ)
- [謝辞](#謝辞)
- [ライセンス](#ライセンス)

## クイックスタート

### 1. インストール（ビルド済みバイナリ）

**Linux / macOS / WSL**:

```sh
curl -fsSL https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

**Windows (PowerShell)**:

```powershell
$f = Join-Path $env:TEMP 'rdsh-install.ps1'
Invoke-WebRequest -Uri https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/install.ps1 -OutFile $f -UseBasicParsing
& $f -FromRelease
```

### 2. 環境確認 & 初期セットアップ

```sh
rdsh --version && rdsh doctor   # 導入と本家 dsh の確認
rdsh setup                      # 対話式セットアップ（または rdsh setup --web でブラウザから設定）
```

※ Codex CLI（ChatGPT OAuth）や opencode のログイン情報がある場合、`rdsh auth --import --provider openai-codex` で簡単に取り込めます。

### 3. 会話を開始する

```sh
rdsh tui                        # TUI プロファイルで起動
# または
rdsh --profile web              # Web プロファイルで起動
```

## 動作環境

| 項目 | 内容 |
| --- | --- |
| OS | Linux、macOS、WSL、Windows（ネイティブ） |
| DSH 本体 | エージェントとの会話実行に必要です（トークン計算や検索などの独立ツールは単体で動作します） |
| Rust | ビルド済みバイナリを利用する場合は不要。ソースからビルドする場合のみ 1.85 以上 |
| 任意 | [Node.js ダッシュボード](dashboard/README.md) には Node.js 22 以上、`search-web` には SearXNG が必要 |

## インストール

### ソースからのビルドと高度なオプション

**Linux / macOS / WSL**:

```sh
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
./install.sh                 # ビルドして ~/.local/bin/rdsh にインストール
./install.sh --as-dsh        # `dsh` コマンド名でも使えるように置き換え（元は dsh-orig に退避）
./install.sh --restore       # 置き換えを元に戻す
./install.sh --prefix=DIR    # インストール先を変更（既定: ~/.local/bin）
```

**Windows (PowerShell)**:

```powershell
git clone https://github.com/jimoto-no-llm/rustdsh.git
cd rustdsh
.\install.ps1              # ビルドして %LOCALAPPDATA%\rdsh\bin にインストール
.\install.ps1 -AsDsh       # `dsh` コマンド名でも使えるように置き換え
.\install.ps1 -Restore     # 置き換えを元に戻す
.\install.ps1 -Wsl         # WSL 側にも連動してインストール
```

| OS | スクリプト | 備考 |
| --- | --- | --- |
| Linux / macOS | `./install.sh` | cargo か curl が必要です（rustup がない場合は自動案内されます）。 |
| WSL | ディストロ内で `./install.sh` | WSL を自動検出します。Windows 側と併用する場合は `install.ps1 -Wsl` も利用可能です。 |
| Windows（ネイティブ） | `.\install.ps1` | Rust および MSVC ビルドツールが必要です（`winget install Rustlang.Rustup`）。 |

## 使い方

### `dsh` 互換での実行

普段使っている `dsh` と同じ引数でそのまま動きます：

```sh
rdsh tui                          # dsh --profile tui と同等
rdsh --profile web --patch x.yml  # 追加設定を重ねて起動
rdsh --dry-run tui -- --resume id # 実行コマンドの内容だけを確認
```

`./install.sh --as-dsh` で導入した場合は、`dsh` コマンドを実行するだけで自動的に `rdsh` の高速起動が適用されます。

### 高速ネイティブコマンド

Node.js を起動せず、Rust ネイティブで高速に処理します：

```sh
rdsh tokens ./README.md             # トークン数の即時見積り（英語:約4文字=1tok、日本語:1文字=1tok）
echo "..." | rdsh prune --max-tokens 4000 # トークン上限に合わせて前後を残して切り詰め
rdsh search TODO --dir . --max 100  # 高速並列テキスト検索
rdsh sessions --limit 20 --tokens   # 過去セッション一覧と展開トークン見積り
rdsh compact ./s.jsonl              # セッション JSONL を圧縮（元ファイルは不変）
rdsh doctor                         # 本家 dsh、環境変数、パスなどの健全性診断
rdsh profiles / rdsh skills         # 利用可能なプロファイル・スキル一覧
rdsh desktop status                 # DeepSeek Harness Desktop アプリとプロファイルの検出
rdsh bench --n 5                    # rdsh と本家 dsh の起動速度比較
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

dsh が同梱していない OpenAI 互換エンドポイント（HAI、Sarashina、自宅の llama.cpp / vLLM / LM Studio / Ollama など）は、プロファイルのルートとして追加できます：

```sh
rdsh provider add hai --model deepseek-v4-flash              # 鍵は HAI_API_KEY か --key-stdin
rdsh provider add sarashina                                  # 鍵は SARASHINA_API_KEY。mini と nano は組み込み
rdsh provider add local-openai --base-url http://host:8080/v1 --discover --no-key
rdsh provider list                                           # プリセットと各プロファイルの設定・鍵の状態
```

詳細は [docs/PROVIDERS.md](docs/PROVIDERS.md)（英語）を参照してください。

### エージェント実行の安全な隔離

委譲したエージェントツールは既定で通常のファイル読み書きができます。Linux（bubblewrap と prlimit がある環境）では `--share-file` で明示的に共有したファイルだけに限定されます：

```sh
rdsh --share-file README.md --share-file src/main.rs --profile tui
```

共有ファイルは読み取り専用でマウントされ、ネットワークアクセスもありません。`rdsh features on agent_tool_sandbox` で常時有効化、`rdsh features off agent_tool_sandbox` で無効化、`RDSH_SECURITY=1` で強制できます。

### フック監視 (`rdsh guard`)

DSH の `hooks.json` と連携し、危険なコマンド実行を瞬時に検知・遮断します：

```sh
echo "$input" | rdsh guard --deny "rm -rf /*" --deny "*token*"
```

対応するファイル操作を構造で判定する場合は、任意でpolicy fileを指定できます。
次の例は、既存のプロジェクトディレクトリ内の `Read` だけを分類上許可します。

```json
{
  "schema": 1,
  "rules": [
    { "id": "project-read", "tool": "Read", "access": "read", "roots": ["/absolute/project/path"] }
  ]
}
```

```sh
echo "$hook_json" | rdsh guard --policy-file ./hook-policy.json --json
```

構造判定が対応するのは `Read`・`Write`・`Edit` のファイルpath schemaです。
作業ディレクトリと対象pathを正規化し、toolとread/write範囲を既存rootに照合して、
秘密を含まない理由とともに `allow`・`deny`・`unknown` を返します。JSONの `allow` は分類結果だけで、
ホストのpermission/approvalを意味しません。そのため `decision` は出力せず、最終的な権限判断はホストに残します。
未知のtool、shell command、壊れた入力、未対応の引数はfail closedです。shell構文解析とnetwork先の判定は未対応です。
path判定後にファイルシステムが変わる競合もあり、このhookはOS sandboxではありません。実際の強制には実行sandboxを使ってください。

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "rdsh guard --deny \"rm -rf /*\"" }] }
    ]
  }
}
```

### コンテキスト注入（`rdsh context`）

`rdsh context inject` は、そのターンの文脈（goal・constraints・decisions・作業対象ファイル・
Git 状態・検索結果・管理された記憶）を組み立て、DSH の `UserPromptSubmit` フック契約で
出力します。コピペなしでモデルに届きます。

```sh
rdsh features on context_engine        # コンテキストエンジンはオプトイン
rdsh context hook install              # $DSH_HOME/hooks.json に追記（冪等）
rdsh context hook status --json
```

フックは fail-open で、プロンプトを止めず常に exit 0 です。無出力になるのは設定ファイルが読めない場合と
stdin を解釈できない場合だけで、壊れた索引や期限超過では依存グラフやコード検索だけを落として
goal・constraints・記憶は出し続けます。注入には専用の予算（`context.inject_budget`、既定1200トークン）と
期限（`context.inject_deadline_ms`、既定1200ms）があり、期限を過ぎたらコード検索を省略して
記憶・goal・constraints だけを出します。

記憶は会話ログの丸写しではなく、管理された項目です。

```sh
rdsh context remember "APIの互換性を必ず保つ" --kind constraint
rdsh context distill --session ~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd --apply
rdsh context memory --json      # active と superseded を区別して表示
rdsh context forget mem_ab12cd34ef56
```

`distill` はユーザー発話だけを読み（zstd 圧縮セッションにも対応）、決定・制約・撤回を
決定的なマーカーで抽出します。重なる古い項目は推測ではなく `superseded_by` で無効化されます。
`rdsh context build --require-stable` は、スナップショットが安定していると証明できないとき
（組み立て中にファイルや git 状態が変わった、または git 状態を読めない）に exit 3 で終了し、
古い・不明なスナップショットを新しいものと誤認させません。

### 依存グラフと変更影響（`rdsh deps`）

```sh
rdsh deps build                    # $DSH_HOME/rdsh-index に増分索引を作る
rdsh deps query engine_score       # シンボルの定義元と参照元
rdsh deps impact src/context.rs    # 直接・推移的な依存元と影響するテスト
```

抽出は Rust・JavaScript/TypeScript・Python・Go に対応し、ファイルごとに import・定義・
静的な呼び出し箇所を記録します。size と mtime が同じファイルは再解析しないため、
繰り返し実行しても速いままです。これは静的近似です。動的 dispatch・間接呼び出し・マクロ・
生成コードは `unknown` として明示し、未解決件数として報告します（推測で埋めません）。
索引が無い場合は「情報が無い」であり「依存が無い」ではありません。

索引があるときは `rdsh context build` と `rdsh context inject` も、検索で当たったファイルの
依存近傍を取り込みます。抜粋が、実際に依存しているファイルと一緒に届きます。
Rust ネイティブ処理のため、呼び出しごとのオーバーヘッドは約1msと非常に軽量です。

<a id="web-ui"></a>

## Web UI とダッシュボード

### 内蔵 Web UI (`rdsh serve`)

手元で状態確認やトークン見積もりを行える軽量な Web 画面です（既定ポート `:38080`、本家の `:3080` と競合しません）：

```sh
rdsh settings set extras.enable serve  # 機能を有効化
rdsh serve                             # 起動（ローカルホスト限定、一時トークンで保護）
```

### 拡張ダッシュボード (`rdsh-dashboard`)

プロジェクト全体の稼働状況、質問・回答の確認、モバイル端末からの接続などを行える拡張ダッシュボードです（要 Node.js 22+）：

```sh
rdsh-dashboard project --project <ディレクトリ>
```

※ Windows ネイティブではタスクトレイに常駐し、タスクバーから簡単に開閉できます（端末起動したい場合は `--no-tray` を指定）。詳細は [dashboard/README.md](dashboard/README.md) をご覧ください。外部エージェント CLI（cursor-agent、devin）を監視付きジョブとして実行できます（[docs/AGENT-RUNNERS.md](docs/AGENT-RUNNERS.md)、英語）。

## デスクトップアプリ (Electron)

DeepSeek Harness Desktop は、Web アプリケーション全体を内包した Electron シェルです。CLI と `$DSH_HOME` を共有しますが、**予約済みプロファイル**（`$DSH_HOME/profiles/desktop`）と同梱の独自コマンドランタイムを持つため、npm の `dsh` CLI ではプラグインを管理できません。`rdsh desktop` はこれらを自動検出し、プラグインの組み込みをアプリ自身のコマンドへ転送します。rdsh 側でプロファイルを起動したり直接書き換えたりすることはありません：

```sh
rdsh desktop status                 # アプリ、コマンドランタイム、プロファイル、プラグインの状態（読み取り専用）
rdsh desktop install --plugins-dir .   # desktop プロファイルに rdsh-settings を組み込み
rdsh desktop install --plugins-dir . --compute   # 常駐 compute bridge もあわせて追加
rdsh desktop verify                 # プロファイルに rdsh プラグインがない場合は 0 以外で終了
```

プロファイルインストーラーや各種インストーラーからも同様に利用できます：

```sh
PROFILE=desktop ./plugins/install.sh   # 推奨パッケージをすべて適切に転送して導入
./install.sh --desktop                 # インストール時に rdsh プラグインを組み込み
```

※ プラグインを組み込む前にアプリを終了し、完了後に再起動してください。アプリ内の Plugins 画面からも、コマンドを使わずに同じパッケージをインストールできます。Electron ランタイム自体が置き換わることはなく、アプリ内の処理委譲はオプトインかつフェイルオープンな compute bridge に限定されます。詳細は [DESKTOP-INTEGRATION.md](docs/DESKTOP-INTEGRATION.md) をご覧ください。

## Smart-DSH との併用

[Smart-DSH](https://github.com/hikarioyama/Smart-DSH)（Web プロファイル向けプラグイン集）と問題なく共存できます：

```sh
rdsh doctor                                    # dsh のバージョンと Smart-DSH バンドルを確認
rdsh plugin --profile web add /path/to/bundle  # プラグインの追加（dsh plugin と同等）
rdsh --profile web                             # プラグイン付きで起動
```

ポート番号（DSH Web: `3080`、rdsh serve: `38080`）も競合しません。

rdsh が同梱するのは Smart-DSH のスマホ幅レイアウトだけです
（[`plugins/rdsh-mobile-ui`](plugins/rdsh-mobile-ui/README.md)、MIT・Smart-DSH 由来）。
767px 以下でチャットと入力欄が全幅になり、ロゴを1タップするとセッション一覧が開きます。
Smart-DSH の通知・Esc 停止・タスクハブ・HMR 回避策は上流バンドルのままなので、必要な場合は
上流のバンドルを導入してください。

## 実測ベンチマーク

Linux x86_64 環境での測定値です：

| 項目 | rdsh | 本家 dsh / 従来処理 | 差・倍率 |
| --- | --- | --- | --- |
| `--version` 起動時間 | **約0.90 ms** | 約88 ms | **約98倍高速** |
| `--version` メモリ消費（最大RSS） | **約2.9 MB** | 約66 MB | **約1/23に削減** |
| フック相当処理のメモリ | **約2.7 MB** | 約45 MB (Node相当) | **約1/16に削減** |
| コード検索 (`search`) | **約17 ms** | 約41 ms | **約2.4倍高速** |
| トークン計算 (`tokens`) | **約12 ms** | 約35 ms | **約2.9倍高速** |
| セッション展開 (`sessions --tokens`) | **約0.41 秒** | 約1.65 秒 | **約4.0倍高速** |
| 配布バイナリサイズ | **約1.97 MB** (単一バイナリ) | 約508 MB (Nodeツリー) | **超軽量** |

※ 測定コマンドは `rdsh bench --n 5` など。再現手順や詳細な内訳は [docs/BENCHMARKS.md](docs/BENCHMARKS.md) をご覧ください。

## 安全設計

1. **本家挙動の透過性**: 会話ループやモデル推論は独自実装せず、すべて本家 `dsh` に委譲して互換性を担保します。
2. **非破壊設計**: トークン計算、検索、ログ圧縮などの読み取り系コマンドは、既存のファイルを一切変更しません。
3. **明示的な認証管理**: 他アプリの認証情報を無断で同期・送信せず、利用者が明示的に指定したものだけを取り込みます。
4. **サンドボックス隔離**（オプトイン）: Linux 環境では、`--share-file` で共有したファイルだけを読み取り専用・ネットワークなしで渡すため、ホストの他の領域には触れません。

## よくある質問

- **Q. 本家 `dsh` は必要ですか？**  
  会話やモデル実行には本家 `dsh` が必要です。トークン計算、ファイル検索、環境診断（`rdsh doctor`）などのユーティリティコマンドは `rdsh` 単体でも動作します。

- **Q. 既存の `dsh` コマンドと置き換えて使えますか？**  
  はい。`./install.sh --as-dsh`（Windows では `.\install.ps1 -AsDsh`）で導入すると、普段の `dsh` コマンドで自動的に高速起動されます。元に戻す場合は `--restore` オプションですぐに復元できます。

- **Q. ポート番号が衝突したときは？**  
  本家 DSH の Web GUI（`:3080`）と `rdsh serve`（`:38080`）は既定ポートが異なります。空きポートを自動選択したい場合は `--port 0` を指定してください。

- **Q. 既存のスクリプトは壊れませんか？**  
  `rdsh` 固有のコマンド以外は、指定したすべての引数をそのまま本家 `dsh` に引き渡すため、既存のスクリプトや CI パイプラインはそのまま動きます。

## 資料

| 資料 | 内容 |
| --- | --- |
| [docs/USER-FLOW.md](docs/USER-FLOW.md) | 導入から設定・利用・復旧までの全体フロー |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 委譲の仕組みとアーキテクチャ設計 |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | ベンチマークの詳細と再現手順 |
| [docs/RDSH-SETTINGS.md](docs/RDSH-SETTINGS.md) | 設定画面の機能と CLI キー一覧 |
| [docs/DESKTOP-INTEGRATION.md](docs/DESKTOP-INTEGRATION.md) | デスクトップアプリ (Electron) との連携 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 今後の開発ロードマップ |
| [docs/RELEASING.md](docs/RELEASING.md) | リリース手順 |
| [docs/SERIAL-PROXY.md](docs/SERIAL-PROXY.md) | 同時リクエスト数制限プロキシ |
| [CHANGELOG.md](CHANGELOG.md) | バージョンごとの主な変更履歴 |

## コミュニティ

- コントリビューション：[CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。
- Rust開発環境：[Rust開発ガイド](docs/RUST-DEVELOPMENT.md) をご覧ください。
- バグ報告・要望：[Issue フォーム](https://github.com/jimoto-no-llm/rustdsh/issues/new/choose)（日本語 OK）へお寄せください。
- セキュリティ脆弱性報告：公開 Issue ではなく [SECURITY.md](SECURITY.md) に記載の手順でご報告ください。
- サポート：[SUPPORT.md](SUPPORT.md) / 行動規範：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 謝辞

本家 DeepSeek Harness の開発者およびコントリビューターの皆様に感謝します。本家のランタイムが rustdsh の基盤です。

- アイコン制作: [PENTACoXIAN](https://x.com/PENTACoXIAN)
- セキュリティレビュー・脆弱性報告: [GrEarl](https://github.com/GrEarl)、[PENTACoXIAN](https://x.com/PENTACoXIAN)
- 実装・改善・検証協力: [StudioYebisu](https://github.com/yebisu0529-ship-it)、[RNA4219](https://github.com/RNA4219)、[eightman999](https://github.com/eightman999),[cyrne1-7208](https://github.com/cyrne1-7208)
- アイディア・製品提案: [@remydre8](https://x.com/remydre8)

rdsh が利用・改変・推薦している第三者製 DSH プラグインです（いずれも MIT、著作権は各作者に帰属します）:

- [Smart-DSH](https://github.com/hikarioyama/Smart-DSH)（hikarioyama）—
  [`rdsh-mobile-ui`](plugins/rdsh-mobile-ui/README.md) として同梱するスマホ幅レイアウト
- [dsh-sound-notifications](https://github.com/cwd514/dsh-sound-notifications)（cwd514）—
  オプトインの効果音とデスクトップ通知（`SOUND=1`）
- [dsh-gitview](https://github.com/yugapor/dsh-gitview)（yugapor）— 任意のサイドバー Git パネル

## ライセンス

MIT（[LICENSE](LICENSE)）です。本家 DeepSeek Harness および依存ライブラリにはそれぞれのライセンスが適用されます。
