# Changelog

All notable changes to this project are documented here.
Format follows Keep a Changelog, versioning follows Semantic Versioning.

## [Unreleased]

### Added

- セットアップ手順書 `docs/SETUP.md` を追加しました。CLI に不慣れな人向けに、AI エージェントへそのまま
  読ませる前提で書いた実行手順です。導入、接続先を 1 つ選んでつなぐ（OpenAI・OpenCode Go・Command Code・Ollama）、
  推奨プラグインの導入、会話の開始、詰まったときの早見表までを 1 ステップずつ並べています。

## [0.13.0] - 2026-10-28

### Added

- DSH **0.2.2-alpha.2** に対応しました。厳格なツール境界の監査済みアダプターに `dsh-tools-0.2.2-alpha.2` を追加し、
  0.2.2 でツールサービスが Cordis 上へ移ったのに合わせて、境界の注入位置をアダプターごとに持つようにしました。
- `rdsh models efforts` を追加しました。Ollama／Ollama Cloud の経路について、`POST /api/show` が返す
  モデルごとの推論段階を読み、`reasoningEfforts` が無いモデルだけを補完します。手で選んだ一覧は書き換えず、
  ON/OFF だけのモデル・推論非対応のモデル・取得に失敗したモデルは、段階を推測せず理由付きで報告します（#992）。

## [0.12.2] - 2026-10-27

### Fixed

- DSH **0.2.1-rc.4** に対応しました。厳格なツール境界（`features.agent_tool_sandbox` / `RDSH_SECURITY=1`）の
  監査済みアダプターに `dsh-tools-0.2.1-rc.4` を追加し、`rdsh-mcp-exposure` と
  `rdsh-llm-muse-code-subscription` の peer 範囲にも rc.4 を入れました。
  rc.4 の `lib/bin.js` と dsh-tools の `lib/index.js` は rc.3 と同一のため、ダイジェストは同じ値です。

## [0.12.1] - 2026-10-26

### Added

- 視覚回答プラグイン（dsh-intelligent-ui、cwd514、MIT）を `plugins/dsh-intelligent-ui` に同梱しました。
  `plugins/install.sh` と `rdsh desktop install` は GitHub から取得せず同梱版を入れ、web/desktop で既定で有効になります。
- `rdsh desktop install` でも、`features.feedback` が明示的にオンでなければメッセージのフィードバック面を
  無効化する同梱プラグインを入れるようにしました（CLI インストーラと同じ既定）。
- `rdsh features on feedback` で、既に入っているフィードバック無効化プラグインを外すようにしました。

### Fixed

- GPUIコンポーザで通常文字が二重入力される問題と、Waylandで通常Enter・Shift+EnterがIME変換中と誤判定される問題を修正しました。
- GPUIデスクトップの既存書式・未使用コード・Clippy警告を整理し、依存proc-macro-error2の公開宣言を修正して将来のRustとの互換性警告を解消しました。
- dsh互換の委譲で非UTF-8を含むPOSIX引数を保持し、nativeコマンドの不正引数でプロセスが異常終了する問題を修正しました。
- computeのtext・max_tokensの型不一致を明示的なエラーで返し、省略時の既定値と後続要求の処理を維持するようにしました。
- スマートフォン幅でrdsh設定本文が狭くなる問題を修正し、既存のモバイルレイアウトを適用しました。
- Windows のアプリ起動は現在の既定ブラウザを使い、対応する Chromium 系ブラウザでは
  専用ウィンドウと普段のブラウザプロファイルを使用し、Google などのログイン状態を
  引き継ぎます。最後に使ったプロファイルを選び、`RDSH_BROWSER_PROFILE_DIRECTORY` で
  固定もできます。Dashboard インストーラーは
  RDSH の公式アイコンを持つスタートメニュー項目を作成し、`-DesktopShortcut` で
  デスクトップにも追加できます。ショートカットは Unicode API で保存するため、
  日本語を含む保存先でもシステムの ANSI コードページに依存しません。

## [0.12.0] - 2026-10-24

### Fixed

- `curl … | sh` で入れた同梱プラグインが、ランチャーの探す場所ではなく
  `PREFIX/share/rdsh` に展開されていました。`rdsh plugins status` が見つけられず、
  以後の `rdsh plugins install` も同梱 tree を解決できませんでした。ランチャーが
  探索する `PREFIX/../share/rdsh`（FHS の bin と share の並び）へ展開するよう修正。
- Windows の `install.ps1` でも、`-FromRelease` で入れた環境に同梱プラグイン（設定の
  **rdsh** タブ、更新バナーなど）が付くようにしました。従来は `-Desktop` 指定時だけ
  Desktop プロファイルへプラグインを入れており、Web プロファイルは空のままでした。
- リリースの `rdsh-plugins.tar.gz` を `release-plugins-digests.tsv` で検証し、
  `%LOCALAPPDATA%\rdsh\share\rdsh` へ展開してから `rdsh plugins install --profile web` を
  実行します。展開前に `tar` で一覧を取り、`plugins/` の外へ出るパスを拒否します。
- checkout 上で実行した場合は従来どおり手元の `plugins/` を使います。取得に失敗しても
  インストール自体は止めず、理由と次の一手を表示します（`RDSH_SKIP_PLUGINS=1` で抑止）。
- `curl … | sh` で入れた環境でも、同梱プラグイン（設定の **rdsh** タブ、更新バナー、
  モバイル幅レイアウトなど）が付くようにしました。従来は checkout 上でしか
  `plugins/install.sh` を実行できず、リリースの tar.gz にはバイナリしか入っていないため、
  設定タブも更新バナーも現れませんでした。
- リリースに `rdsh-plugins.tar.gz` を追加し、`install.sh` が同じタグから取得して
  `PREFIX/share/rdsh/plugins` に展開してから同梱インストーラを実行します。ダイジェストは
  新しい台帳 `release-plugins-digests.tsv` で検証します（`release-digests.tsv` は 4 つの
  Unix アーカイブ専用のままでなければ、公開済みの旧インストーラが全体を拒否します）。
- 展開先は `PREFIX/share/rdsh/plugins` なので、以後の `rdsh plugins install` も
  同じ tree を見つけられます（従来は `not in .../share/rdsh/plugins` で失敗）。

### Added

- サブエージェントの **provider・model・reasoning effort** を設定画面から選べるようにしました。
  `plugins/rdsh-subagent-route` がプロファイルの `cordis.patch.yml` にある `tool-subagent`
  の `agentOptions` を読み書きし、DSH 自身が次の子から適用します。推奨ティア（既定 off）に
  追加したので `rdsh plugins install --recommended=subagent-route` で入ります。

### Changed

- 厳格なツール境界（`features.agent_tool_sandbox` / `RDSH_SECURITY=1`）が DSH **0.2.1-rc.3** を
  監査済みランタイムとして認識するようにしました。dsh 本体と `@deepseek-ai/dsh-tools` の
  マニフェスト、およびツール実行ファイルの SHA-256 を rc.3 の実物から記録しています。rc.3 では
  `dsh-tools` のエントリ内容が alpha.3 と変わったため、旧アダプターのままでは委譲実行が
  `UNSUPPORTED_RUNTIME` で拒否されていました。
- `rdsh-mcp-exposure` と `rdsh-llm-muse-code-subscription` の peer 範囲に `0.2.1-rc.3` を
  加えました。rc.3 環境で導入しても不一致の警告が出ません。

## [0.11.0] - 2026-10-22

### Added

- サイドバーの **Feedback** 行を隠す `plugins/rdsh-no-feedback-client` を追加しました。DSH の
  アカウントメニューは Settings / Feedback / Sign in を固定で組み立てており、既存の3パッケージ
  無効化では行だけが残って機能しないフォームを開いていました。サインアウト時のメニューに限って
  非表示にします（サインイン中のメニューは変更しません）。`features.feedback` が off のとき
  `rdsh-no-feedback` と一緒に導入されます。

### Security

- リリースビルドの `uses:` を 40桁コミット SHA に固定しました。可変 ref の上流書き換えで
  公開バイナリへ任意コードが混入する経路を塞ぎます（#890）。
- CD は安定版を `--latest=false` で公開し、digest 台帳が main に入った時点で
  `mark-release-latest` が Latest を切り替えるようにしました。台帳 pin 前に
  documented な導入コマンドが旧版を入れる食い違いが起きません（#892）。

- `rdsh search` と `rdsh search-web` の人間向け出力から制御文字を除きました。検索対象の
  ファイル名・一致行・検索結果の URL に ESC や OSC 52 が入っていても、端末の行消去や
  クリップボード書き換えが起きません（#889、#896）。機械可読出力は従来どおりです。
- rdsh が `$DSH_HOME` を最初に作るとき、ディレクトリを 0700 で作成するようにしました
  （umask に依存しません）。既存ディレクトリのモードは変更しません（#891）。
- `.credentials.yaml` が他ユーザーから読めるモードのとき、読み込み時に警告するようにしました
  （dsh は 0600 以外を読まないため、黙って空になるのを避けます）（#893）。

- `rdsh provider add` が、モデルの画像入力対応を自動で判定して `input: [text, image]` を
  書くようにしました。Ollama 系は `POST /api/show` の `capabilities` を、それ以外は
  `GET /models` の `architecture.input_modalities`／`input_modalities`／`capabilities` を読みます。
  手動指定は `--input text,image`（`text` は必須、未知の値は拒否）。宣言が無いモデルには
  `input:` を書かず、dsh の既定（テキストのみ）に任せます。

