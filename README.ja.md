# rdsh — dsh の Rust 高速ランチャー（安全な移植）

[English](README.md)

[![ci](https://github.com/sahenjp/rustdsh/actions/workflows/ci.yml/badge.svg)](https://github.com/sahenjp/rustdsh/actions/workflows/ci.yml)
[![dashboard](https://github.com/sahenjp/rustdsh/actions/workflows/dashboard.yml/badge.svg)](https://github.com/sahenjp/rustdsh/actions/workflows/dashboard.yml)
[![docs](https://github.com/sahenjp/rustdsh/actions/workflows/docs.yml/badge.svg)](https://github.com/sahenjp/rustdsh/actions/workflows/docs.yml)
[![release](https://img.shields.io/github/v/release/sahenjp/rustdsh.svg)](https://github.com/sahenjp/rustdsh/releases)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

<img src="assets/icon.svg" width="96" alt="rdsh icon">

フル移植ではなく**ホットパスだけ Rust 化＋残りは本家 dsh に委譲**する設計です。
起動約98倍・メモリ約1/23を、本家の動作を変えずに実現します。

- 起動中央値 **約0.90ミリ秒**（本家約88ミリ秒）
- 常駐メモリ **約2.9MB**（本家約66MB）・単一バイナリ約806KB（依存ツリー不要）
- `dsh`名で置換しても引数を一字も変えず委譲するため、既存の使い方・スクリプトはそのまま動きます

## 目次

- [実測](#実測)
- [インストール](#インストール)
- [低スペック環境向け](#低スペック環境向け)
- [使い方](#使い方)
- [置換モード（dsh として使う）](#置換モードdsh-として使う)
- [Smart-DSH との併用](#smart-dsh-との併用)
- [Web UI（ダッシュボード）](#web-uiダッシュボード)
- [安全設計](#安全設計)
- [コミュニティ](#コミュニティ)
- [よくある質問](#よくある質問)
- [クレジット](#クレジット)
- [ライセンス](#ライセンス)

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

## インストール

いちばん速い方法（ビルド済みバイナリ、Rust不要）：

```sh
# Linux / macOS / WSL
curl -fsSL https://github.com/sahenjp/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

Linux/x86_64 では、glibc版（`rdsh-linux-x64.tar.gz`、glibc 2.34以上が必要）を選びます。
glibcが2.34未満、または無い環境（Alpine等）では、完全静的な
`rdsh-linux-x64-musl.tar.gz` を自動で選びます。`--musl` で静的版を強制できます。

```powershell
# Windows（PowerShell）
$f = Join-Path $env:TEMP 'rdsh-install.ps1'
Invoke-WebRequest -Uri https://github.com/sahenjp/rustdsh/releases/latest/download/install.ps1 -OutFile $f -UseBasicParsing
& $f -FromRelease
```

ソースから入れる場合：

```sh
git clone https://github.com/sahenjp/rustdsh.git
cd rustdsh
./install.sh                 # ビルド＋ ~/.local/bin/rdsh に導入
./install.sh --as-dsh        # rdsh を `dsh` 名でも使えるよう置換（元は dsh-orig に退避）
./install.sh --restore       # 置換を元に戻す
./install.sh --prefix=DIR    # 導入先を変更（既定 ~/.local/bin）
```

install.sh は Linux / macOS / WSL 用です（WSL自動検出、cargoがなければ
rustupで自動導入。`--no-rustup` で無効化）。Windowsネイティブは install.ps1：

```powershell
git clone https://github.com/sahenjp/rustdsh.git
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

ソースから直接ビルドする場合は `cargo build --release` で `target/release/rdsh` ができます（Rust 1.73+が必要）。

## 使い方

### dsh 互換（委譲）

```sh
rdsh web                          # = dsh --profile web（slim env 付きで委譲）
rdsh --profile web --patch x.yml  # オーバーレイ付き起動
rdsh --passthrough web            # slim 無しの完全委譲（非常口）
rdsh --dry-run web -- --resume abc  # 実行内容だけ表示
```

プロファイル名はそのまま本家dshへ渡します（`rdsh tui`・`--profile tui` も同様）。
ただしdsh 0.2.0以降は `tui` プロファイルが同梱されないため、ローカルに
`$DSH_HOME/profiles/tui` がある場合だけ使えます。dsh 0.2.0が初回利用時に作るのは
`web`・`headless`・`acp`・`sdk`・`sdk-minimal` です。

#### 既定プロファイル

プロファイル無指定の `rdsh boot`・`rdsh dump-config` は次の順で決めます：

1. `RDSH_DEFAULT_PROFILE`（設定済みで空でなければ。例：`RDSH_DEFAULT_PROFILE=web`）
2. `$DSH_HOME/profiles/tui` がある場合だけ `tui`（旧環境の後方互換）
3. どちらでもなければexit 2で終了し、ローカルのプロファイルと同梱テンプレートを案内します
   （決め打ちのフォールバックはありません）

`--dry-run` も同じ解決をします。引数なしの `rdsh` は従来どおりヘルプを表示します。

### 高速ネイティブコマンド（Nodeを起動しない）

```sh
rdsh tokens ./AGENTS.md             # 入力トークン見積（約4文字=1トークン、CJKは1字1トークン）
echo ... | rdsh prune --max-tokens 4000   # head+tailを残して予算内に切り詰め
rdsh search TODO --dir . --max 100 # 再帰grep（並列・出力順は逐次と同一）
rdsh search-web "rust async" --limit 5  # Web検索（SearXNG経由、既定 http://127.0.0.1:8888、`$SEARXNG_URL` で変更）
rdsh compact ./s.jsonl --max-tokens 8000 # セッションJSONLの圧縮（元ファイル不変）
rdsh sessions --limit 20 --tokens  # セッション一覧＋トークン見積（zstdヘッダーから読取、展開なし）
rdsh logs --tail 50 --grep ERROR   # 起動ログの参照
rdsh profiles / rdsh skills        # プロファイル・スキル一覧
rdsh doctor                        # 本家dsh・DSH_HOME・slim設定の確認
rdsh bench --n 5                   # rdsh/dsh の起動比較
rdsh serve                         # Webダッシュボード（:38080）
```

### OAuth自動認識（`rdsh auth`：入れるだけで認識）

他ツールで済ませたログインを、dsh本体が読む
`$DSH_HOME/.credentials.yaml` へ自動で写します：

- Codex CLI（`~/.codex/auth.json`、ChatGPT OAuth）
- opencode（`$XDG_DATA_HOME/opencode/auth.json`、`openai` OAuthは
  `openai-codex` ルートになります）

```sh
rdsh auth            # 状態確認：見つかったログインと認識済みの一覧
rdsh auth --import   # 不足・古い分だけ書込（0600、他エントリ不変）
rdsh auth --json     # 機械可読の状態出力
rdsh setup           # 初回ウィザード：取込、キー貼付、--login/--open
rdsh setup --web     # フローティングのセットアップUI（localhost、ブラウザ自動表示）
```

起動時（`rdsh web`・`dump-config`・`plugin`）は先に自動同期するので、
Codex/opencode側でログインするだけで使えます。
`RDSH_AUTH_AUTOSYNC=0` で無効化できます。dsh側で更新された新しい
トークンは上書きせず、非grant記録（APIキー）にも触れません。

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

標準入力（フックJSONまたは生テキスト）を走査し、拒否パターンに一致したらexit 2＋理由出力でブロック、それ以外はexit 0で通過します。`--json` で `{"decision":"block"/"approve"}` を返します。パターンの `*` は任意文字列に一致します。

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

## 低スペック環境向け

2コアのCeleron/Pentium級、AVXなし、古いディストロ、Nodeなしでも使えることを目標にしています。

- **slimの実態**：起動時のslim（既定ON）は `RDSH_*` のヒント変数を付けますが、本家dsh
  （0.2.0-rc.x とそのコアパッケージ）はどれも読みません。効くのはオプトインした
  サードパーティのプラグインだけです。Nodeの起動を実際に短くするのはディスク上の
  コンパイルキャッシュ（`NODE_COMPILE_CACHE`、Node 22.1以上、ESM対応）です。
  slimは `$XDG_CACHE_HOME/rdsh/node-compile-cache`（無ければ
  `~/.cache/rdsh/node-compile-cache`、Windowsは `%LOCALAPPDATA%\rdsh\node-compile-cache`）を
  指し、ディレクトリは可能な範囲で作成します。既に `NODE_COMPILE_CACHE` を設定していれば
  常にそちらを優先します。`RDSH_NODE_COMPILE_CACHE=0` で無効化、`--passthrough`・
  `--no-slim`・`RDSH_PASSTHROUGH=1` では何も付けません。`--dry-run` は設定内容を表示するだけで
  ディレクトリは作りません。古いNodeはこの変数を無視します
- **ビルド済みバイナリ**はベースラインのx86-64（`target-cpu`・AVX/BMIなし）なので、
  Celeron/Pentiumでも動きます。古いglibcには静的musl版が対応します。
  リリースビルドはこの条件を保ってください
- **`sessions --tokens`** はzstdフレームヘッダーから展開後サイズを読みます
  （正確・展開なし・`zstd` CLI不要・プロセス起動なし）。サイズを記録していない
  フレームだけ `zstd -dc` にフォールバックし、出力はバイト数のカウンターへ流します
  （全文は保持しません。プロセス数はコア数まで）。どちらも使えない場合だけ `?` を付けます
- **スレッド数**：`search` と `sessions` の走査は固定値ではなくコア数に合わせます
- **ホストにNodeが無い場合**：`rdsh doctor` が明示します（Nodeがあればパス・版、22.1未満なら警告）。
  ネイティブコマンドはそのまま使えます。dshを起動するには `RDSH_ORIG_BIN` を指定するか
  `@deepseek-ai/dsh` を導入してください
- **穏やかな自動更新**：`sync-dsh.sh` はrdshをリリースのビルド済みバイナリで更新します
  （タグと `rdsh --version` を比較→実行確認→アトミック置換→失敗時は復元）。
  ソースビルドは `RDSH_SYNC_FROM_SOURCE=1` の明示指定時のみで、`nice -n 19`／`ionice -c3` 下で
  実行します（`CARGO_BUILD_JOBS` を尊重）。systemdユニットはCPU・IOともidle優先度で動きます。
  `ExecStart` は各自のcheckoutの場所に合わせてください

### 変更点: 自動更新はmainブランチ追従からリリースタグ追従に変わりました

`sync-dsh.sh` は従来、`origin/main` をfast-forwardしてcargoでビルドし、`tests/regress.sh` を
実行してからrdshを更新していました。**既定ではGitHubの最新リリースのバイナリを導入する方式に
変わった**ため、タグが付く前の `main` のコミットは取り込まれません。

- 従来の挙動（`main` 追従・ソースビルド・インストール前に `tests/regress.sh`）に戻すには
  `RDSH_SYNC_FROM_SOURCE=1` を指定します（例：`RDSH_SYNC_FROM_SOURCE=1 ./sync-dsh.sh`、または
  `systemd/rdsh-sync.service` に `Environment=RDSH_SYNC_FROM_SOURCE=1` を追加）
- トレードオフ：既定ではローカルでcargoビルドを行わず（低スペック環境に優しく、ツールチェーン不要、
  gitのcheckoutにも触れません）、ダウンロードしたバイナリは `--version` に応答することだけを
  確認してから置換します（失敗時は元に戻します。テストはタグ側のCIに任せます）。
  `main` に入った修正は、次のリリースタグが付くまで既定設定のホストには届きません
- 実行のたびに有効なモードをログに記録します（`~/.local/share/rdsh/sync.log` の
  `rdsh update mode: ...`）
- `tests/regress.sh` はソースモードでのみ実行します（リリースモードは
  `post-update regress: skipped` をログに残します）。実行は常にサンドボックス内で、
  使い捨ての `HOME`／`DSH_HOME` と `RDSH_AUTH_AUTOSYNC=0` を使うため、本物の `~/.dsh` には
  書き込みません。本家dsh（`dsh-orig`）は先に解決して `DSH_ORIG_BIN` で渡し、見つからなければ
  スタブを使います。`tests/regress.sh` 自体もauth自動同期を無効化し、`DSH_HOME` 未設定なら
  一時ディレクトリを使います

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
rdsh serve
# → http://127.0.0.1:38080/ を開く（localhost のみ、読取専用API）
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

外部依存はありません（CDN不要・オフライン可）。

手元の状態確認だけなら `rdsh serve` を使います（バイナリだけで動作）。
プロジェクトの指標・質問と回答・スマホ接続には [Node.jsダッシュボード](dashboard/README.md) を使います（Node.js 22+が必要）。
`rdsh-dashboard project --project <ディレクトリ>` でプロジェクト用、`rdsh-dashboard harness` で元のHarness Web画面を起動します。

## 安全設計

1. agent loop・profile bootの再実装はしません。`exec`委譲のみです
2. slimは**環境変数の追加だけ**です（`RDSH_*` ヒントと `NODE_COMPILE_CACHE`）。本家が知らないキーは無視され、利用者自身の `NODE_COMPILE_CACHE` は上書きしません
3. `desktop`プロファイル拒否・dump排他など本家のエラー条件をRust側でも再現します
4. 読取系（tokens/search/compact/dump --native/serve API/inspect）は元ファイルを書き換えません
5. `--passthrough`・`RDSH_PASSTHROUGH=1`・`./install.sh --restore`で即時退避できます

`cargo test`（26件）と `tests/regress.sh`（35件）で検証し、高速化の前後で出力一致を確認しています。

## コミュニティ

- まず [CONTRIBUTING.md](CONTRIBUTING.md)（PRは4行、スクリーンショット規定）。
- バグ・要望：[Issueフォーム](https://github.com/sahenjp/rustdsh/issues/new/choose)（日本語OK）。
- 質問・相談：[Issues](https://github.com/sahenjp/rustdsh/issues)。
- 脆弱性は公開Issueに書かず [SECURITY.md](SECURITY.md) へ。
- 設計資料：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)・
  [docs/BENCHMARKS.md](docs/BENCHMARKS.md)・[docs/ROADMAP.md](docs/ROADMAP.md)・
  [docs/RELEASING.md](docs/RELEASING.md)・[CHANGELOG.md](CHANGELOG.md)。

## よくある質問

- **ポートが使用中と言われる**：dsh web GUIは3080、`rdsh serve`は既定38080です。`--port 0` で空きポートを使えます
- **`profile "tui" does not exist` と出る**：dsh 0.2.0は `tui` を同梱しません。
  `rdsh web` や `rdsh --profile headless` を使うか、無指定の `rdsh boot` 用に
  `RDSH_DEFAULT_PROFILE=web` を設定してください
- **プロファイル名がサブコマンドと被る**：`dsh --profile <name>` 形式で起動してください
- **元に戻したい**：`./install.sh --restore`（退避した本家を復元）
- **`--tokens` の `?` 付き表示**：セッションのサイズを確定できなかった印です。`sessions --tokens` は通常zstdフレームヘッダーから展開後サイズを正確に読み、サイズ未記録のフレームがあれば `zstd` CLIにフォールバックし、それも無い場合だけ圧縮サイズ/4の概算を表示します
- **NODE_COMPILE_CACHEを使いたくない**：`RDSH_NODE_COMPILE_CACHE=0`（または `--passthrough`）。自分で設定した `NODE_COMPILE_CACHE` は常に尊重します

## クレジット

アイディア： [@studio_yebisu](https://x.com/studio_yebisu)、
[@remydre8](https://x.com/remydre8)。

## ライセンス

MIT（[LICENSE](LICENSE)）です。
