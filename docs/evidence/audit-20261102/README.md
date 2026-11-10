# ローカル更新・コード監査（2026-11-02）

対象: `b060ccf70187d0ea18155015adebf26640972598`、Cargo v0.15.0。
`origin/main` を fetch し、`codex/latest-audit-20261102` を作成して切り替えた。
以前の HEAD は `codex/pre-update-20261102`、未コミット変更は
`pre-update 2026-11-02: preserve local packaging edits` の stash に保存した。
旧ブランチ固有の 724 コミットを最新版へマージしたわけではない。
監査では製品コードを変更していない。インストール済みの rdsh は更新していない。

## 対象と保証範囲

追跡対象のコード・設定 984 ファイルのパス、行数、SHA256 を
[source-inventory.tsv](source-inventory.tsv) に記録した。
Rust 本体、Node ダッシュボード、プラグイン、デスクトップ、スクリプト、CI を
棚卸しし、Rust/Node の既存検証と依存監査を実行した。手動精査は主に HTTP 認証、
プロバイダ通信、実行ファイル探索、ファイルアクセス、ツール承認、子プロセス、
アダプタ境界、リリース CI を対象とした。

全 984 ファイルを一行ずつ精査したものではなく、脆弱性が存在しないという保証ではない。
macOS/Windows の実機、デスクトップ GUI、実プロバイダ認証、実課金、すべての外部
ハーネス、ブラウザ E2E は未検証。大きなリポジトリ全体への初回監査として扱う。
依存監査のゼロ件はソース実装の安全性を意味しない。

## 指摘（監査時点では未修正）

後続の修正内容は [FIXES.md](FIXES.md) を参照。

### P2: 実行ファイルの信頼判定が書き込み可能な祖先を見落とす

`src/exec_trust.rs:22–27` は実行ファイルと直近の親の mode だけを検査する。
たとえば PATH の `/shared/tools/bin` の bin と実行ファイルが 0755 でも、
`/shared/tools` を他者が置換できる場合、選択済みパスを別の実行ファイルへ差し替えられる。
symlink の解決先の親ディレクトリの信頼性も確認されない。
`worker_git.rs` の Git、`update_auto.rs` の systemctl、`plugins.rs` の DSH 選択が
この判定を安全性の根拠に使っている。攻撃者が該当する祖先を書き換えられることが前提。

実ソースの判定関数を呼ぶ再現では、書き込み可能な祖先を含むパスも、その下の
ディレクトリを置き換えた後も `None`（拒否理由なし）を返した。
対策は canonical な実行対象と全祖先を検証し、所有者・sticky bit の扱いも定義すること。
チェックから実行までの差し替え対策も併せて設計する。

### P2: 診断プローブの期限後に子孫と読み取りスレッドが残る

`src/dsh_env.rs:43–75` の `run_bounded_capture` は stdout を専用スレッドで
ブロッキング読み取りする。起動したプログラムが子孫へパイプを継承して終了すると、
呼び出し側は期限内に戻るが、子孫と読み取りスレッドは残る。期限超過時の kill も
直接の子だけを対象にする。繰り返し診断するプロセスでは資源消費が積み上がる。

実ソースの関数で 50ms のプローブを 3 回呼ぶ再現ではスレッド数が 1→4 に増加。
子孫が自発終了して初めて 1 に戻った。再現は 2 秒で終了する子孫だけを使用した。
対策は所有するプロセスグループの終了と reap、キャンセル可能な読み取り。

### P2: DISPLAY のある Linux で通常の Rust テストが失敗する

`src/setup_web.rs:544–559` は端末でも Windows/macOS でもなければ
`should_open_page()` が false になると期待する。しかし実装は DISPLAY と
WAYLAND_DISPLAY の存在でも true を返す。テストがその環境変数を隔離していないため、
GUI 環境では誤って失敗する。後半の DISPLAY の削除も呼び出し前の値を復元しない。

`DISPLAY=:99 cargo test --locked --bin rdsh setup_web::tests::the_page_opens_off_a_terminal_but_never_in_a_headless_session -- --exact`
で単独再現。両変数を外すと全 Rust テストが成功した。
環境変数を復元するガードと共有 env lock、または環境入力を受け取る純粋関数で検証する。

### P3: 公開 HarnessAdapter 契約と実装のシグネチャが一致しない

`docs/HARNESS-ADAPTER.md` の例は `Option<PathBuf>`、引数付き build_command、
`passthrough()` を示すが、`src/harness_adapter.rs` は `Option<String>`、
`build_command(&LaunchOptions) -> Result<BootedCommand>`、`launch()` を定義する。
例の通りに第 2 アダプタを実装してもコンパイルできない。ドキュメントを実際の trait に
合わせ、最小の第 2 実装をコンパイルする検証を用意する。

## 再現と検証記録

[reproduce.py](reproduce.py) は最初の 2 件を実ソースから取り出して確認する Linux 用の
独立再現。修正後も監査時点のコミットからソースを取得して再現する。外部通信・認証・製品ファイルの変更は行わず、一時ファイルは削除する。
[reproductions.log](reproductions.log) に結果を保存した。

- `cargo fmt --check`: 成功。
- `cargo clippy --locked --all-targets -- -D warnings`: 成功。
- `cargo build --locked`: 成功。
- 通常の `cargo test --locked`: 上記 GUI 環境依存テストで失敗（863 成功、1 失敗）。
- `env -u DISPLAY -u WAYLAND_DISPLAY cargo test --locked`: 33 スイート、1,218 件成功。
- セキュリティ系 Node: 62 成功、6 スキップ。公式ランタイム等がない検証は未実施。
- CI 基本 Node スイート: 206 成功、2 スキップ。
- リリース Python: 154 成功。最初の実行はローカルの tag.gpgSign 設定で 3 件エラー。
  再実行はコマンド単位の Git 設定で署名を無効化し、リポジトリの設定は変更していない。
- Dashboard `npm test --prefix dashboard`: 860 成功、28 スキップ（888 件）。
- `BIN=./target/debug/rdsh sh tests/regress.sh`: `setup --web unauthed status` の
  HTTP 応答が 5 秒でタイムアウトして失敗。製品不具合か実行環境・並行負荷かは未確定。
- `cargo audit --json`: 既知脆弱性・警告とも 0。
- `npm audit --prefix dashboard --json`: 0。対象は dashboard の依存関係。

最初の Node/dashboard 実行は古いビルド済みバイナリを参照したため、
その失敗を最新版の欠陥とは数えず、`cargo build --locked` 後に再実行した。
保存したログの対象コミットと環境の制約を踏まえて結果を読むこと。
