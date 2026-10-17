<img src="assets/icon.png" width="96" alt="rdsh icon">

[English](README.md) · [简体中文](README.zh-CN.md)

# rdsh — `dsh` を速く・安全に起動する Rust 製ランチャー

[![ci](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/ci.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/ci.yml)
[![dashboard](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/dashboard.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/dashboard.yml)
[![docs](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/docs.yml/badge.svg)](https://github.com/jimoto-no-llm/rustdsh/actions/workflows/docs.yml)
[![codecov](https://codecov.io/gh/jimoto-no-llm/rustdsh/graph/badge.svg)](https://codecov.io/gh/jimoto-no-llm/rustdsh)
[![release](https://img.shields.io/github/v/release/jimoto-no-llm/rustdsh.svg)](https://github.com/jimoto-no-llm/rustdsh/releases)
[![crates.io](https://img.shields.io/crates/v/rdsh.svg)](https://crates.io/crates/rdsh)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![rust](https://img.shields.io/badge/rust-1.85%2B-orange.svg)](https://www.rust-lang.org/)

[English](README.md)

独立したコミュニティプロジェクトです。DeepSeek や DeepSeek Harness の公式ではありません。

`rdsh` は、[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) を高速かつ安全に利用するための Rust 製ランチャーです。
日常的によく使う処理（トークン計算、検索、セッション管理など）をネイティブ化し、エージェントの会話やモデル実行は本家の `dsh` へそのまま透過的に委譲します。現在お使いの引数やオプションもそのまま動作します。

## rdsh を選ぶ理由

- ⚡ **ミリ秒未満のプロセス起動**: `rdsh --version` は約0.9ms・最大RSS約2.9MBで起動します（本家 `dsh --version` は約88ms・約66MB）。これはプロセス起動のみの数値です。プロファイルを起動したエージェントセッション自体は本家 `dsh`（Node.js）がそのまま動作するため、対話時の起動時間やメモリ消費量は本家と同等です。詳細は[実測ベンチマーク](#実測ベンチマーク)を参照してください。
- 🔄 **完全な互換性（Drop-in Replacement）**: `rdsh` 独自のサブコマンド以外は本家 `dsh` にそのまま渡すため、既存のスクリプトや使い慣れたオプションがそのまま動作します。
- 🛠 **便利な高速ネイティブコマンド**: トークン見積り、並列コード検索、セッション一覧・圧縮、環境診断（`doctor`）などを Node.js なしで瞬時に実行できます。
- 🛡 **安全設計**: 読み取り系コマンドは元ファイルを一切書き換えず、認証情報の無断外部送信も行いません。Linux 環境では、エージェントツールがアクセスできる対象を明示的に共有したファイルだけに限定できます。

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
- [低スペック環境向け](#低スペック環境向け)
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

**Claude Code／Codex／Cursor／VS Code Copilot／OpenCode／Gemini CLI を利用中の方へ**：
現在お使いのエージェントを利用しながら、
[MCP でダッシュボードを追加](docs/MCP-CLIENTS.md)できます。
タスク・質問・構造化 UI の共有には Node.js 22 以上が必要です。DSH 本体と Rust の導入は任意です。

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

crates.io からもインストールできます（Rust 1.85 以上が必要です）：

```sh
cargo install rdsh
```

`cargo install` はソースからビルドし、リリースアーカイブと同じバイナリをインストールします。
Debian / Ubuntu や Fedora / RHEL では、リリースの [`.deb` / `.rpm`](#ネイティブパッケージdeb--rpm) を `apt` / `dnf` で導入することもできます。

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

### ネイティブパッケージ（`.deb` / `.rpm`）

Debian / Ubuntu（WSL を含む）や Fedora / RHEL 系の Linux x86_64 では、同じ
リリースバイナリを OS のパッケージマネージャーで導入できます。
[最新リリース](https://github.com/jimoto-no-llm/rustdsh/releases/latest) から
`.deb` または `.rpm` をダウンロードし、そのファイルを直接インストールします。
リポジトリの追加は不要です。

```sh
sudo apt install ./rdsh_<version>_amd64.deb      # Debian / Ubuntu / WSL
sudo dnf install ./rdsh-<version>-1.x86_64.rpm   # Fedora / RHEL / Rocky / AlmaLinux
```

`<version>` はリリースタグから先頭の `v` を除いた値です（`v0.6.0` なら `0.6.0`）。
パッケージは `/usr/bin/rdsh` とライセンス・README を配置するため、導入直後から
Rust ツールチェーンや `install.sh` なしで `rdsh --version` が動きます。中身は
`rdsh-linux-x64.tar.gz` と同じ glibc ビルドなので、古いディストロでは musl
アーカイブと `install.sh` を引き続き使ってください。

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

### パッケージマネージャでの導入（Homebrew / Scoop / winget）

macOS／Windows の上級者向けに、パッケージマネージャへ `rdsh` の管理を任せる導線も用意しています。[packaging/](packaging/README.md) のマニフェストは公開済みリリースのアーカイブと SHA-256 を固定しており、インストールコマンドと更新手順は [docs/PACKAGE-MANAGERS.md](docs/PACKAGE-MANAGERS.md) にまとめています。

**macOS（Homebrew）** — Apple Silicon／Intel のアーカイブを自動で選んでインストールします：

```sh
brew install --formula ./packaging/homebrew/rdsh.rb
```

**Windows（Scoop）**:

```powershell
scoop install https://raw.githubusercontent.com/jimoto-no-llm/rustdsh/main/packaging/scoop/rdsh.json
```

**Windows（winget）** — winget 1.6 以降は3つのマニフェストを直接読み込みます。`microsoft/winget-pkgs` への提出は手動のままです：

```powershell
winget install --manifest .\packaging\winget
```

これらのチャネルは1リリースずつ固定されるため、新しいタグは `python3 scripts/update-packaging-manifests.py --version vX.Y.Z` を実行するまで反映されません。

## 使い方

### `dsh` 互換での実行

普段使っている `dsh` と同じ引数でそのまま動作します：

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

Windows では親ジャンクションを安全に拒否する読み込み処理が用意できるまで、圧縮履歴を開きません。
そのため、`sessions --tokens` の合計には一部の履歴が含まれず、正確な値にはなりません。

### 選択した認証情報だけを共有する（rdsh auth）

Codex、OpenCode、環境変数の認証情報を、秘密値を含めずに一覧表示します。
共有元と credential を選ぶまではコピーを行いません。取り込み先は DSH 本来の
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
boot、dump-config、plugin、dsh 名での委譲、setup の実行時にも、その共有元から
同期します。--importはすぐに取り込みます。別CLIの未選択トークンが
新しくても採用されません。DSH 側の新しい grant や既存の API-key 記録・ref、
その他のエントリ、コメント、改行形式は保持されます。Unix の認証ファイルと
選択ファイルは 0600 で保存されます。

対象は Codex の ~/.codex/auth.json、OpenCode の
$XDG_DATA_HOME/opencode/auth.json（未設定時は OS の data ディレクトリ）と
旧 ~/.config/opencode/auth.jsonです。OpenCodeのopenaiログインはDSHの
openai-codex へ対応付けるため、選択名は opencode:openai-codex となります。
環境変数の保存対象は DEEPSEEK_API_KEY、OPENAI_API_KEY、ANTHROPIC_API_KEY です。
一覧の表示は形式と存在の確認であり、実際の認証成功を意味するものではありません。

すでに渡されている環境変数は、DSH とその子プロセスに引き継がれます。
この経路では rdsh はファイルを書き込まず、JSON に persistent=false、
共有先、停止・失効手順を表示します。保存する場合は別途選択してください。
setup --yesだけでは全環境キーを保存しません。対話setupやWeb画面での
個別の保存は引き続き可能です。

**利用範囲と解除:** 保存した内容は、同じ DSH_HOME の全プロファイルで
利用できます。選択を解除すると将来の rdsh による取り込みが停止しますが、保存済みのコピーや
実行中のプロセスはそのまま残ります。コピーの利用を停止するには、DSH を停止したうえで
認証ファイル内の該当する record/ref を削除してください。credential 自体を失効させるには、
provider 側で OAuth grant を取り消すか、API キーを更新してください。
その際、共有元の CLI も利用できなくなる場合があります。これは rdsh によるコピーの制御であり、
DSH 自身の更新や環境変数の継承、OS sandbox を制御するものではありません。

**従来版からの移行:** 既存の DSH 認証情報はそのまま保持されます。選択ファイルが
なければ何も選択せず、従来のauth --importも選択を要求します。
RDSH_AUTH_AUTOSYNC=1 を設定しても全取り込みの挙動に戻ることはありません。一覧と preview で
確認のうえ、必要な共有元を選択してください。RDSH_AUTH_AUTOSYNC=0 では
選択を残して自動同期だけを止めます。明示したauth --importは実行できます。
破損している、または読み込めない選択ファイルが存在する場合は、同期を停止します。

選択の変更と rdsh による認証情報の書き込みは共通の lock で直列化され、解除完了後に古い選択内容で
取り込まれるのを防ぎます。writer の異常終了などによって lock が残った場合は、
rdsh auth や setup による書き込み処理が動作していないことを確認したうえで、
$DSH_HOME/.rdsh-auth-sharing.lockを除去してください。lock中は
launcher が取り込みをスキップします。

setup --webは毎回アクセス鍵を発行し、#key=...付きURLを表示します。
情報の読み取り、キーの保存、プロセスの終了には同じ鍵が必要です。URL を第三者と共有しないでください。
Web 画面では保存を行う前に、保存先や利用範囲、ならびに選択解除・コピー削除・provider での失効の
違いを確認できます。

一度だけ取り込む場合は `rdsh auth --import --provider openai-codex --source codex` または `rdsh auth --import --ref OPENAI_API_KEY --source codex` を使用できます。この指定は継続コピーの選択内容には保存されず、既存の共有方針も変更しません。継続して同期する場合は、別途 `--select` で指定します。

### 追加機能（初期状態では OFF）

サーバー型の機能は有効化するまで動作しません。初期状態では高速な dsh として動作します。
設定画面（`rdsh setup --web` の追加機能欄）または CLI で有効化します：

```sh
rdsh settings set extras.enable serve,search-web
rdsh settings get extras.enable
```

| 機能 | コマンド | 備考 |
| --- | --- | --- |
| `serve` | `rdsh serve`（既定 :38080） | 手元の状態ページです。localhost のみ、起動ごとの鍵が必要です。 |
| `search-web` | `rdsh search-web "調べたい語" --limit 5` | SearXNG が必要です。 |

`rdsh serve` は dsh の Web GUI（:3080）と競合しません。`--port 0` で空きポートを利用できます。
API とダッシュボードの詳細については [Web UI](#web-ui) を参照してください。

dsh が同梱していない OpenAI 互換エンドポイント（HAI、Sarashina、ローカル環境の llama.cpp / vLLM / LM Studio / Ollama など）は、プロファイルのルートとして追加できます：

```sh
rdsh provider add hai --model deepseek-v4-flash              # 鍵は HAI_API_KEY か --key-stdin
rdsh provider add sarashina                                  # 鍵は SARASHINA_API_KEY。mini と nano は組み込み
rdsh provider add local-openai --base-url http://host:8080/v1 --discover --no-key
rdsh provider list                                           # プリセットと各プロファイルの設定・鍵の状態
```

詳細は [docs/PROVIDERS.md](docs/PROVIDERS.md)（英語）を参照してください。

### モデル一覧の同期 (`rdsh models`)

DeepSeek Harness は「対象のプロバイダがどのモデルを扱えるか」を、依存パッケージ
`@earendil-works/pi-ai` に同梱されたカタログに基づいて判定します。このカタログはパッケージの
公開時に生成されるため、それ以降にプロバイダ側で変更された内容はモデル選択に反映されません
（例: Codex の `gpt-6.1-sol` が完全に欠落している、Kimi Code の `kimi-for-coding` が
"K2.8 Preview" に昇格済みであるにもかかわらず古い表示名のまま残っている、など）。プロファイル側で `models:` を
明示している場合は、その一覧が同梱カタログを上書きするため、この問題がより顕著になります。
`rdsh models` はプロバイダ自身のカタログ（ローカルの Codex CLI、または Kimi Code の
`/v1/models` からプロファイルの API キーを使って取得）を読み込み、プロファイルへ反映します：

```sh
rdsh models                              # 読み取り専用：不足IDと古い表示名を表示
rdsh models --provider kimi-coding       # プロバイダを限定
rdsh models sync                         # 不足分を追記し、古い表示名を更新
rdsh models sync --profile web --dry-run # 書き込まずに確認
```

削除は行いません。既存エントリの他の行はそのまま維持され、プロバイダの現行名をすでに含んでいる
表示名は書き換えません。構造を認識できないプロファイルについては、書き換えを行わずに処理を拒否します。
変更の反映は次回の設定リロード時または再起動時となります。

### エージェント実行の安全な隔離

委譲されたエージェントツールは、既定では通常のファイル読み書きが可能です。`--share-file` で隔離されるのは **`rdsh_inspect` のみ**です。Linux（bubblewrap と prlimit が利用可能な環境）では、このツールから参照できる対象が明示的に共有したファイルのみに制限されます：

```sh
rdsh --share-file README.md --share-file src/main.rs --profile tui
```

`rdsh_inspect` からは共有ファイルが読み取り専用として参照でき、ネットワークアクセスも遮断されます。`rdsh features on agent_tool_sandbox` で常時有効化、`rdsh features off agent_tool_sandbox` で無効化、`RDSH_SECURITY=1` で強制適用できます。

`bash`・`read`・`write`・`run_code` などのその他の DSH ツールは隔離されず、**upstream DSH の権限と承認**に従います。起動時には `[rdsh security] rdsh_inspect is isolated; other DSH tools use upstream permissions` と表示されます。

### フック監視 (`rdsh guard`)

DSH の `hooks.json` と連携し、危険なコマンド実行を瞬時に検知・遮断します：

```sh
echo "$input" | rdsh guard --deny "rm -rf /*" --deny "*token*"
```

対応するファイル操作を構造的に判定する場合は、任意で policy file を指定できます。
次の例では、既存のプロジェクトディレクトリ内における `Read` のみを分類上許可します。

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

構造判定が対応しているのは、`Read`・`Write`・`Edit` のファイル path schema です。
作業ディレクトリと対象 path を正規化し、tool および read/write の範囲を既存の root と照合したうえで、
秘密情報を含まない理由とともに `allow`・`deny`・`unknown` を返します。JSON 内の `allow` は分類結果にすぎず、
ホスト側の permission や approval を意味するものではありません。そのため `decision` は出力せず、最終的な権限判断はホスト側に委ねられます。
未知の tool、shell command、破損した入力、未対応の引数に対しては fail closed として動作します。shell の構文解析や network 先の判定には対応していません。
path の判定後にファイルシステムが変更される競合の可能性もあるため、この hook は OS sandbox として機能するものではありません。実際にアクセスを強制制限する場合は、実行 sandbox を使用してください。

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
Git 状態・検索結果・管理された記憶）を組み立て、DSH の `UserPromptSubmit` フック契約に従って
出力します。手動でコピー＆ペーストすることなくモデルへ文脈が渡されます。

```sh
rdsh features on context_engine        # コンテキストエンジンはオプトイン
rdsh context hook install              # $DSH_HOME/hooks.json に追記（冪等）
rdsh context hook status --json
```

フックは fail-open で動作し、プロンプトの送信を妨げることなく常に exit 0 で終了します。出力が行われないのは、設定ファイルが読み込めない場合や
stdin を解釈できない場合のみです。インデックスの破損やタイムアウトが発生した場合でも、依存グラフやコード検索のみを省略し、
goal・constraints・記憶は継続して出力されます。コンテキストの注入には専用の予算（`context.inject_budget`、既定1200トークン）と
制限時間（`context.inject_deadline_ms`、既定1200ms）が設定されており、期限を超過した場合はコード検索をスキップして
記憶・goal・constraints のみを出力します。

記憶は会話ログをそのまま複製したものではなく、適切に管理された項目です。

```sh
rdsh context remember "APIの互換性を必ず保つ" --kind constraint
rdsh context distill --session ~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd --apply
rdsh context memory --json      # active と superseded を区別して表示
rdsh context forget mem_ab12cd34ef56
```

`distill` はユーザーの発話のみを読み取り（zstd 圧縮セッションにも対応）、決定・制約・撤回を
確定的なマーカーに基づいて抽出します。重複する古い項目は、推測による上書きではなく `superseded_by` によって無効化されます。
`rdsh context build --require-stable` は、スナップショットの安定性が確認できない場合
（構築中にファイルや git の状態が変化した、あるいは git の状態を読み取れない場合など）に exit 3 で終了し、
古いスナップショットや不確定なスナップショットが最新のものとして誤認されるのを防ぎます。

### 依存グラフと変更影響（`rdsh deps`）

```sh
rdsh deps build                    # $DSH_HOME/rdsh-index に増分索引を作る
rdsh deps query engine_score       # シンボルの定義元と参照元
rdsh deps impact src/context.rs    # 直接・推移的な依存元と影響するテスト
```

解析と抽出は Rust・JavaScript/TypeScript・Python・Go に対応しており、ファイルごとに import・定義・
静的な呼び出し箇所を記録します。size と mtime が一致するファイルは再解析をスキップするため、
繰り返し実行しても高速に動作します。なお、この解析は静的近似によるものです。動的 dispatch・間接呼び出し・マクロ・
自動生成コードなどは `unknown` として明示され、未解決件数として報告されます（推測で補完することはありません）。
インデックスが存在しない状態は「情報が存在しない」ことを意味し、「依存関係が存在しない」こととは異なります。

インデックスが存在する場合、`rdsh context build` および `rdsh context inject` は、検索にヒットしたファイルの
依存関係の周辺情報もあわせて取り込みます。これにより、コードの抜粋が実際に依存しているファイルとともに提供されます。
Rust によるネイティブ処理のため、呼び出しごとのオーバーヘッドは約1msと非常に軽量です。

## 低スペック環境向け

既定のプロファイルは、`RDSH_DEFAULT_PROFILE`、rdsh 設定の `general.default_profile`、ローカルの `tui`、案内メッセージ付きエラーの優先順で決定されます。保存する既定値は `rdsh settings set general.default_profile web` で設定できます。なお、明示的に指定された `--profile <name>` が最優先されます。

古いx86-64 CPU、古いLinuxディストリビューション、Node.jsを入れていない環境でも使えることを目指しています。

- **Node の起動を高速化**: rdsh が dsh を起動する際、`NODE_COMPILE_CACHE` に
  `~/.cache/rdsh-node-compile-cache` を設定し、プロセスの起動をまたいで Node にコンパイル結果を再利用させます
  （Node 22.1 以上で対応。古いバージョンでは無視されます）。すでに設定されている `NODE_COMPILE_CACHE` はそのまま尊重されます。
  `RDSH_NODE_COMPILE_CACHE=0`、`--passthrough`、`RDSH_PASSTHROUGH=1` を指定することで無効化できます。
- **幅広い CPU に対応**: ビルド済みの x86-64 バイナリは AVX や BMI を必要としません。静的リンクされた musl 版は、古い glibc 環境でも動作します。
- **セッションのトークン見積り**: `sessions --tokens` は、展開後サイズが記録されている zstd フレームであればヘッダーから直接サイズを読み取ります。
  多くのストリーミングフレームでは `zstd -dc` による展開が必要です。処理結果は
  `~/.cache/rdsh/sessions-tokens.json` に保存され（`$XDG_CACHE_HOME` が優先されます）、
  `RDSH_TOKENS_CACHE=0` でキャッシュを無効化できます。サイズを読み取れない場合は `?` が付与されます。
- **並列処理の制限**: 検索やセッション走査に使用するワーカーは最大8スレッドです。zstd CLI へのフォールバック時は 8〜32 プロセスを並列で使用します。
- **Node なしでも使えるネイティブコマンド**: `tokens`、`search`、`sessions` などのコマンドは単体で利用できます。会話機能を委譲するには
  `@deepseek-ai/dsh` を導入するか、`DSH_ORIG_BIN`（または `RDSH_ORIG_BIN`）を指定してください。
- **低優先度での自動更新**: `sync-dsh.sh` は dsh と rdsh を更新し、リポジトリでレビュー済みの固定 digest 台帳に基づいて取得物を検証します。更新に失敗した場合は変更を元に戻します。
  既定では固定 digest 台帳の `latest` が指す安定版を使用します。`RDSH_SYNC_FROM_SOURCE=1` を指定した場合は、
  `nice -n 19` および（利用可能であれば）`ionice -c3` の優先度で `main` ブランチからビルドを行います。
  systemd ユニットも同様に低優先度で実行されます。`ExecStart` のパスは各自の checkout 環境に合わせて設定してください。

<a id="web-ui"></a>

## Web UI とダッシュボード

### 内蔵 Web UI (`rdsh serve`)

手元で状態確認やトークン見積もりを行える軽量な Web 画面です（既定ポート `:38080`、本家の `:3080` と競合しません）：

```sh
rdsh settings set extras.enable serve  # 機能を有効化
rdsh serve                             # 起動（ローカルホスト限定、一時トークンで保護）
```

### 表示言語

rdsh 自身が表示する CLI 診断と内蔵ローカル画面は、英語・簡体字中国語・日本語に対応します。1回だけ指定するには `--language`、保存するには `rdsh.json` を使います。既定の `auto` は最初の空でないロケール環境変数を使い、未設定・未対応なら英語になります。

```sh
rdsh --language ja settings show
rdsh settings set general.language zh-CN
```

優先順位は `--language`、`RDSH_LANG`、`general.language`、`LC_ALL`、`LC_MESSAGES`、`LANG` の順です。明示された `general.language` の値が不正な場合は、設定を書き換えずに処理を中断します。なお、委譲される `dsh` の引数、モデルの出力、JSON フィールド、ファイル内容、プロトコル識別子は翻訳されません。

`worker-scope validate` と `worker-scope policy` のヘルプおよび CLI 診断も同様に3言語に対応しています。この独立した処理とそのヘルプは、無関係な設定ファイルの破損による影響を受けません。通常のコマンドやルートのヘルプでは設定エラーが報告されます。正規の JSON、ポリシーコード、渡されたパスの値は変更されません。

### 拡張ダッシュボード (`rdsh-dashboard`)

プロジェクト全体の稼働状況、質問・回答の確認、モバイル端末からの接続などを行える拡張ダッシュボードです（要 Node.js 22+）：

```sh
rdsh-dashboard project --project <ディレクトリ>
```

`project --include-project <ディレクトリ>` を指定すると、その起動時に明示されたプロジェクトのみを対象として、稼働・待機・要確認の各件数を横断表示します。詳細情報は各プロジェクト専用のダッシュボードに保持され、読み取りができない場合は前回の観測時刻と状態不明である旨を表示します。

※ Windows ネイティブ環境ではタスクトレイに常駐し、タスクバーから手軽に開閉できます（ターミナルから起動したい場合は `--no-tray` を指定してください）。詳細は [dashboard/README.md](dashboard/README.md) を参照してください。外部エージェント CLI（cursor-agent、devin）を監視付きジョブとして実行することも可能です（[docs/AGENT-RUNNERS.md](docs/AGENT-RUNNERS.md)、英語）。

## デスクトップアプリ (Electron)

DeepSeek Harness Desktop は、Web アプリケーション全体を内包した Electron シェルです。CLI と `$DSH_HOME` を共有しますが、**予約済みプロファイル**（`$DSH_HOME/profiles/desktop`）と同梱の独自コマンドランタイムを持つため、npm の `dsh` CLI ではプラグインを管理できません。`rdsh desktop` はこれらを自動検出し、プラグインの組み込みをアプリ自身のコマンドへ転送します。rdsh 側でプロファイルを起動したり直接書き換えたりすることはありません：

```sh
rdsh desktop status                 # アプリ、コマンドランタイム、プロファイル、プラグインの状態（読み取り専用）
rdsh desktop install --plugins-dir .   # rdsh-settings＋標準サードパーティ（sound、gitview）を組み込み
rdsh desktop install --plugins-dir . --compute   # 常駐 compute bridge もあわせて追加
rdsh desktop install --plugins-dir . --no-sound --no-gitview  # サードパーティを省く場合
rdsh desktop verify                 # プロファイルに rdsh プラグインがない場合は 0 以外で終了
```

プロファイルインストーラーや各種インストーラーからも同様に利用できます：

```sh
PROFILE=desktop ./plugins/install.sh   # Essential＋既定の推奨プラグインを正しく転送して導入
./install.sh --desktop                 # インストール時に rdsh プラグインを組み込み
```

※ プラグインを組み込む前にアプリを終了し、完了後に再起動してください。アプリ内の Plugins 画面からも、コマンドを使わずに同じパッケージをインストールできます。Electron ランタイム自体が置き換わることはなく、アプリ内の処理委譲はオプトインかつフェイルオープンな compute bridge に限定されます。詳細は [DESKTOP-INTEGRATION.md](docs/DESKTOP-INTEGRATION.md) を参照してください。

## Smart-DSH との併用

[Smart-DSH](https://github.com/hikarioyama/Smart-DSH)（Web プロファイル向けプラグイン集）と問題なく共存できます：

```sh
rdsh doctor                                    # dsh のバージョンと Smart-DSH バンドルを確認
rdsh plugin --profile web add /path/to/bundle  # プラグインの追加（dsh plugin と同等）
rdsh --profile web                             # プラグイン付きで起動
```

ポート番号（DSH Web: `3080`、rdsh serve: `38080`）も競合しません。

DSH の会話 GUI に読み取り専用の workflow 進捗ボードを追加する場合は、[対応sourceへの適用・診断ツール](plugins/workflow-board/README.ja.md)を隔離された対象の checkout に適用して使用します。board と共通表示 projection を変更する18ファイルの patch や fixture テストを同梱していますが、patched DSH の build および採用は別工程となります。

MCP resource を安全な添付成果物として開き、resource link を明示的な操作によって読み出す場合は、[対応sourceへの適用・診断ツール](plugins/mcp-resource-artifacts/README.ja.md)を指定 revision の隔離された checkout に対して使用します。リンクの自動取得は行わず、binary をモデル向けテキストに展開することもありません。patched DSH の build および採用は別工程となります。

rdsh が同梱しているのは Smart-DSH のスマートフォン幅レイアウトのみです
（[`plugins/rdsh-mobile-ui`](plugins/rdsh-mobile-ui/README.md)、MIT・Smart-DSH 由来）。
画面幅 767px 以下ではチャット欄と入力欄が全幅表示になり、ロゴを1回タップするとセッション一覧が開きます。
Smart-DSH の通知機能、Esc キーによる停止、タスクハブ、HMR 回避策などは上流バンドルに含まれるため、必要な場合は
上流のバンドルを別途導入してください。

## 実測ベンチマーク

Linux x86_64 環境におけるプロセス単位の測定結果です。各行には測定対象を明記しており、
いずれもエージェントセッション自体の数値ではありません。プロファイルの起動時は、
rdsh 側でも本家の Node.js 版 `dsh` を `exec` するため、会話セッションの起動時間・対話速度・
メモリ消費量は本家と同等になります。

本家 `dsh` と直接比較しているのは `--version` の行のみです。フック・`tokens`・
`search` の各行は、同等の処理を Node.js で実装した参照実装との比較結果です（本家 `dsh` には
`tokens` や `search` サブコマンドが存在しないため、本家との比較値は記載していません）。これらの数値は、
`scripts/benchmark-node-vs-rust.py` を用いて Linux x86_64 実機上で測定された実測値です。

| 測定対象 | rdsh | 比較対象 | 差・倍率 |
| --- | --- | --- | --- |
| `rdsh --version` プロセス起動 | **約0.90 ms** | 本家 `dsh --version` 約88 ms | **約98倍高速** |
| `rdsh --version` 最大RSS | **約2.9 MB** | 本家 `dsh --version` 約66 MB | **約1/23に削減** |
| PreToolUse フック `rdsh guard`（1ツール呼び出し・プロセス起動込み） | **約2.0 ms** | Node.js 判定スクリプト 約80〜100 ms | **約40〜50倍高速** |
| PreToolUse フック 200ツール呼び出しの累積（10%をブロック） | **約0.4〜0.6 秒** | Node.js 判定スクリプト 約16〜24 秒 | **約42倍高速** |
| PreToolUse フックの最大RSS | **約6.0 MB** | Node.js 判定スクリプト 約49 MB | **約1/8に削減** |
| `rdsh tokens`（9.6 MB のASCIIテキスト） | **約8 ms** | Node.js 参照実装 約175〜195 ms | **約22倍高速** |
| `rdsh search`（300ファイル・60万行） | **約10〜25 ms** | Node.js 参照実装 約125〜230 ms | **約9〜12倍高速** |
| `sessions --tokens`（20セッション） | **約0.41 秒** | 旧rdshビルド 約1.65 秒（記録値） | **約4.0倍高速** |
| 配布バイナリサイズ | **約1.8〜2.3 MB**（プラットフォーム別・単一バイナリ） | Nodeツリー 約508 MB | **超軽量** |

`--version`・`sessions`・バイナリサイズの行は [docs/BENCHMARKS.md](docs/BENCHMARKS.md) に
記録されている従来の数値であり、絶対値は実行環境のホストに依存します。フック・`tokens`・`search` の測定は
Linux x86_64 環境、`n=15`、プロセス起動時間を含めた実測値であり、次のコマンドで再測定できます：

```sh
cargo build --release
python3 scripts/benchmark-node-vs-rust.py --bin ./target/release/rdsh \
  --mode all --n 15 --calls 200 --output /tmp/rdsh-node-vs-rust.json
```

起動時間は `rdsh bench --n 5` で再現可能です。詳細な測定条件や測定生データについては、
[docs/BENCHMARKS.md](docs/BENCHMARKS.md) を参照してください。

## 安全設計

1. **本家挙動の透過性**: 会話ループやモデル推論は独自実装せず、すべて本家 `dsh` に委譲して互換性を担保します。
2. **非破壊設計**: トークン計算、検索、ログ圧縮などの読み取り系コマンドは、既存のファイルを一切変更しません。
3. **明示的な認証管理**: 他アプリの認証情報を無断で同期・送信せず、利用者が明示的に指定したものだけを取り込みます。
4. **サンドボックス隔離**（オプトイン）: Linux 環境では、`--share-file` で共有したファイルだけを読み取り専用・ネットワークなしで `rdsh_inspect` に渡します。その他の DSH ツールは upstream の権限と承認に従います。

## よくある質問

- **Q. 本家 `dsh` は必要ですか？**  
  会話やモデル実行には本家 `dsh` が必要です。トークン計算、ファイル検索、環境診断（`rdsh doctor`）などのユーティリティコマンドは `rdsh` 単体でも動作します。

- **Q. 既存の `dsh` コマンドと置き換えて使えますか？**  
  はい。`./install.sh --as-dsh`（Windows では `.\install.ps1 -AsDsh`）で導入すると、普段の `dsh` コマンドで自動的に高速起動されます。元に戻す場合は `--restore` オプションですぐに復元できます。

- **Q. ポート番号が衝突したときは？**  
  本家 DSH の Web GUI（`:3080`）と `rdsh serve`（`:38080`）は既定ポートが異なります。空きポートを自動選択したい場合は `--port 0` を指定してください。

- **Q. 既存のスクリプトは壊れませんか？**  
  `rdsh` 固有のコマンド以外は、指定したすべての引数をそのまま本家 `dsh` に引き渡すため、既存のスクリプトや CI パイプラインはそのまま動作します。

- **Q. プロファイルを指定しない `rdsh boot` が失敗する場合は？**
  `general.default_profile` または `RDSH_DEFAULT_PROFILE` を設定するか、`--profile <name>` を付けてください。

## 資料

| 資料 | 内容 |
| --- | --- |
| [docs/USER-FLOW.md](docs/USER-FLOW.md) | 導入から設定・利用・復旧までの全体フロー |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 委譲の仕組みとアーキテクチャ設計 |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md) | ベンチマークの詳細と再現手順 |
| [docs/RDSH-SETTINGS.md](docs/RDSH-SETTINGS.md) | 設定画面の機能と CLI キー一覧 |
| [docs/DESKTOP-INTEGRATION.md](docs/DESKTOP-INTEGRATION.md) | デスクトップアプリ (Electron) との連携 |
| [docs/FEDORA.md](docs/FEDORA.md) | Fedora / RHEL 向けパッケージ・任意ツール・Linux でのデスクトップ事情 |
| [docs/PACKAGE-MANAGERS.md](docs/PACKAGE-MANAGERS.md) | Homebrew・Scoop・winget での導入とマニフェストの更新 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 今後の開発ロードマップ |
| [docs/RELEASING.md](docs/RELEASING.md) | リリース手順 |
| [docs/SERIAL-PROXY.md](docs/SERIAL-PROXY.md) | 同時リクエスト数制限プロキシ |
| [CHANGELOG.md](CHANGELOG.md) | バージョンごとの主な変更履歴 |

## コミュニティ

- コントリビューション：[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。
- Rust開発環境：[Rust開発ガイド](docs/RUST-DEVELOPMENT.md) を参照してください。
- バグ報告・要望：[Issue フォーム](https://github.com/jimoto-no-llm/rustdsh/issues/new/choose)（日本語 OK）へお寄せください。
- セキュリティ脆弱性報告：公開 Issue ではなく [SECURITY.md](SECURITY.md) に記載の手順でご報告ください。
- サポート：[SUPPORT.md](SUPPORT.md) / 行動規範：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 謝辞

本家 DeepSeek Harness の開発者およびコントリビューターの皆様に感謝します。本家のランタイムが rustdsh の基盤です。

- アイコン制作: [PENTACoXIAN](https://x.com/PENTACoXIAN)
- セキュリティレビュー・脆弱性報告: [GrEarl](https://github.com/GrEarl)、[PENTACoXIAN](https://x.com/PENTACoXIAN)
- 実装・改善・検証協力: [StudioYebisu](https://github.com/yebisu0529-ship-it)、[RNA4219](https://github.com/RNA4219)、[eightman999](https://github.com/eightman999)、[cyrne1-7208](https://github.com/cyrne1-7208)
- アイディア・製品提案: [@remydre8](https://x.com/remydre8)
- 標準搭載の Web UI プラグイン（許諾済み、MIT）：[cwd514](https://github.com/cwd514) さんの [dsh-sound-notifications](https://github.com/cwd514/dsh-sound-notifications)（(c) 2026、効果音・デスクトップ通知）、[yugapor](https://github.com/yugapor) さんの [dsh-gitview](https://github.com/yugapor/dsh-gitview)（(c) 2026、差分・履歴・CI付き Git パネル）。どちらもインストール時に上流 GitHub から取得します（詳細は `plugins/recommended.md`）。

rdsh が利用・改変・推薦している第三者製 DSH プラグインです（いずれも MIT、著作権は各作者に帰属します）:

- [Smart-DSH](https://github.com/hikarioyama/Smart-DSH)（hikarioyama）—
  [`rdsh-mobile-ui`](plugins/rdsh-mobile-ui/README.md) として同梱するスマホ幅レイアウト
- [dsh-sound-notifications](https://github.com/cwd514/dsh-sound-notifications)（cwd514）—
  推奨プラグイン `sound`（効果音とデスクトップ通知）。web/desktop では既定で導入し、
  `--recommended=none`／`SOUND=0`／`features.sound=false` でスキップできます
- [dsh-gitview](https://github.com/yugapor/dsh-gitview)（yugapor）— 推奨プラグイン
  `gitview`（サイドバー Git パネル）。web/desktop では既定で導入し、`--recommended=none`／
  `GITVIEW=0`／`features.gitview=false` でスキップできます
- [dsh-intelligent-ui](https://github.com/cwd514/dsh-intelligent-ui)（cwd514、MIT、Copyright (c) 2026 cwd514）—
  推奨プラグイン `intelligent-ui`（宣言的な `render_ui` ツールによる表・グラフ・比較などの視覚回答）。
  既定では導入せず、`--recommended=intelligent-ui` または `INTELLIGENT_UI=1` で有効にします

## ライセンス

MIT（[LICENSE](LICENSE)）です。本家 DeepSeek Harness および依存ライブラリにはそれぞれのライセンスが適用されます。

## 保護付き起動の対応版

明示的な共有ファイルだけを扱う隔離機能を利用するには、Linux x86_64 環境と bubblewrap・prlimit・ユーザー名前空間が必要です。監査済みの DSH とツールランタイムの同一バージョンの組み合わせは `0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.3` です。未知のバージョン、混在、改変されたランタイム、または別の依存先へ解決されたランタイムは実行を拒否します。macOS と Windows 環境では保護付き委譲を拒否します。[ダッシュボードの固定更新](docs/STAGED-UPDATES.md)には別の対応バージョン一覧があります。

### 外部エージェントのジョブ

`node dashboard/cli.mjs --language ja agents list` で表示言語を選択できます。外部エージェントのヘルプと CLI 診断は英語・簡体字中国語・日本語に対応しています。ジョブ状態、エラーコード、JSON キー、エージェント出力は原文を保持します。日本語のファイル名と指示文は UTF-8 の `--prompt-file` で渡せます。[コマンドと権限の制約](docs/AGENT-RUNNERS.md)を確認してください。実際のジョブ実行では外部サービスの料金が発生する場合があります。言語検証はローカルのテスト用実行ファイルで行います。

`budget-admission apply|validate|public --input-file <request-json>` も設定に依存しない純粋な JSON コマンドです。native と Dashboard のヘルプ・診断メッセージは3言語に対応し、予算コードと JSON 出力の内容は保持されます。プロバイダーの呼び出しや予算台帳への書き込みは行いません。[予算管理](docs/BUDGET-CONTROL.md)を参照してください。

`question-contracts apply|validate|public`、`answer-applications apply|validate|public|schema`、`instruction-queue validate|context|submit|resolve|control` も同様に `--input-file <request-json>` を受け取り、無関係な設定を読み込むことはありません。native と Dashboard のヘルプや固有の診断メッセージは3言語に対応し、エンジンのメッセージ、状態コード、正規 JSON は上流の値を保持します。任意の[応答ガード](plugins/rdsh-answer-guard/README.md)も通知要約と設定エラーの表示を3言語化し、モデルへの再出力指示は保持されます。
