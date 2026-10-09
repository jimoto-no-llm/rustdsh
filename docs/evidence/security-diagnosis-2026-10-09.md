# rustdsh セキュリティ診断レポート（2026-10-09）

対象: `/home/sahen/File/Prog/rustdsh`（rdsh 0.2.0、Rust製dshランチャー）
範囲: ローカルリポジトリのみ。公開サイトへの能動スキャンなし
手法: 静的レビュー（src/*.rs 18本・約9,511行）＋動的確認（cargo test、serve/guard/searchの実機検証）
Strix: 1.7.0でquickスキャンを試行しましたが、LLMブリッジ上流の不調でpreflight失敗しました。代替として手動診断でカバーしています

## 1. エグゼクティブサマリ

結論から言うと、深刻な穴（Critical/High）は見つかりませんでした。

認証情報の扱い、サンドボックス逃避対策、ローカルHTTPの認可はよく固められています。残りはLow/Infoの hardening 余地が5件です。すぐ直せるものから対応するのがおすすめです。

- Critical: 0件
- High: 0件
- Medium: 0件
- Low: 3件（version公開、トークンのログ出力、インストーラのenv上書き）
- Info: 2件（guard空パターン、search-webがhttpのみ）

既存テストは103件すべて通過しています。serveの認可・Host/Origin検証・トークン比較は実機でも期待どおりでした。

## 2. 技術詳細（重大度順）

### Low-1: `/api/version` が無認証で版数を返す（指紋採取）

- 場所: `src/serve.rs:117`（`path != "/api/version"` を認可除外）
- 再現: `curl -s -i http://127.0.0.1:18080/api/version` → `200 {"name":"rdsh","version":"0.2.0"}`
- 影響: 限定的です。版数特定から既知issueへの紐付けに使われる程度です。読み取り専用で機密は返しません
- 対策案: `/api/version` もトークン必須にするか、版数を `{"name":"rdsh"}` のみに減らすのがおすすめです

### Low-2: ダッシュボードURL（トークン付き）がstderrに出る

- 場所: `src/serve.rs:19-21`、`src/setup_web.rs:19`
- 再現: `serve` 起動時のstderrに `http://127.0.0.1:18080/#key=09d90c...` がそのまま出ます（`/tmp/rdsh-serve-test.log` で確認）
- 影響: フラグメント（`#key=`）はHTTPで送られませんが、端末履歴やログ転送で漏れる余地があります。トークンは64桁hex（256bitランダム）で推測は困難です
- 対策案: 表示は `http://127.0.0.1:<port>/` のみ Roth、トークンは別行で「手元のURLを開き直してください」と案内するのがおすすめです。UI側はすでに対応済み（`history.replaceState` で除去、`sessionStorage` 保持）です

### Low-3: インストーラがenvで配布元・検証を変えられる

- 場所: `install.sh: fetch_release()`（`RDSH_RELEASE_BASE`、`RDSH_NO_CHECKSUM=1`）、`install.ps1` も同等
- 再現（コード確認）: `tar -xzf "$FETCH_TMPD/pkg.tgz" -C "$FETCH_TMPD"` の前にchecksum sidecarを要求しますが、`RDSH_NO_CHECKSUM=1` で回避できます。`RDSH_RELEASE_BASE=file:///attacker` で配布元を差し替えられます
- 影響: envを汚染できる攻撃者が前提なので単体では成立しません。成立すれば任意バイナリ実行です
- 対策案: 非既定の `RDSH_RELEASE_BASE` では警告を表示し、`tar` に `--no-absolute-filenames --no-same-owner` を付けるのがおすすめです。`RDSH_NO_CHECKSUM=1` は対話確認を求めると安全です

### Info-1: guardの空パターンが全ブロックになる（可用性）

- 場所: `src/guard.rs:15-17`（`pattern == "*" || pattern.is_empty()` → `true`）
- 再現（コード確認）: `guard.deny` に `""` が混ざると `wildcard_match("", anything)` が `true` になり、全hookがexit 2になります
- 影響: セキュリティ穴ではなく可用性の問題です。誤設定で自分を止めます
- 対策案: `rdsh_config.rs` の `sanitize()` で空文字を除去するのがおすすめです

### Info-2: `search-web` が `http://` のみ（`https://` 拒否）

- 場所: `src/websearch.rs:54-56`（`strip_prefix("http://")`、他はエラー）
- 再現（コード確認＋単体テスト）: `split_base("https://h/")` は `Err` になります。既存テスト `base_splitting` で保証されています
- 影響: 既定（`http://127.0.0.1:8888`）はloopbackなので問題ありません。LAN上の外部SearXNGを使うと平文になります
- 対策案: `https://` を許可するか、外部利用はSSHトンネル経由と文書化するのがおすすめです

### 確認済みの強み（findingなし）

- 認証情報: `write_creds` は `create_new`＋0600＋`rename` の原子書き込みです。`safe_scalar` でYAML改行注入を拒否します。`setup_store_key` はallowlist（3件）＋512文字上限です
- ファイル隔離: `file_security::Root` は `O_NOFOLLOW`＋`openat` の段階走査、`nlink==1`、`is_file` でsymlink・hardlink・FIFO・TOCTOUを拒否します
- 実行隔離: `tool_security` はLinux x86_64・監査済みdsh（0.2.0-rc.2 / 0.2.1-alpha.1）・bwrap＋prlimit必須でfail-closedです。`NODE_OPTIONS`/`NODE_PATH` を除去します
- ローカルHTTP: `trusted()` はHost＋Origin検証、`authorized()` は定数時間比較、接続上限32、ヘッダ16KB・ボディ64KB制限です。実機で401/403/200の出し分けを確認しました
- 検索: `search` はsymlinkを辿らず、2MB・UTF-8上限でfail-closedです。実機で `0 hit(s) in 1 file(s)` を確認しました
- 設定: 壊れた `rdsh.json` は `exit(1)` のfail-closedで、guard空起動を防ぎます

## 3. 証跡一覧

時刻はUTCです。対象はローカルのみです。

- 2026-10-09T10:00Zごろ: `curl -s http://127.0.0.1:8795/v1/models` → `200`、38モデル列挙。`~/適当/strix/strix-zen --version` → `strix 1.7.0`
- 2026-10-09T10:02Zごろ: Strix quick実行（`strix-zen -t /home/sahen/File/Prog/rustdsh -m quick -n --max-turns 80`）→ Docker `ghcr.io/usestrix/strix-sandbox:1.3.0` pull成功後、`LLM CONNECTION FAILED: openai/longcat-2.5-preview-free did not answer within 30s` で終了（exit 0、`strix_runs/` なし）
- 2026-10-09T10:02-10:05Z: `openai/step-5-preview-free`、`deepseek-v4-flash`、`glm-5.3-flash`、`kimi-k2.6`、`qwen3.8-flash`、`longcat-2.0` で `/v1/chat/completions` を試行 → すべて `{"error":{"type":"server_error","message":"Model is unavailable."}}`。`zen-bridge.service` はactive（running）を確認
- 2026-10-09T10:04:57Z: 分離HOME（`/tmp/rdsh-test-home/rdsh.json` にextras有効化）で `rdsh serve --port 18080` を起動。`curl` 結果は次のとおりです
  - 無認証 `/api/doctor` → `401 {"error":"unauthorized"}`
  - 無認証 `/api/version` → `200 {"name":"rdsh","version":"0.2.0"}`
  - `Host: evil.com` → `403 {"error":"untrusted host or origin"}`
  - `Origin: http://evil.com` → `403`
  - 無認証 `POST /api/tokens` → `401`
  - 正トークン（64桁）で `/api/doctor` → `200`（`dsh_home` 等を返却）
  - 2文字改変トークン → `401`
- 2026-10-09T10:05:26Z: `guard --deny 'rm -rf /*'` にhook JSON投入 → `pattern hit` でexit 2。非該当はexit 0。`search DUMMY_SEARCH_SECRET --dir /tmp/rdsh-search-test/repo`（symlink配置）→ `0 hit(s) in 1 file(s)` で外部漏洩なし
- 2026-10-09T10:0xZ: `cargo test --quiet` → 78＋11＋11＋3＝103件すべて通過

## 4. 対策（優先度順）

1. `/api/version` の認可見直し（Low-1）
2. 起動ログからトークン除去（Low-2）
3. インストーラの `tar` 旗とenv上書き警告（Low-3）
4. guard空パターンの無視（Info-1）
5. `search-web` のhttps対応または文書化（Info-2）

重いスタックは常駐させていません。Decepticon/PentAGIは未起動、ARTEX未使用、Strixコンテナはpreflight失敗で停止済みです。追加の侵入検証が必要になったら、対象・期間・禁止事項を決めてARTEX等で回すのがおすすめです。完了状態は「診断・報告済み、修正は未適用」です。

## 5. 追加診断と残件対応（第2ラウンド、同日）

opencode（muse-spark）による追加監査の指摘を精査し、妥当なものを修正しました。監査指摘の一部（計測系の「リンク追従で任意読み」等）は既存ガード済みで誇張があり、実害のある形（収集後の差し替え）に絞って対策しています。

- H-2 Windowsの認証情報ACL: `src/auth.rs` の `write_creds` に `lockdown_creds_file`（icaclsで継承剥離＋現ユーザーのみ）を追加。失敗時は警告して保存は維持。`cargo check --target x86_64-pc-windows-gnu` でコンパイル確認
- M-1 guard回避の構造的限界: `src/guard.rs` に境界注記（deny-listは気休めで、重要操作はtool isolation依存）と空deny警告を追加。意味論的回避の完全除去は不可のため文書化で対応
- M-2 実行対象の差し替え: `src/auth.rs` の `which_bin` を通常ファイル＋実行ビット必須に。`src/passthrough.rs` はenv/origin明示選択が他者所有・緩い権限・非通常ファイルの場合に警告（選択自体は維持）
- M-3 APIキー入力のecho: `src/auth.rs` にUnix TTY限定の `prompt_secret`（termiosでECHO抑止・必ず復元）を追加し、ペースト入力に使用。非Unixは従来動作
- M-4 インストーラ署名: `install.sh` の2箇所のcurlに `--proto '=https' --tlsv1.2` を追加（rustup行と同等化）。署名検証（sigstore等）は未導入のためsidecar同梱配布の旨を注記
- M-5 search-webの非loopback平文: `src/websearch.rs` の `fetch` で非loopbackホストにSSHトンネル推奨の警告。`split_base` の既存拒否（https拒否・空ホスト拒否）は維持
- M-6 計測系の差し替え読み: `src/inspect.rs` の5経路（header走査・先頭確認・file_meta・単体stream・複数stream）に `plain_file_no_follow`（symlink_metadataで通常ファイル再確認）ゲートを追加。複数streamは1件でも不審なら全体Noneでinexact側に倒す。単体テスト追加
- L-1 Hostヘッダのport欠落: `src/websearch.rs` で非80番は `host:port` 形式に。既存テストを拡張してfixtureのephemeral portで検証
- L-2 store上限の不統一: `src/auth.rs` の `store_ref` にweb経路と同じ512文字上限を追加
- L-3 share-fileのRust側検証: `src/file_security.rs` に `validate_share_files`（空・絶対・親逃げ・NUL・257件超を拒否）を追加し、`src/main.rs` でexit 2のfail-fast。JS側の厳密検証は維持
- L-4 env汚染の可視化: `src/auth.rs` の `auth`/`setup` で `DSH_HOME` がenv由来の場合に実効値を明示
- L-5 インストーラ判定の脆さ: `install.sh` のrestore/as-dsh判定を `--version` バナー照合に変更。wrapper走査は直下・通常ファイル・64KB未満に限定（macOS互換の `xargs -0` 方式）

検証: `cargo test` 108件通過（新規5件含む）、`bash -n install.sh` 正常、Windowsターゲットcheck正常。完了状態は「残件対応済み、同一PRへpush予定」です。