## [0.10.0] - 2026-10-21

### Fixed

- 外部コマンド起動の信頼境界を強化しました。git 起動は PATH からの信頼付き
  解決＋`-c core.fsmonitor=false`＋`GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL`
  の固定を行い、systemctl・npm/pnpm・`RDSH_DSH_BIN` も共通の owner/mode
  検査（exec_trust）を通します。汎用 `PREFIX` は探索から外しました（#826）。
- `rdsh worker-scope policy` の判定側 probe path を宣言側と同一規則で検証し、
  `forbidden_paths` を読み取りにも適用、交差は forbidden 部分木の減算後に
  成立判定へ変更しました（#827）。
- strict監査（RDSH_SECURITY=1）で dsh 本体 `lib/bin.js` の SHA256 を
  ADAPTER監査表に追加し、境界設置前に内容照合するようにしました。偽ツリー
  （manifest一致のみで bin.js 差し替え）を拒否します。strict 経路では
  `NODE_COMPILE_CACHE` も除去します（#824）。
- `rdsh search-web` の接続先を既定でループバックのみに制限しました。
  ループバック以外は `SEARXNG_ALLOW_REMOTE=1` で明示許可、リンクローカルと
  キャリア級NAT帯は常に拒否します。`https://` 接続に対応し、ログや `--json`
  には接続先のパスをマスクして出力し、検索結果に現れた制御文字は端末へ届く
  前に除去します（#828）。

- `rdsh cloud` のJSON入力を128 MiB以下の通常ファイルに制限し、読込中の
  サイズ増加も検出する。巨大なplan/request/leaseの無制限読込を防ぐ（#825）。
- `RDSH_NODE_COMPILE_CACHE=<ディレクトリ>` でNodeコンパイルキャッシュの
  出力先を指定できるようにしました。従来は `0` による無効化のみで、
  `$HOME` が揮発する環境ではキャッシュが毎回作り直しになりました。
  既存の `NODE_COMPILE_CACHE` が優先される挙動は変更なし（#864）。
- 0バイトのまま残った `.credentials.yaml.lock` を、mtimeが猶予期間（5秒）を
  過ぎた古いマーカーとして收回するようにしました。書き込み前のクラッシュで
  この状態になると以降の起動がタイムアウトし続けるため、実運用では手動削除が
  必要でした。PID記録を持つマーカーの收回条件（所有者の死の確認）は変わりません。
  上流 `dsh-atomic-write` の同一挙動はこのリポジトリの修正対象外です（#865）。

### Added

- `NODE_COMPILE_CACHE` が育ちすぎているとき（512 MiB または 5 万ファイル超）に、
  片付け方を一度だけ表示するようにしました。削除はせず、同じ確認は 24 時間に一度だけです。
  キャッシュが大きいと起動が逆に遅くなるためで、計測は時間と件数に上限を設けています（#864）。

- Ollama 系のプリセットで `--discover`／`--model` を使うと、`POST /api/show` から
  モデルごとの thinking 制御を読み、`reasoningEfforts` を自動で書くようにしました。
  名前付きの段階（low・medium・high など）はそのまま書き、ON/OFF だけのモデルや
  推論非対応のモデルには段階を書かず、その旨を表示します。従来どおり全モデルに
  同じ一覧を仮定しません。`--no-probe` で問い合わせを止められます。
- `rdsh provider detect` が Ollama Cloud 公式の `OLLAMA_API_KEY` も
  `ollama-cloud` 経路の資格情報として扱うようにしました。
- `rdsh setup` と `rdsh setup --web` が、検出した経路のうち鍵が揃っているものを
  自動で設定へ登録するようにしました。既にある経路は変更せず、鍵が無い経路は登録しません。
  `--no-auto-import`（または `--dry-run`）で自動登録を止められます。
  `setup --web` の画面では登録済みの経路に「登録済み」を表示します。
- `rdsh provider detect` を追加しました。環境変数、dsh の保存済みキー、OpenCode の
  独自プロバイダー、待ち受け中のローカルサーバーから、使えるプロバイダーを検出します。
  dsh 本体がカタログで解決できるものと、rdsh で経路が必要なものを分けて表示し、
  キーの値は表示しません。
- `rdsh provider import` を追加しました。検出した経路のうち、鍵が揃っていて
  書き込めるものだけを `cordis.patch.yml` へ登録し、モデルは `GET /models` から取得します。
  鍵が見つからない経路は未登録として表示し、推測した値は保存しません。
- `ollama-cloud` プリセットを追加しました（`https://ollama.com/v1`、キーは
  `OLLAMA_CLOUD_API_KEY`）。ローカルOllamaのダミーキーと混ざりません。
- `rdsh provider add ollama` を追加しました。ローカルのOllamaへはキー入力なしで接続でき、
  接続先は `http://127.0.0.1:11434/v1` 固定です（別ホストは `--base-url`）。
- `rdsh provider add --effort` で、経路内の全モデルの推論強度（reasoningEfforts）を
  指定できるようにしました。`low,medium,high`、`label=value` 形式、`--effort none` で
  段階を持たないモデルとして宣言できます。Ollamaのプリセットは gpt-oss:20b の low・medium・high を
  記録し、記録のないモデルには段階を書かず注記します（dshでは推論非対応として扱われるため）。
- `rdsh rustxng install` が追加されました。RustXNG の最新リリースを
  `~/.local/bin` へ導入します。サイドカーが見つからない状態で
  `rdsh search-web` や `rdsh rustxng start` を使うと、この導入を自動で
  行ってから起動します（`RUSTXNG_SKIP_INSTALL=1` で自動導入を止められます）。
  サイドカーは依存の無い単一バイナリです（バイナリ約14MB、常駐メモリー
  約10MB、アイドル時CPU 0%）。低スペック機でも Docker 等の追加スタック
  なしで動きます。

### Changed

- Web検索（search-web）を既定ONにしました。無効化は
  `rdsh features off search-web` で明示的に行います。ローカル状態画面
  （serve）の既定OFFと、`extras.enable` の従来形式は変わっていません。

- DSH の Like/Dislike と /feedback 画面（feedback 機能）を既定OFFにしました。
  rdsh 固有の不具合が DSH 本家へ送られないようにするもので、既定では
  `rdsh-no-feedback` バンドルを導入して無効化します。本体の画面へ戻す
  ときは `rdsh features on feedback` を保存してからプラグインを導入し、
  DSH を再起動してください。
- 設定画面の狭いカードで、フォームの入力欄が潰れる問題を直しました（#855）。
- `rdsh update auto on` が、所有者・権限を検証せずに同期スクリプトを毎日のタイマーへ
  登録しないようにしました。検証を通らないスクリプトは登録されず、意図して使う場合だけ
  `--force` が必要になります（#856、#823）。
- 依存を更新し、RUSTSEC-2026-0381 / RUSTSEC-2026-0382 の対象（rustls-webpki、
  webpki-roots）を修正版へ上げました（#871）。

- Web UI のシェル資産を Rust 側で起動時に一度だけ事前圧縮し、同梱の
  `rdsh-web-cache` サーバープラグインから配信するようにしました。このプラグインは
  Web プロファイルの必須セットに含まれるため既定で有効になり、
  `Cache-Control: immutable` と `ETag`（`If-None-Match` 一致時は 304）が付きます。
  計測で転送量が 26.6%、4 資産の取得時間が 42.4% 減りました。
  切り戻しは `rdsh features off web_assets` です（#863、#870）。

## [0.9.2] - 2026-10-19

### Changed

- `rdsh serve` のダッシュボード（`src/ui.html`）を、初めてでも迷わない
  言い回しと操作に刷新しました。接続は「3つのステップ」表示、状態は
  「dsh は動いています」の1文で確認できます。セッション一覧は更新時刻と
  サイズを行形式で示し、技術的な詳細は「くわしい情報」に集約しました。
  トークンをURLやページに残さない設計は変えていません。
  スクリーンショット（`docs/screenshots/showcase/serve-dashboard-*`）は
  新しいUIに差し替えました。

### Fixed

- DSH の回答に含まれる画像が、プレビュー用の inline-block ボタンに入れ子になっていたため、
  テキストと同じ行にある図は行の残り幅へ押し込まれ、段落が図の周りに回り込んで崩れ、
  ラベルも読めない大きさになっていました。同梱の共有スタイルシートがこのラッパーを
  block にし、画像を回答カラムの幅まで使えるようにします（DSH **0.2.0-rc.2** の
  Web UI で確認）。セレクタは DSH 側のクラス名（`imageButton`）にだけ依存するため、
  ハッシュが変わっても効き続け、ダッシュボードと setup 画面には影響しません。

