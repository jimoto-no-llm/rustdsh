# rdsh — dsh の Rust 高速ランチャー（安全な移植）

[English](README.md)

[![ci](https://github.com/sahenjp/rustdsh/actions/workflows/ci.yml/badge.svg)](https://github.com/sahenjp/rustdsh/actions/workflows/ci.yml)
[![dashboard](https://github.com/sahenjp/rustdsh/actions/workflows/dashboard.yml/badge.svg)](https://github.com/sahenjp/rustdsh/actions/workflows/dashboard.yml)
[![docs](https://github.com/sahenjp/rustdsh/actions/workflows/docs.yml/badge.svg)](https://github.com/sahenjp/rustdsh/actions/workflows/docs.yml)
[![release](https://img.shields.io/github/v/release/sahenjp/rustdsh.svg)](https://github.com/sahenjp/rustdsh/releases)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

<img src="assets/icon.svg" width="96" alt="rdsh icon">

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
- [低スペック環境向け](#低スペック環境向け)
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

## インストール

いちばん速い方法（ビルド済みバイナリ、Rust不要）：

```sh
# Linux / macOS / WSL
curl -fsSL https://github.com/sahenjp/rustdsh/releases/latest/download/install.sh | bash -s -- --from-release
```

Linux/x86_64 では、glibc版（`rdsh-linux-x64.tar.gz`、glibc 2.34以上が必要）を選びます。
2.34未満のglibcを検出したときは、完全静的な `rdsh-linux-x64-musl.tar.gz` を選びます。
`--musl`（または `RDSH_MUSL=1`）で静的版を強制できます。glibcを検出できないmusl専用環境
（Alpine等）では、自分で `--musl` を付けてください。インストーラーはダウンロードを `.sha256` ファイルで検証します。

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
rdsh --passthrough web            # slim 無し（実行制限は継続）
rdsh --dry-run web -- --resume abc  # 実行内容だけ表示
```

プロファイル名はそのまま本家dshへ渡します。dsh 0.2.0以降は `tui` プロファイルが同梱されない
（作られるのは `web`・`headless`・`acp`・`sdk`・`sdk-minimal`）ため、`rdsh tui` は
ローカルに `$DSH_HOME/profiles/tui` がある場合だけ使えます。

プロファイル無指定の `rdsh boot`・`rdsh dump-config` は、`RDSH_DEFAULT_PROFILE`、
rdsh設定の `general.default_profile`（`rdsh settings set general.default_profile web`）、
ローカルに `tui` があればそれ、の順で決めます。どれも無ければ、`--profile <name>` を付けるか
`RDSH_DEFAULT_PROFILE` を設定するよう案内するエラーで終了します。

### 高速ネイティブコマンド（Nodeを起動しない）

```sh
rdsh tokens ./AGENTS.md             # 入力トークン見積（約4文字=1トークン、CJKは1字1トークン）
echo ... | rdsh prune --max-tokens 4000   # head+tailを残して予算内に切り詰め
rdsh search TODO --dir . --max 100 # 再帰grep（並列・出力順は逐次と同一）
rdsh search-web "rust async" --limit 5  # search-web有効化とSearXNGが必要
rdsh compact ./s.jsonl --max-tokens 8000 # セッションJSONLの圧縮（元ファイル不変）
rdsh sessions --limit 20 --tokens  # セッション一覧＋トークン見積（zstdヘッダーまたはzstd CLIで正確なサイズ）
rdsh logs --tail 50 --grep ERROR   # 起動ログの参照
rdsh profiles / rdsh skills        # プロファイル・スキル一覧
rdsh doctor                        # 本家dsh・DSH_HOME・slim設定の確認
rdsh bench --n 5                   # rdsh/dsh の起動比較
rdsh serve                         # serve有効化後の状態画面（:38080）
```

### 認証情報の明示的な取り込み（`rdsh auth`）

他ツールで済ませたログインを、dsh本体が読む
`rdsh auth --import --provider openai-codex` で `$DSH_HOME/.credentials.yaml` へ写します：

- Codex CLI（`~/.codex/auth.json`、ChatGPT OAuth）
- opencode（`$XDG_DATA_HOME/opencode/auth.json`、`openai` OAuthは
  `openai-codex` ルートになります）

```sh
rdsh auth            # 状態確認：見つかったログインと認識済みの一覧
rdsh auth --import --provider openai-codex   # 不足・古い分だけ書込（0600、他エントリ不変）
rdsh auth --json     # 機械可読の状態出力
rdsh setup           # 初回ウィザード：取込、キー貼付、--login/--open
rdsh setup --web     # フローティングのセットアップUI（localhost、ブラウザ自動表示）
```

起動・診断・setupでは、他のアプリの認証情報をコピーしません。
OAuthは `rdsh auth --import --provider openai-codex --source codex` のように
対象を選んで取り込みます。APIキーは `--ref OPENAI_API_KEY` で指定します。
一括取り込みと `RDSH_AUTH_AUTOSYNC` は無効です。`setup --yes` は明示的な
環境変数キーの保存だけを許可し、外部ログインを取り込みません。

### エージェントの実行制限

Linux x86_64・bubblewrap・prlimit・監査対象DSH 0.2.0-rc.2で、モデルのツールを
`rdsh_inspect` に限定します。ツールには認証ストア・ホスト環境変数を渡さず、
ネットワークとホスト・プロジェクトへの書き込みをカーネルで拒否します。
隔離環境内の使い捨て一時領域は利用できます。利用者が指定したファイルの
コピーだけを、読み取り専用で渡します。例えば：

```sh
rdsh --share-file README.md --share-file src/main.rs --profile web
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
- 既定プロファイル： `RDSH_DEFAULT_PROFILE` → `general.default_profile` → ローカルの `tui` → 案内付きエラーの順
- 注意： `dsh tokens` のようにプロファイル名が予約語と衝突する場合は `dsh --profile tokens` で起動してください
- `node "$(... dsh ...)"` 形式のスクリプトは置換中に壊れます。`dsh`/`rdsh` を直接実行してください。対象は `rdsh doctor` が一覧表示します

## 低スペック環境向け

2コアのCeleron/Pentium級、AVXなし、古いディストロ、Nodeなしでも使えることを目標にしています。

- **Nodeの起動を速く**：rdshがdshを起動するとき `NODE_COMPILE_CACHE` を
  `~/.cache/rdsh-node-compile-cache` に設定し、Nodeが起動間でコンパイル結果を再利用します
  （Node 22.1以上。古いNodeは無視します）。自分で `NODE_COMPILE_CACHE` を設定していれば
  そのまま尊重します。`RDSH_NODE_COMPILE_CACHE=0`・`--passthrough`・`RDSH_PASSTHROUGH=1` で
  無効になります。slimのその他の変数（`RDSH_*`）は本家dshが読まないヒントです
- **ビルド済みバイナリ**は素のx86-64（AVX/BMIなし）なので、Celeron/Pentiumでも動きます。
  古いglibcには静的musl版が対応します
- **`sessions --tokens`** はサイズを記録したフレームならヘッダーから読みます（展開なし）。
  dshが書くストリーミングフレームは通常サイズを記録しないため、多くのセッションは
  `zstd -dc` CLIで数えます（8〜32プロセスを並列実行）。結果は
  `~/.cache/rdsh/sessions-tokens.json`（`$XDG_CACHE_HOME` を優先、`RDSH_TOKENS_CACHE=0` で無効）に
  キャッシュし、変わっていないセッションは再計算しません。サイズを読めなかったセッション（zstd CLIが無い場合など）には `?` を付けます
- **スレッド数**：`search` と `sessions` の走査スレッドはホストのコア数に合わせます（最大8）。
  `zstd` CLIへのフォールバックは8〜32プロセスを並列で起動します
- **ホストにNodeが無い場合**：ネイティブコマンド（`tokens`・`search`・`sessions` など）は
  そのまま使えます。`rdsh doctor` は本家dshが見つからないことを報告してexit 1で終わります。
  dshを起動するには `DSH_ORIG_BIN`（または `RDSH_ORIG_BIN`）を指定するか
  `@deepseek-ai/dsh` を導入してください
- **穏やかな自動更新**：`sync-dsh.sh` は本家dshを（検証・失敗時ロールバック付きで）更新し、
  rdsh自体も更新します。既定ではGitHubの最新リリースのビルド済みバイナリを使うため、
  cargoビルドは走らず、`main` のコミットはタグが付いてから届きます。新しいバイナリは、
  起動確認と、使い捨ての `HOME` での `tests/regress.sh` に通ったときだけ置き換えます。
  `main` に追従してソースからビルドしたい場合は `RDSH_SYNC_FROM_SOURCE=1` を指定します
  （`nice -n 19`、あれば `ionice -c3` 下で実行）。`sync-dsh.sh` も `install.sh` と同じく
  ダウンロードを `.sha256` ファイルで検証し、不一致や `.sha256` の欠落・空の場合は理由をログに残して
  バイナリを置き換えません。`systemd/rdsh-sync.service` は低優先度で
  動かすので、`ExecStart` は各自のcheckoutに合わせてください

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

## 安全設計

1. agent loop・profile bootの再実装はしません。`exec`委譲のみです
2. slimは**環境変数の追加だけ**です（`RDSH_*` ヒントと `NODE_COMPILE_CACHE`）。本家が知らないキーは無視され、利用者自身の `NODE_COMPILE_CACHE` は上書きしません
3. `desktop`プロファイル拒否・dump排他など本家のエラー条件をRust側でも再現します
4. 読取系（tokens/search/compact/dump --native/serve API/inspect）は元ファイルを書き換えません
5. `--passthrough` はslim調整を無効化します。`./install.sh --restore` で元のDSHへ戻す場合はrustdshの保護も外れます。

現在のcheckoutは `cargo test` と `tests/regress.sh`、[必須チェック](CONTRIBUTING.md)で検証します。
[再現可能な性能測定](docs/BENCHMARKS.md)では、入力と修正前後の出力一致も確認します。

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
- **`rdsh tui` や無指定の `rdsh boot` が失敗する**：dsh 0.2.0は `tui` を同梱しません。
  `rdsh web` や `rdsh --profile headless` を使うか、無指定の `rdsh boot` 用に
  `RDSH_DEFAULT_PROFILE=web` を設定してください
- **プロファイル名がサブコマンドと被る**：`dsh --profile <name>` 形式で起動してください
- **元に戻したい**：`./install.sh --restore`（退避した本家を復元）
- **`--tokens` の `?` 付き表示**：zstdフレームヘッダーからも `zstd` CLIからも展開後サイズを読めなかったため、保存サイズ/4の概算を表示している印です
- **NODE_COMPILE_CACHEを使いたくない**：`RDSH_NODE_COMPILE_CACHE=0`（または `--passthrough`）。自分で設定した `NODE_COMPILE_CACHE` は常に尊重します

## クレジット

アイディア： [@studio_yebisu](https://x.com/studio_yebisu)、
[@remydre8](https://x.com/remydre8)。

## ライセンス

MIT（[LICENSE](LICENSE)）です。