- 「dsh 本体のアップデート」ボタンを押しても更新されず、通知が繰り返し出る
  不具合を直しました。\`~/.local/opt\` 配置（install.sh の手動配置）の dsh は
  npm の管理外のため、sync-dsh.sh はこれまで更新を常に見送っていました。
  書き込める配置なら、所有する prefix 経由で更新します。更新前に tree 全体を
  バックアップし、導入や検証に失敗したら元へ戻します。sync 自体は失敗後も
  rdsh の更新を続行します。書き込めない配置はこれまでどおり報告だけで
  触れません。

## [0.9.1] - 2026-10-18

### Added

- `rdsh plugins status|install` が必須プラグインのカタログ
  （`src/plugin_catalog.json`、バイナリに同梱）を読み、プロファイルに欠けている
  パッケージを `dsh plugin --profile <name> add` で補完します。必須ティアは
  `plugins/install.sh` にしか無く、このスクリプトを自動で呼ぶ経路が無いため、
  バイナリを更新しても `$DSH_HOME/profiles/<profile>/package.json` は
  書き換わらず、必須プラグインが欠けたままでした。`--json` は schema 1、
  `--recommended=none|all|starter|id,id` は `plugins/install.sh` と同じ選択を
  提供し、`--profile desktop` は `rdsh desktop install` へ転送します（#816）。
- `rdsh doctor` が、必須ティアの不足している初期化済みプロファイルごとに
  1行で不足数と修正コマンドを表示します。Web プロファイルのインストールでも
  必須プラグインを自動で入れるようになりました（#816）。
- デスクトップアプリが会話履歴のページング・ショートカット・会話検索・ダークテーマに
  対応し、会話タイトルを全件取得して ✎ から名前を変更でき、プロジェクトの
  折りたたみとアーカイブ、シャチのアイコンを使えるようになりました（#806、#810）。
- 設定タブ「rdsh」がカード表示になり、グループを折りたためるようになりました。
  ローカル Web UI にはコンテキスト・実行・更新のゲージが付きます（#810）。
- 更新カードが dsh 本体の更新も併記し、単独でも表示します。実行中の dsh 版は
  ホストのエントリから特定し、通知は × で閉じられ、dsh の更新はユーザー所有の
  prefix へ入ります（#801、#803）。
- `rustxng` をローカル検索バックエンドとして選べるようになり、結果は HTML ではなく
  JSON API から取得します（#805、#815）。
- OpenCode の既存ルートを Web と TUI のプロファイルへ同期できるようになりました（#813）。
- オプトインの swarm / sandbox CLI を追加しました（#809）。

### Changed

- `rdsh desktop install` の既定プラグイン構成に更新バナーが入りました（#814）。
- ドキュメントを追加・更新しました: Discord コミュニティ、rdsh と dsh の違い、
  デスクトップの操作、TUI の初期設定、Node.js 22 の入手方法（#807、#808、#810）。

### Fixed

- Web サービスを予期しない終了から復旧し、再起動をサービスツールから切り離して
  引き渡すようにしました（#811）。
- 読み取り側が先に閉じたときの EPIPE で panic せず静かに終了します（#804）。
- 設定カードで失われていた tokens 見出しを戻しました（#810）。
- macOS の swarm 検証がプライベートな検証済みスナップショットを使うようにしました（#809）。

## [0.9.0] - 2026-10-18

### Added

- `rdsh desktop web-ui status|on|off`（`--json` 可）と、`rdsh setup --web` の
  設定画面から、ブラウザ用のローカル Web UI を systemd ユーザーサービスとして
  常時起動できます。既定は常に OFF で、有効にしたときだけユニットを作成して
  enable し、状態・稼働中の URL・次の一手を表示します。トークンは 0600 の
  環境ファイルに置き、起動した URL はホストのキャッシュへ 0600 で書きます
  （#793、#796、#798）。

- ネイティブ・デスクトップアプリと Web UI が、アシスタントの返答を
  見出し・リスト・引用・コードブロック（言語ラベルとコピーボタン付き）として
  描画し、ツール行は進行・成功・失敗の状態色、推論行は既定で折りたたんで
  表示するようになりました。デスクトップは依存を増やさない自作の描画器、
  Web UI は DOM ノード構築のみ（`innerHTML` 不使用）で実装しています
  （#796）。デスクトップの IME 入力は `EntityInputHandler` 経由になり、
  Wayland の text-input-v3（fcitx5 など）から日本語を入力でき、変換中の
  marked range と preedit の選択範囲も正しく反映します（#788）。

- デスクトップアプリが起動時に、PATH・ローカル導入・npm グローバルの
  `dsh` から `--version` に応答する最新のものを選び、本体だけを更新しても
  新しいビルドへ乗り換えられるようになりました。`--check-host` は使用中の
  ランチャー・バージョン・接続状況・セッション数を表示し、`--online` を
  付けると npm の公開版と比較して更新の有無を示します。Web UI とデスクトップ
  GUI は「dsh X が利用可能」バッジでも知らせます（#788、#793）。

- デスクトップアプリと Web UI が、上流 DSH 0.2.1-rc.2 でも動くことを実機で
  確認しました。特定ビルドだけを試す `RDSH_DESKTOP_NO_ATTACH=1` を追加し、
  `--serve-web` は `RDSH_DESKTOP_WEB_TOKEN` でトークンを固定できます（未指定
  なら乱数）。`apps/rdsh-desktop/scripts/verify-harness.sh` は指定ビルドに
  対してセッション一覧・モデルカタログ・ライブイベントを検証します（#788）。

- UI（ドキュメント）ギャラリーを rdsh 0.8.0 向けに更新: 3ステップの
  セットアップウィザード、ダッシュボードの簡易／詳細表示、GPUI デスクトップ
  アプリ、実際の CLI 画面、0.7.0 → 0.8.0 の更新バッジを撮り直しました
  （#792）。

- `search.dsh_search_provider` pins the upstream web-search provider
  (`DSH_WEB_SEARCH_PROVIDER`) for delegated DSH runs, so an agent's
  `web_search` can use a local SearXNG provider plugin. Empty by default; the
  caller's own environment value still wins, a value that is not a plain
  provider id is refused, and the id must be registered upstream (#795).

- `rdsh search-web --auto-start` (SearXNG provider) starts the bundled
  `docker-compose.searxng.yml` through `docker compose`, `docker-compose`,
  `podman compose` or `podman-compose` when the loopback endpoint is down,
  waits up to 10 seconds and then searches. The compose project and its settings
  are compiled into the binary, so an installed `rdsh` no longer reports the
  file as missing and the published port follows `SEARXNG_URL`. A host without
  a container runtime gets one sentence explaining why search was skipped
  instead of a hang or a panic; `rdsh doctor` reports SearXNG reachability,
  the container runtime and the compose file it would use (#794).

- `rdsh search-web --provider ollama` uses Ollama's hosted Web Search API
  with `OLLAMA_API_KEY`, up to 10 results, and the existing text/JSON format.
  SearXNG stays the default; cloud search requires explicit selection and the
  existing search feature switch. No new dependency or model route is needed.
  The localized CLI help and Web search guide also link to Tavily and its
  official quickstart as an API service reference (#789).

- License policy: `deny.toml` pins the allowed dependency licenses, and the
  `Rust dependency audit` job now also runs
  `cargo deny check licenses sources` with
  `include-dev = true` on every pull request, push to `main` and weekly run, so
  a copyleft license reachable only through a dev-dependency or an unknown
  registry cannot enter the dependency tree unnoticed (#790).

- [Third-party licenses](THIRD_PARTY_LICENSES.md) records the pinned upstream
  DeepSeek Harness packages, the permissive crate set and the trademark
  disclaimer; both README license sections link to it (#790).

### Changed

- Beginner starter set on by default: `PROFILE=web` and `PROFILE=desktop`
  now install Japanese translation, bounded exploration subagents, sound
  notifications, the Git panel and visual answers (`dsh-intelligent-ui`)
  without any choice, so a newcomer from Codex or Claude Code gets a capable
  setup. `rdsh desktop install` (and `install.sh --desktop` /
  `install.ps1 -Desktop`) also attaches `rdsh-answer-guard`,
  `rdsh-translation` and `rdsh-subagent-optimizer` when the checkout carries
  them, plus `dsh-intelligent-ui`; `--no-intelligent-ui` skips it.
  `plugins/install.sh --recommended=starter` selects the set on any profile;
  `headless` still installs the essential tier only. `ui-comfort`,
  `easy-work` and `compute` stay opt-in (#791).

### Fixed

- A consumer that closes the pipe early no longer makes the process dump core:
  `rdsh doctor 2>&1 | head` used to panic on EPIPE (exit 134 with a core dump),
  and now ends quietly while every other panic keeps the default hook.

- The first-run installer no longer aborts on `rdsh doctor`. It piped the report
  through `head`, and closing that pipe early made the process panic on EPIPE and
  dump core on a Node-less host; the installer now captures the report and slices
  it, and the regression suite fails if the pipe comes back. The browser setup
  screen only opens when `DISPLAY` or `WAYLAND_DISPLAY` exists, so a serial or
  SSH install prints the next step (with the `ssh -L` port-forward hint) instead
  of waiting on a page nobody can see (#799).

- The desktop app attaches only to a literal loopback address and replaces its
  host cache atomically, and `--stop-host` signals only the PID recorded with
  the spawned binary instead of any command line mentioning `dsh` and `web`.
  A cached cookie the host rejects is discarded before the next candidate, so a
  stale cache no longer surfaces as a `401` (#784, #793).

- A completed assistant response no longer disappears in the Web UI when the
  conversation stream reconnects, a failed connection shows its recorded reason
  instead of staying on "connecting", and a question banner keeps the selected
  choice and the free-text draft across its state refreshes (#793).

- `rdsh provider add commandcode --discover` keeps only the listed models
  whose `supported_endpoints` include Chat Completions, so Claude models that
  answer on `/v1/messages` only are no longer registered on a route that would
  fail every request; listings without the field are unchanged (#785).

- An empty `RDSH_BENCH_MAX_OVERHEAD_MS` is rejected instead of being read as
  zero, which used to zero every operation budget and report a regression rather
  than a configuration error (#781).

- Every device revocation waits for its persistence to finish, so a revoked
  device cannot reappear after a restart (#787).

- The agent UI surface-replacement tests cover the retry-failure path, and a
  `#[test]` attribute lost in a rebase is restored (#783, #796).

### Security

- Native desktop app: the host cache directory, its `host.log` and the Web UI
  `webui.url` file are owner-only (0700/0600) instead of inheriting the umask.
  Both files hold the token-bearing ready URL, so on a shared machine with the
  usual 0022 umask any local user could read them. The Web UI URL is now
  written owner-only from creation, and files left by an earlier run are
  tightened before they are written again (#797).

## [0.8.0] - 2026-10-18

### Added

- Native desktop app: `apps/rdsh-desktop` is a Rust/GPUI window that follows
  the upstream design tokens and drives the same HTTP/WebSocket API, so day-to-day
  conversation work no longer needs the Electron shell, a bundled Chromium or a
  local web server. It has a project-grouped sidebar with real conversation
  titles, a provider-grouped model picker, live assistant streaming with stop,
  approval prompts and user questions (`$events` waterfall), tool and reasoning
  rows, and new conversations. `cargo run --release` starts the window; the
  `--dump-ui`, `--dump-titles`, `--probe` and `--dump-live` modes verify
  the same data headlessly. Linux uses the Wayland/Vulkan backend (xkbcommon and
  xkbcommon-x11 at build time); Windows and macOS use the default GPUI features.
  The release archives do not ship it yet (#752, #765, #771, #776).
- First-run wizard: `rdsh setup --web` is now a three-step page (check,
  connect AI, done) that opens already connected through a protected local
  launcher file, so the token never reaches argv or the terminal and nobody
  has to paste it. It detects Node.js, dsh, Codex, OpenCode and the Desktop
  app; shares a found Codex/OpenCode login with one click (the same persistent
  `--select SOURCE:CREDENTIAL --import` path); starts `codex login` /
  `opencode auth login` in a new terminal window; saves DeepSeek, OpenAI or
  Anthropic keys; and starts the first conversation (Desktop app, `rdsh tui`
  or the web profile). The token-paste box remains as the fallback (#753).
- Installers open that wizard after an interactive install (`install.ps1
  -NoSetup` / `install.sh --no-setup` skip it, as does `CI`). On Windows the
  installer also offers `npm install -g @deepseek-ai/dsh` when dsh is missing
  and adds an "rdsh setup" Start menu shortcut (#753).
- Project dashboard: a simple view (default) shows only the current state,
  what waits for the person, the agent's screens, tasks and reports;
  "くわしく表示 / Detailed view" brings back every other panel. Typography
  uses a Japanese system font stack with calmer sizes and light motion that
  respects reduced-motion settings (#738, #753).
- `rdsh provider add commandcode` registers Command Code's Provider API
  (`https://api.commandcode.ai/provider/v1`, OpenAI-compatible,
  `COMMANDCODE_API_KEY`) as a profile route; `--discover` reads its
  `GET /models`. The setup key store also accepts any API-key name a profile
  declares through `apiKeyEnv` and that matches `^[A-Z][A-Z0-9_]+$`, so
  `rdsh setup` and the setup UI can save route keys (Command Code, OpenCode Go,
  a hand-declared route) without a fixed three-name list, and still refuse
  anything undeclared or malformed before writing. `docs/PROVIDERS.md`
  documents the endpoints, the Go-plan `403 upgrade_required`, the
  `/messages`-only Claude models and the ZDR header left to #484 (#450, #762).
- `docs/PHILOSOPHY.md` and `docs/PHILOSOPHY.ja.md` explain why rdsh keeps the
  upstream Node.js agent runtime and hardens only the hot boundary, with the
  measured launch and hook costs cited from `docs/BENCHMARKS.md`. Both READMEs
  and `docs/ARCHITECTURE.md` link to it (#777).
- `docs/ZDR.md` defines the zero-data-retention route requirements: what rdsh
  guarantees, what it leaves to the provider, and the hand-maintained route
  table with its evidence fields. This is a requirements document with no
  implementation yet (#763).
- `rdsh provider list` and the static adapter catalog moved to native Rust, and
  the dashboard server now loads only when a dashboard actually starts
  (#699).

### Fixed

- Privacy defaults: `features.telemetry` and `features.discord` now default
  off. Delegated `dsh` runs receive `DSH_TELEMETRY_DISABLED=1` unless
  `RDSH_TELEMETRY=on` is set, an existing value is never overwritten, and the
  bundled settings plugin keeps `features.discord` and the legacy
  `discord.enabled` in step. `docs/PRIVACY.md` records the limits (#735).
- Project dashboard stylesheet: two unclosed rules made browsers drop roughly
  the last 1,100 lines of CSS (workspace grid, attention inbox, mobile layout
  and more). A unit test now keeps the stylesheet balanced (#753).
- Setup wizard: on Windows the `start` command read the bare `rdsh` as the
  window title, so the login and chat terminals never ran the intended
  `cmd.exe /k <program>`; an empty title is now passed (#753).
- Desktop app: a failed `Set-Cookie` parse embedded the raw header (the signed
  session cookie) in the error, which `main.rs` logged; failures now report the
  byte length and field count only (#775).
- Agent UI: the Windows surface rename retries `EPERM` and concurrent surface
  writes are isolated instead of overwriting each other (#759, #769).
- Dashboard: macOS exact-container binding in the worker boundary, watched
  Store PowerShell aliases, review-evidence directory canonicalization,
  closing interrupted Harness proxy streams, and the tray launch through a
  Windows Store alias (#739, #756, #757, #760).
- Windows runtime JSON replacement keeps its retry bound without replaying a
  completed write (#749).
- `dsh-env` accepts a commented, single-quoted or command-line
  `dangerouslyAllowAllBuilds` value instead of treating it as a full approval
  (#748, #764, #773).
- Serial proxy: `Connection`-nominated headers are no longer forwarded
  (#761).
- `rdsh doctor` accepts a quoted Windows JS entry path, and pnpm 9 no longer
  points at a fix that never prints (#734, #746).
- `guard.deny` keeps the Rust-side limit (#745).
- worker-git benchmark: the native sample is pinned into a dedicated execution
  copy with its source and SHA-256 recorded, JavaScript and native calls are
  dispatched directly, and every operation row carries seven unrounded samples
  plus a `measurementBoundary`; the macOS arm64 release evidence is stored in
  `docs/evidence` (#778).
- worker-git benchmark: `dirtyPaths` gets its own 30 ms Windows budget because a
  single `git status` never amortises the bridge process start; the multi-Git
  operations keep the 20 ms budget and `RDSH_BENCH_MAX_OVERHEAD_MS` still
  overrides every operation (#779).
- Test flake: macOS `accept` inherits the listener's `O_NONBLOCK`, so the
  provider fixture header read could panic with `WouldBlock`; the flag is
  cleared before reading (#780).

### Changed

- The beginner setup wizard now stores a shared Codex/OpenCode login and
  refuses undeclared or malformed key names before writing, and the dashboard
  view keeps calmer Japanese typography with reduced-motion support
  (#753).
- Test suites that depended on fixed paths, roots or backend assumptions were
  made native and portable: Windows fixtures use native identity and canonical
  temp paths, the dashboard GPU/Colima fixtures are gated on macOS, and the
  hermetic direct-model SDK suites run in CI (#750, #754, #772).
- CI: the plugin-security job isolates registry acquisition and retries
  offline (#737).

## [0.7.0] - 2026-10-17

### Added

- Release native Linux packages, `rdsh_<version>_amd64.deb` and
  `rdsh-<version>-1.x86_64.rpm`, built from `packaging/nfpm.yaml` with a
  pinned nfpm (v2.48.0) in a new `packages` CD job. `sudo apt install
  ./rdsh_*.deb` and `sudo dnf install ./rdsh-*.rpm` install `/usr/bin/rdsh`
  without a Rust toolchain or `install.sh`; README.md, README.ja.md and
  docs/FEDORA.md document both commands, and release verification refuses a
  missing, duplicated, mislabelled or tampered package.

- `packaging/` carries install manifests for the published macOS and Windows
  archives: `packaging/homebrew/rdsh.rb` (Homebrew, Apple Silicon and Intel),
  `packaging/scoop/rdsh.json` (Scoop) and the three `packaging/winget/`
  manifests (winget). Each one pins the exact v0.6.0 URL and SHA-256, with
  install commands and the update step in `packaging/README.md` and
  `docs/PACKAGE-MANAGERS.md`. `scripts/update-packaging-manifests.py`
  regenerates every pinned value from `release-digests.tsv` and
  `release-digests-windows.tsv` and verifies them with `--check`, so the
  manifests never drop out of sync with what the installers trust
  (#728).

## [0.6.0] - 2026-10-17

### Security

- `rdsh guard` normalizes a command string before deny matching: quoting
  (`r"m" -rf`), same-line variable assembly (`A=rm; $A -rf`), command
  basenames (`/bin/rm -rf /`), nested quoted commands (`sh -c "rm -rf /"`) and
  path traversal or symlink targets are folded into bounded candidate texts, so
  the structural patterns can no longer be displaced by obfuscation (the
  #29/#32/#33 semantics are unchanged, and block still exits 2 with the same
  stderr) (#708).

### Added

- `scripts/benchmark-node-vs-rust.py` and its
  `scripts/benchmark-node-reference.mjs` reference measure the PreToolUse hook
  (`rdsh guard`), `rdsh tokens` and `rdsh search` against equivalent Node.js
  work on one generated dataset, with output-equality oracles, a JSON report and
  every raw sample. README.md, README.ja.md and docs/BENCHMARKS.md name the exact
  command each number measures, so the ~0.90 ms headline is stated as
  `--version` process launch only and the hook is reported at ~2.0 ms per call
  including process launch (#706).

- `rdsh doctor` finds the original `dsh` through the nvm, volta, fnm, pnpm and
  `npm -g` directories when a non-interactive shell or a service unit never ran
  their initialization, while PATH and the local backups keep their resolution
  order, and Node discovery accepts the nvm layout
  (`~/.nvm/versions/node/vX.Y.Z`). It prints a Node/npm/pnpm environment block
  (en/ja/zh, and under `doctor --json` as `environment`) and reports the pnpm
  build-script policy with the approval command that matches the installed pnpm
  release. Warnings never change the exit status, which still depends on the
  original `dsh` alone (#707).

- `plugins/install.sh` now separates **essential** plugins (installed on every
  run and printed first) from **recommended** ones, and accepts
  `--recommended=all|none|list|id,...` (or the `RECOMMENDED` environment
  variable) so non-interactive runs select a set without a prompt. With a TTY it
  lists the recommended plugins and asks before adding them; without one the
  historical per-profile defaults are unchanged. `plugins/recommended.md`,
  README.md, README.ja.md and docs/DESKTOP-INTEGRATION.md document the tiers
  (#713).

- `install.sh` reports a host readiness check before it downloads or builds
  anything: the tools the chosen path needs (`curl`, `tar`, `gzip`, coreutils),
  the Node.js 22+ / original `dsh` state and whether `PREFIX` is writable, each
  with the host's own install command (`sudo dnf install -y ...` on rpm hosts,
  and the Debian, Alpine, Arch and openSUSE equivalents). Fedora, RHEL, CentOS,
  Rocky, AlmaLinux and Oracle Linux also get the optional `zstd`/`bubblewrap`
  packages, a `PATH` hint and a note on which glibc or static musl archive was
  chosen, so no musl package is implied. `tests/install-isolated.sh` covers the
  rpm branch with a faked `ID=fedora` on a Debian base (#714).

- `rdsh subagents defaults [--json]` prints the limits `rdsh subagents plan`
  applies to a request that omits `limits`, together with the `source`
  (`settings` or `builtin`). The planner's built-in numbers are now overridable
  once through the new `subagents` section of `rdsh.json`
  (`max_parallel`, `max_items_per_agent`, `max_weight_per_agent`,
  `budget_units`); a request key still wins, and a missing or unreadable
  settings document falls back to the built-in defaults so an unrelated corrupt
  file cannot block a plan. The exploration subagent plugin also exposes its
  effective admission policy as `createOptimizer(...).limits` (#715).

- `plugins/rdsh-translation` は、完了した英語・中国語回答のアクション行に
  「日本語訳で置き換える」を追加しました（#448 Step 2, #718）。表示専用の「日本語訳を表示」は
  そのままに、明示操作のときだけ`/ja-replace`が独立した翻訳を1回送り、
  `surfaceOp: { op: 'replace', startSeq, endSeq }`と`source.kind: 'rdsh-translation'`で
  対象回答のsurfaceノードを訳文に置き換えます。新しいターンも追指示のuserメッセージも追加せず、
  元の回答は追記専用ログと人間向けtranscriptに残ります。busy・対象なし・保護トークン欠落・
  session拒否・置換済みは追記せずエラーを表示します。DSHが置換をモデル可視surfaceだけに
  適用するため画面上の回答表示は差し替わりません（訳文はダイアログで確認できます）。

- `plugins/rdsh-ui-comfort` makes Enter deliberate in the DSH Web chat and
  adds a `rdsh 入力` settings section. A plain Enter in the composer inserts a
  line break and a second Enter inside 1.5 s sends; the goal editor no longer
  commits on Enter, including the Enter that confirms an IME conversion, so
  Ctrl/Cmd+Enter (or the check button) commits and Escape still cancels. Both
  behaviours default to on and every modified Enter, completion-menu Enter,
  key auto-repeat and IME composition stay with the shell. A profile gets the
  plugin with `dsh plugin --profile web add <repo>/plugins/rdsh-ui-comfort`
  (#716).

### Changed

- `rdsh serve` states its role in the header as the Audit & Performance Monitor
  for DeepSeek Harness in English, Chinese and Japanese, renders the build
  version and a role overview before the token is entered, and fills the doctor
  diagnostics, sessions and skills cards in parallel once connected, so the first
  paint no longer reads as an empty chat page (#705).

- Former-owner `sahenjp/rustdsh` issue and pull-request links in
  `dashboard/README.md`, `docs/evidence/*.md` and the workflow-board READMEs
  point at the canonical `jimoto-no-llm/rustdsh` repository, because the old
  `issues/N` paths answer 404 instead of redirecting. The docs link-check remap
  stays so a pull request opened before the unification still resolves (#704).

- `release-digests.tsv` and `release-digests-windows.tsv` pin the published
  v0.5.2 archives and move the `latest` row to v0.5.2, so `install.sh
  --from-release` and the automatic updater install the release GitHub marks
  Latest (#702).

- The bounded-exploration subagent plugin admits 3 concurrent runs by default
  instead of 2, matching the planner's own default wave width (`max_parallel: 3`
  in `src/subagent_plan.rs`), so one default `rdsh subagents plan` wave runs
  without queueing. Its queue wait default rises from 10 s to 120 s and the
  accepted ceiling from 60 s to 600 s: a 10 s deadline expired before a single
  scout run could finish, which made the documented 8-deep queue unreachable and
  turned queued work into `RDSH_SUBAGENT_WAIT_TIMEOUT`. The bundled
  `cordis.patch.yml` pins the same values and a test now fails if the two
  drift (#715).

### Fixed

- The Windows tray helper waits for readiness by observed startup progress
  instead of an absolute clock: `dashboard/windows-tray.mjs` re-arms a
  `TRAY_READY_STALL_MS` quiet window at spawn and at each startup phase, so a
  cold start that is still alive is no longer killed by a fixed deadline, and
  the diagnostics report `last_event` and `quiet_ms` (#717).

## [0.5.2] - 2026-10-16

### Fixed

- The dashboard artifact preview truncates text on a UTF-8 character boundary
  instead of splitting a multi-byte sequence, refuses a non-regular file with
  415 instead of opening it, redacts credentials in a URL without the previous
  regular expression, and discards a preview that a newer request replaced. A
  dashboard test and the browser E2E check cover the bounds (#698).

### Changed

- `sync-dsh.sh` replaces its own installed copy with the current script from
  `main` before it does any work, so a fix to the daily run (the model-catalog
  step, for instance) reaches every machine instead of waiting for a manual
  update. `RDSH_SYNC_SELF_UPDATE=0` turns the step off, a copy inside a git
  checkout is never touched, and an origin that is unreachable or returns
  something other than a shell script keeps the current copy; see
  [docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md) (#697).

- `release-digests.tsv` and `release-digests-windows.tsv` pin the published
  v0.5.1 archives and move the `latest` row to v0.5.1, so `install.sh
  --from-release` and the automatic updater install the release GitHub marks
  Latest (#695).

## [0.5.1] - 2026-10-16

### Added

- The daily auto-update run refreshes the provider model catalogs: `sync-dsh.sh`
  ends with `rdsh models sync --auto`, which appends the models a provider
  advertises that the profiles lack and reports a catalog it could not reach
  without failing the run. `rdsh features off models_sync` (the default is on)
  or `RDSH_MODELS_SYNC=0` for one run turns the step off; see
  [docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md) (#692).

### Fixed

- The translation plugin classifies a malformed `rdsh.json` as
  `settings.malformed` ("format is invalid") instead of the unreadable-settings
  message, and `ci.yml` runs the `translation-core` and
  `translation-client-crlf` suites so a regression fails CI (#691).

- The links job parses `.lychee.toml` again: lychee 0.24.2 rejects the unknown
  `headers` key, so the crates.io crate pages are excluded by pattern instead
  (#689).

### Changed

- Dependency updates: `sha2` 0.11.1, `@modelcontextprotocol/client` 2.3.1 in
  `plugins/rdsh-mcp-oauth`, `dependabot/fetch-metadata` 3 and
  `pnpm/action-setup` 6 (#685, #686, #687, #688).

- `release-digests.tsv` and `release-digests-windows.tsv` pin the published
  v0.5.0 archives and move the `latest` row to v0.5.0, so `install.sh
  --from-release` and the automatic updater install the release GitHub marks
  Latest (#690).

## [0.5.0] - 2026-10-16

### Security

- The unresolved Dependabot and Code scanning alerts are cleared in one change:
  the headless runtime and the MCP plugins pin `@modelcontextprotocol/client`
  to 2.3.1 and `fflate` to 0.8.3, and every npm manifest is registered with
  Dependabot (#564, #647, #663).

- The audited-runtime guard reports `RDSH_SECURITY[UNSUPPORTED_RUNTIME]`,
  `[RUNTIME_CHANGED]` and `[RUNTIME_RESOLUTION_MISMATCH]` again: the preload
  compares each adapter digest, honours `RDSH_TOOL_ADAPTER`, detects a
  resolution mismatch in its `resolve` hook and refuses to run the nested body
  when the runtime is not the audited one (#676).

### Added

- 完了した英語・中国語回答に「日本語訳を表示」ボタンを追加。現在のモデルへ
  独立した翻訳リクエストを送り、コード・パスと原文・会話履歴を保持して訳文を表示します。
  Web／Desktop向けの導入と、失敗時の再試行に対応します。画面とコマンドの文言は
  DSHのlocaleカタログ（en/zh/ja）経由です（#448 Step 1）。
- `rdsh` publishes to crates.io from the release tag. The `cd` workflow gained a
  `publish-crate` job that runs after the GitHub release, and the `exclude` list
  in `Cargo.toml` drops the media, docs, dashboard and test trees so the crate
  fits the 10 MB registry limit (about 1.6 MB instead of 173 MiB). `ci.yml`
  guards both with the `crate-package` check, so `cargo install rdsh` and the
  prebuilt archives ship the same program.

- `rdsh models` prints the provider model catalog and `rdsh models sync`
  refreshes it from each provider's own published catalog, so a new model
  becomes selectable without editing `rdsh.json` by hand. The command landed
  after v0.4.0 (#641) and therefore ships in the next release; see
  [docs/MODEL-ROUTING.md](docs/MODEL-ROUTING.md).

- `plugins/rdsh-answer-guard` recovers a turn whose reply was emitted only into
  the reasoning channel: DSH closes such a turn as `completed` (its
  `EMPTY_RESPONSE` check only sees a fully empty message) and the Web UI folds
  the reasoning away, so the reader sees no answer and the agent looks stuck.
  The guard watches the committed events and, at `agent/turn-stopping`, steers
  one notice asking the model to restate the answer as text — once per turn,
  never on an aborted turn, and never when a tool result is still owed. It is
  installed by `./plugins/install.sh` and `rdsh features off answer_guard`
  disables it. See [README](plugins/rdsh-answer-guard/README.md).

- rdsh-owned output speaks English, Simplified Chinese and Japanese across the
  CLI, the Web UI, the bundled settings plugin and the standalone dashboard:
  help, diagnostics, interactive setup prompts and policy validation follow
  `--language`, `RDSH_LANG`, `general.language`, then the OS locale,
  defaulting to English. Delegated `dsh` arguments, model output, JSON fields,
  files and protocol identifiers are never translated (#617, #675, #678).

- The parallel dashboard feature work landed in one integration (#652):
  history survives a project move, per-device permissions, a versioned human
  decision log, versioned project profiles, provider quota and retry status,
  conservative run-stall diagnostics, a cross-project overview, a causal
  timeline, prioritized notifications, project-scoped deep links, reusable
  workflow recipes, artifact preview, secret-safe replay manifests, safe
  project state migrations and CPU, RAM and port reservations are all in
  `dashboard/`.

### Fixed

- 更新通知を dismiss したら、その更新については再表示しない（新しい更新のときだけ通知する）。

- Windows debug builds no longer overflow the main-thread stack while clap
  builds its parser: `build.rs` reserves the same 8 MiB as Unix
  (`/STACK:8388608` for MSVC, `-Wl,--stack,8388608` for GNU) (#655, #656).

- The settings plugin truncates strings by Unicode scalar value instead of
  UTF-16 code unit, so a GUI save can no longer write an isolated surrogate
  into `rdsh.json` and break every CLI command; its limits now match the Rust
  side (`default_profile` 200, `searxng_url` 2000) (#636, #637).

- `rdsh logs` shows its own "no logs" text again instead of the generic
  directory message the multilingual change introduced (#670), and
  `rdsh desktop install --plugins-dir` absolutizes a relative directory before
  building the plugin specs (#669).

- A failed update keeps its reason on stderr (#651), and the rpm family check
  matches quoted IDs and the real Oracle ID (#662).

### Changed

- Dependabot patch and minor pull requests enable auto-merge once the required
  approval and required checks pass (`dependabot-automerge.yml`); major updates
  stay manual. `.github/project-settings.json` lists the `crate-package`
  required check (ten names), enables secret-scanning validity checks, and
  records `require_last_push_approval: false`, matching the live branch
  protection and `docs/PROJECT-SETUP.md`.

- `AGENTS.md` and `docs/PROJECT-SETUP.md` record the working agreements that came
  out of the v0.4.0 cycle: the nine required checks and the branch-protection
  switches that are deliberately off, pinning the installer ledgers after every
  release, and keeping the security page at zero open alerts.

## [0.4.0] - 2026-10-15

### Security

- The optional `rdsh-mcp-exposure` plugin pins its development
  `@modelcontextprotocol/client` to the patched line (2.3.1, override) instead
  of the 2.0.0 that the upstream `dsh-mcp-client` peer pulls in, clearing the
  high-severity GHSA-6qxp-vccf-f47h alert. Runtime resolution is unchanged: the
  plugin uses the host DSH's MCP client.

- `install.ps1 -FromRelease` verifies the Windows archive against the digests
  pinned in `release-digests-windows.tsv` instead of the `.sha256` sidecar
  served next to it, so a release base that serves its own archive can no
  longer choose the checksum that admits it. The bypass needs `-NoChecksum`
  plus a typed `YES` at a terminal.

- The Windows pin lives in its own `release-digests-windows.tsv` ledger because
  the published v0.3.3 `install.sh` and every `sync-dsh.sh` copy refuse
  `release-digests.tsv` as a whole once one row names an asset outside the four
  Unix archives. `release-digests.tsv` therefore stays Unix-only, so
  `--from-release` and the automatic updater keep working for installs users
  already have, and `scripts/pin-release-digests.py` updates both ledgers.

### Added

- `plugins/rdsh-mobile-ui` is bundled and installed by `./plugins/install.sh`:
  below 767px the Web chat and composer use the full viewport width, the collapsed
  sidebar becomes a one-tap logo for the session list, and question cards fit the
  phone. The rules are adapted from Smart-DSH
  (<https://github.com/hikarioyama/Smart-DSH>, MIT) and ship only that responsive
  layout — not Smart-DSH's notifications, Esc handling or task hub. See
  [README](plugins/rdsh-mobile-ui/README.md).
- `rdsh provider add hai|sarashina|local-openai` writes an OpenAI-compatible route into a
  profile's `llm-pi-ai` providers (models from `--model`, opencode's
  `provider.<id>` or `GET /models`), keeping every other byte of
  `cordis.patch.yml`; `rdsh provider list` shows presets and per-profile
  route and key status. The `sarashina` preset writes the `compat` lines
  (`supportsStore`, `supportsUsageInStreaming`) and `maxTokens: 8000` that the
  API requires; its `tool_choice` default is a known open question for agent
  use. `HAI_API_KEY`, `SARASHINA_API_KEY` and `LOCAL_OPENAI_API_KEY` can be
  saved from the setup UI (`rdsh setup --yes` does not save them), but they count as a connection only when a profile's
  default model uses a route that reads them. Existing `llm-pi-ai` entries
  written with quotes, comments or any indent width are edited in place; a
  layout that cannot be read safely (including any other mention of
  `llm-pi-ai`, such as inside `- insert:`) is refused with the YAML to add by
  hand. See `docs/PROVIDERS.md`.
- `rdsh subagents plan` turns a declared use case into a deterministic
  dispatch plan for delegated subagents: role and model tier per item, bounded
  items and weight per agent, waves limited by `max_parallel`, and explicit
  warnings instead of guessed tiers. It starts no agent and writes nothing; the
  existing `workers prepare` still owns the checkout allocation
  (`docs/SUBAGENT-PLANNING.md`).
- `rdsh-dashboard agents list|submit|status|result|cancel` runs cursor-agent and
  devin as detached, cancellable jobs with untrusted-data results. The default
  `--permission read-only` selects each CLI's most restrictive mode
  (`--mode ask --sandbox enabled` for cursor-agent, `--permission-mode auto`
  for devin); it is a flag mapping, not an OS sandbox, and the known gaps are
  listed in `docs/AGENT-RUNNERS.md`. Every job end, and `cancel`, stops the
  agent's process group with TERM, a grace period and KILL, and records
  whether the stop was confirmed (`cleanup`); `cancel` also acts on jobs whose
  supervisor was lost or that finished with leftover processes, but only after
  proving the recorded group number still belongs to the job (a confirmed job
  is a no-op; where no process identity can be read, a group cannot be stopped
  after its supervisor is lost). On
  Windows descendants cannot be observed (no Job Object support): the leader
  tree is killed with `taskkill /T /F` while the leader is alive and cleanup is
  always reported `unconfirmed` (`windows_tree_unobservable`).
- `rdsh serial-proxy` replaces the standalone Node.js proxy with a native Rust
  command. It keeps the FIFO concurrency and rate limits, streams request and
  response bodies, and supports `--tool-choice-default <none|auto|required>`
  for Sarashina-compatible requests. See `docs/SERIAL-PROXY.md`.
- `rdsh update auto status|on|off` turns the daily automatic update on with one
  command: it writes a systemd user unit with the machine's own executable path
  and runs `daemon-reload` and `enable --now`. The update itself stays with
  `sync-dsh.sh` (digest pinning, downgrade refusal, verification, rollback) and
  the timer runs daily with up to 30 minutes of jitter. See
  `docs/AUTO-UPDATE.md`.
- `rdsh doctor` warns about broken wrappers and shadowed executables: dangling
  symlinks, a missing shebang, vanished `node`/`dsh` targets, duplicate `PATH`
  entries, a missing `dsh-orig` and an inconsistent `origin` ledger, collected
  in one bounded scan. It only warns; exit status and existing messages are
  unchanged.
- The `rdsh-update-banner` plugin is bundled again for the `web` profile, so
  update notifications return. Install it through the installer because pnpm
  prunes links it does not manage.

- `rdsh context inject` runs as a DSH `UserPromptSubmit` hook and attaches the
  turn context (goal, constraints, decisions, working set, git state, retrieved
  code, memory) through `hookSpecificOutput.additionalContext`. It is fail-open
  and always exits 0: an unreadable settings document or an unparseable payload
  inject nothing, while a damaged index or a deadline overrun drops only what
  depends on them and still injects goal, constraints, and memory.
- `rdsh context hook install|status|remove` merges that hook into a DSH
  `hooks.json` idempotently, keeps unrelated hooks untouched, and keeps a backup
  beside the first file it rewrites.
- The context memory store (`$DSH_HOME/rdsh-context-memory.json`, 0600, atomic
  write): `rdsh context remember|memory|distill|forget`. `distill` reads user
  turns from session logs (including `.jsonl.zstd` through the `zstd` CLI) and
  supersedes overlapping or retracted entries by deterministic rule, keeping the
  superseded record instead of overwriting it.
- `rdsh context build --sessions N` carries past sessions into one build, and
  `--require-stable` exits 3 unless the snapshot is provably stable: a git state
  or read file that changed during assembly counts, and so does a git state it
  cannot read.
- `rdsh deps build|query|impact`: a static dependency graph for Rust,
  JavaScript/TypeScript, Python and Go with a persistent incremental index
  (`$DSH_HOME/rdsh-index`, reused on unchanged size+mtime), symbol lookup, and
  direct/transitive dependents plus affected tests.
- `rdsh compact` now preserves high-value lines from the dropped middle
  (constraints, decisions, errors, diffs, commands) under a bounded reserve and
  reports a per-category digest, instead of keeping only the head and the newest
  turns.

### Fixed

- `sync-dsh.sh` discovers the `@deepseek-ai/dsh` tree by candidate instead of
  `npm root -g` alone (`DSH_PKG_ROOT`, npm's global root, the newest
  `~/.local/opt/*` tree, then the older per-user prefixes). A tree it cannot
  find, or one outside npm's global root, is reported and skipped while the
  rdsh release update still succeeds; npm-managed trees keep digest pinning,
  downgrade refusal, verification and rollback. See `docs/AUTO-UPDATE.md`.
- `rdsh update` stays native when rustdsh is invoked as `dsh`: it is back in
  the native command list and in `--help`, instead of being delegated to
  upstream `dsh`.
- The auto-update systemd unit quotes and escapes `ExecStart`, so an executable
  path containing spaces or `%` no longer breaks the timer.
- The update banner's close button no longer overlaps the timestamp.

- `release-digests.tsv` pins v0.3.3. Its follow-up PR was missing, so
  `install.sh --from-release` and the automatic updater stopped at v0.3.2 even
  though GitHub marks v0.3.3 Latest. `scripts/pin-release-digests.py` turns the
  follow-up into one reviewed command (refusing prerelease tags, missing
  archives and non-SHA-256 values), and `docs/RELEASING.md` uses it.

### Changed

- `rdsh-dashboard subagents plan` forwards to `rdsh subagents plan`: the planner
  is now the Rust implementation in `src/subagent_plan.rs`, the JavaScript
  planning module is removed so there is a single source of truth, and the
  request, plan and warning contract is unchanged
  (`docs/SUBAGENT-PLANNING.md`).
- Context retrieval expands its search hits with dependency-graph neighbours when
  the index exists, so an excerpt arrives with the files it depends on; without
  an index it degrades to the previous behaviour, and `features.dep_graph=false`
  keeps the index out of the context path entirely.
- Plain `rdsh context build` output starts with one `[snapshot: ...]` line (JSON
  already carried the object), so an assembled context is never mistaken for one
  that was verified later.
- `rdsh context status --json` also reports memory counts, the dependency-index
  summary, and the injection budget/deadline; `rdsh context build --json` adds a
  `snapshot` object describing whether the repository stayed stable.
- `rdsh compact` emits an identical line once. Repeats are counted in the
  dropped-line digest instead of being printed again, so a repeated command or
  error no longer consumes budget twice.

## [0.3.3] - 2026-10-13

### Security

- `install.sh --from-release` verifies every archive against the digests pinned
  in this repository's `release-digests.tsv` instead of trusting a checksum
  served next to the archive, so a tampered release base can no longer install
  its own payload. Unix only for now; `install.ps1` keeps using sidecars.
- The Windows dashboard launches its PowerShell tray helper, browser URL handler
  and installed CMD wrapper by absolute path. A `pwsh.exe` or `rundll32.exe`
  placed in the working directory is no longer selected. Re-run the installer
  to refresh an existing `rdsh-dashboard.cmd`.
- The installer validates the ICO header and payload ranges before rebuilding
  the Windows icon instead of trusting offsets in the image.

### Fixed

- Delegation skips `dsh` and Node candidates on `PATH` that the current
  effective user cannot execute, so an unrunnable first candidate no longer
  fails with `Permission denied`.
- `rdsh` shares the upstream DSH credential lock protocol, so saving and
  refreshing credentials after using rustdsh no longer times out.
- Dashboard lock cleanup no longer masks a committed write: the original error
  code is preserved and `lock_cleanup_unconfirmed` is attached.
- `rdsh_inspect` declares its parameters as a valid JSON Schema, so strict
  validators accept the tool definition.

### Added

- `rdsh guard --policy-file` classifies structured Read/Write/Edit operations
  and enforces the allow/deny policy against the resolved target; without the
  flag the previous text-matching behaviour is unchanged.
- The `rdsh-docs` skill ships with the plugins so the DSH web profile can
  check rustdsh behaviour against the verified source.
- The dashboard integrates worker changes in a fixed commit order and requires
  every check to pass before publishing.

### Changed

- Dependency updates: `sha2` 0.11 (digest output is encoded by an explicit
  lowercase hex encoder), `embed-resource` 3.0.12, `koffi` 3.3.3 and
  `@agentclientprotocol/sdk` 1.8.0.
- CI covers the Windows installer and delegation through Git Bash, runs the
  Discord presence suite, pins the upstream approval-integrity check, and the
  release job waits for the tag-push CI before building.

## [0.3.2] - 2026-10-12

### Fixed

- `rdsh compute` and the resident compute bridge contain a worker that closes
  its stdin mid-write: the resulting EPIPE no longer takes down the Node host,
  and the request falls back instead of exiting.
- `tokens`, `compute` and `serve` report `chars` as a Unicode scalar count
  instead of a UTF-8 byte count, so 日本語 is `3` chars rather than `9`.
- `context search` accepts two-character ASCII terms (`CI`, `UI`, `Go`)
  instead of silently returning no sessions; Japanese bigrams keep their weak
  score.
- `search-web` keeps valid results whose title, URL or snippet contains the
  correction word.
- Dashboard acceptance ignores unrelated forbidden files such as
  `.env.example` instead of stopping with `invalid_input_path`.
- Delegation skips `dsh` and Node candidates on `PATH` that cannot be
  executed, instead of failing with `Permission denied`.
- `rdsh headless "run the tests"` forwards the positional prompt the same way
  an explicit `--profile` does.
- `--dump-default-config` and `--dump-config-schema` reach upstream `dsh`
  as themselves instead of degrading to `--dump-config`.
- `rdsh compact` counts newlines in its token budget and no longer appends an
  extra trailing newline.
- Credential rotation replaces the `refs` entry instead of duplicating it, and
  already-duplicated files are healed back to a single entry.

## [0.3.1] - 2026-10-12

### Fixed

- Dashboard: the model catalog module is authorized and served again, so project
  pages render instead of failing with 401/404 and a blank screen.
- `rdsh serve` no longer panics when its stderr is closed (for example
  `rdsh serve 2>&1 | head -1`): log writes now ignore write errors.
- `install.sh --from-release` removes every download directory at exit, so no
  archive, sidecar or extracted binary is left behind in TMPDIR.
- The setup web UI writes the canonical `features.<id>` switches and reports
  their effective state, so its toggles match `rdsh features`.
- Desktop: bundled plugin specs stay slash-separated on Windows.
- Docs: the desktop integration table no longer trips the markdown linter.

### Added

- The DSH web UI's rdsh section shows the running `rdsh` and `dsh` versions.
- `rdsh desktop status|install|verify` detects the DeepSeek Harness Desktop
  (Electron) application, its reserved `$DSH_HOME/profiles/desktop` profile and
  its bundled command runtime, then attaches the rdsh plugins through that
  command (`plugin --profile desktop add`). `--package` forwards extra specs,
  `--dry-run` prints the exact argv, `--compute` adds the resident compute
  bridge. Detection is read-only; the Electron runtime, the bundled Node and
  profile boot stay untouched.
- `PROFILE=desktop ./plugins/install.sh` plus the `--desktop` / `-Desktop`
  installer flags attach the recommended plugins to the Desktop profile, and
  `rdsh doctor` reports the Desktop app, profile and enabled plugins.
- GUI-hosted plugin hardening: the compute bridge and the settings plugin
  resolve `rdsh` from `RDSH_BIN`, then `PATH`, then the well-known install
  locations, and `rdsh-compute` declares its DSH bundle so a profile can enable
  it.

### Documentation

- `docs/DESKTOP-INTEGRATION.md`: what the Desktop application is, how to attach
  the plugins, environment overrides, safety rules, troubleshooting and the
  current verification status.

## [0.3.0] - 2026-10-12

### Security

- Release tagging is fail-closed: the tag must be annotated, its commit must be
  on `main`, and every required CI check on that exact commit must have
  succeeded before any platform build starts. Candidates keep using exact-tag
  installer URLs and never replace the stable `latest` channel.
- The installer verifies the pinned rustup bootstrap checksum before running it,
  and release metadata is read and written as UTF-8 on every host.
- Credentials and settings use atomic writes that keep unmodeled fields, reject
  integer narrowing, escape values as JSON, refuse overflowing JWT expiry, and
  keep local dashboard tokens out of logs.
- Browser-context POSTs to the dashboard require an `Origin` header, and
  proxied backup and budget requests are refused. Webhook subscriptions and
  reply consumer ownership are validated before use.
- Web search advances its UTF-8 attribute scan safely, and context rebuilding
  enforces its UTF-8 byte cap.

### Added

- Agent tools keep **normal file access by default**: the model can read and
  write the project like any other tool. The strict bubblewrap boundary is now
  opt-in through `--share-file`, `features.agent_tool_sandbox=true`, or
  `RDSH_SECURITY=1`.
- Feature switches: `rdsh features` lists all optional capabilities with their
  effective state, and `rdsh features on|off <id>` (or
  `rdsh settings set features.<id> true|false`) turns one off. Bundled plugins
  honor the same switches, so Discord Rich Presence, update checks and
  notifications, the sound-notification offer, the compute bridge, the budget
  guard and the release probe can be disabled from one place. Existing keys
  (`discord.enabled`, `extras.enable`, `beta.context_engine`) keep working,
  and `features.<id>` wins when both are set.
- `rdsh compute`: opt-in resident pure-compute worker (`rdsh-compute/1`) that
  answers token and batch estimates without filesystem, credential or session
  access; its Web proof of concept stays opt-in.
- The plugin installer offers opt-in DSH sound notifications.
- Dashboard: report sources and observation freshness, human bookmarks and
  annotations, saved project workspace layouts, and read-only observation of
  external CLI processes.
- Reproducible offline control-plane fault simulator, and retained worker
  worktrees with declared scopes.
- Windows: scoped dashboard tray, unified rushDSH artwork across web and
  Windows, and DSH 0.2.1-alpha.1 support alongside 0.2.0-rc.2.

### Fixed

- **Installer:** a Linux x86_64 install now selects the static musl build on
  musl hosts and on glibc older than 2.39, runs the downloaded binary before
  installing it, and retries with the musl build when the glibc build cannot
  start. Ubuntu 22.04, Debian 12 and RHEL 9 clones install cleanly instead of
  failing with `GLIBC_2.39 not found`.
- Update checks close completed runs without generating false updates, keep
  dismissals across projects and GUI instances, and preserve the two-hour
  reminder cadence.
- `rdsh logs` streams only the requested tail and keeps cwd-relative paths
  inside the confined root.
- Windows tray startup and cleanup are validated, budgeted before the launcher
  timeout, and timed-out helpers are confirmed to exit.
- WSL keeps a co-installed native package on the active Koffi version, and
  interpreter and update selection stay compatible.

### Changed

- Performance: `rdsh serve` cuts idle accept latency and answers estimates in
  batches, dashboard budget totals replay incrementally, native search work is
  bounded, and compressed session logs are no longer re-read in full.
- Release process: notes follow the v0.2.0 format, all five platform builds are
  staged and verified before publication, and project metadata, installers and
  documentation point at the canonical `jimoto-no-llm/rustdsh` repository.
- Adds `tests/install-isolated.sh`: the built or published artifacts are
  installed inside clean containers with no network, covering the distro matrix,
  the musl fallback and the fail-closed paths. It runs in CI and gates releases.

## [0.2.0] - 2026-10-08

### Security

- Agent tools launched through rustdsh now require Linux x86_64, bubblewrap,
  prlimit, and the audited DSH 0.2.0-rc.2 runtime. They can inspect only files
  explicitly shared with `--share-file`, without host credentials or network.
  Unsupported agent environments fail closed; native commands remain available
  subject to the platform limits documented in README.
- External CLI credentials are no longer imported automatically. Imports require
  an explicit provider or record. Hook misses no longer grant approval.
- File reads reject symlink races, hard links and FIFOs; settings and credentials
  use private atomic writes. Plugin routes require authenticated sessions.
- Release updates require valid SHA256 sidecars before extraction. Release
  publishing waits for every platform asset and verifies all checksums.

### Added

- Dashboard CLI adapters, session ledger, run recovery, scoped stops, checkpoints,
  retries, model routing, task preflight and acceptance evidence.
- Reviewed question/reply workflows, follow-up ordering, mobile overview,
  connection diagnostics, cost and budget controls, credential-free history
  backups, and staged release qualification.

### Fixed

- Preserve unmodeled settings and explicit working-file clears when saving forms.
- Do not cache unknown session token sizes when the zstd CLI is unavailable;
  recheck legacy unknown sizes once zstd becomes available.
- Dismissed update banners remain hidden across polls and reloads for two hours,
  unless a new update is recorded.

## [0.1.5] - 2026-10-06

### Changed

- `sessions --tokens` reuses decompressed sizes from a content-keyed cache
  (`~/.cache/rdsh/sessions-tokens.json`, `RDSH_TOKENS_CACHE=0` disables it);
  repeat views drop from ~0.7s to ~5ms with byte-identical values.
- Deferred `.zstd` files stream through one `zstd` call per session and skip
  the wasted full-file header walk via a first-frame sniff.

## [0.1.4] - 2026-10-06

### Added

- `rdsh sessions --json`: machine-readable session list for sidecar use
  (Desktop/Electron); default table output is unchanged.
- GitHub community health: Code of Conduct, Security/Support policy,
  issue forms, PR template, Dependabot, docs set.
- Docs: ARCHITECTURE / BENCHMARKS / ROADMAP / RELEASING guides.
- rdsh settings UI bundled by default (`./plugins/install.sh`) and
  matched to the Harness theme; see `docs/RDSH-SETTINGS.md`.

### Fixed

- `rdsh doctor` no longer reads huge binaries in full (4.6s -> 0.1s);
  entries are size-gated before reading, warnings unchanged.

### Changed

- Context engine は既定OFFになりました（実験的）。使うときだけ
  `rdsh settings set beta.context_engine true` でONにします。
- Context engine v2: 複合語の点数検索、優先度パッキング
  （goal優先・retrievedから削減）、git snapshot強化、設定は
  `rdsh.json` に一本化（旧ファイルは補完のみ）。
- `rdsh settings get/set/unset/keys` を追加し、context以外も
  CLIから編集できます（例: `search.max`、`guard.deny`、`serve.port`）。

## [0.1.3] - 2026-10-05

### Added

- Context engine prototype: `rdsh context build/search/status/explain`
  rebuilds per-turn context from local files (no vector DB).
- Unified settings: `rdsh settings show/path/init` backed by
  `$DSH_HOME/rdsh.json`; every native default (budgets, limits, ports,
  guard patterns, default profile, beta flags) follows settings unless
  the CLI flag is passed explicitly.
- DSH settings UI: `plugins/rdsh-settings` adds an `rdsh` section to
  the settings sidebar (same design, order 20).
- Beta gate: `rdsh context` requires `beta.context_engine=true`.

## [0.1.2] - 2026-10-04

### Added

- Private project dashboards, QR access, and MCP Events.
- Single installer uploader; pinned line endings for installers.

### Fixed

- CI fixes around OAuth auto-recognition, first-run setup, release installers.

## [0.1.0] - 2026-09

### Added

- Initial Rust launcher: hot-path port with verbatim exec delegation to dsh.
- Native fast commands: tokens / compact / inspect / serve / guard / search.
- Floating setup UI, dsh-default detection, SearXNG search.
- Installers: install.sh (Linux/macOS/WSL), install.ps1 (Windows).

[0.3.1]: docs/releases/v0.3.1.md
[0.3.0]: docs/releases/v0.3.0.md
[0.2.0]: docs/releases/v0.2.0.md
[0.1.5]: https://github.com/jimoto-no-llm/rustdsh/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/jimoto-no-llm/rustdsh/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/jimoto-no-llm/rustdsh/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/jimoto-no-llm/rustdsh/releases/tag/v0.1.2
[0.1.0]: https://github.com/jimoto-no-llm/rustdsh/tree/806c583
