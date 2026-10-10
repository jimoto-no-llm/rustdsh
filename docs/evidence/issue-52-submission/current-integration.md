# main統合後の検証

対象はmain `96dbcbb`へIssue #52の変更全量を統合したソース。旧ブランチの[74件と実機試験](verification.md)・[53 pass／4 blocked](report/README.md)とは別の記録である。

## 対象と確認範囲

- mainに存在する質問契約・実行管理・モバイル概要などを残し、QA・回答復旧・認証案内・参考情報の配置を統合する。
- この統合後のiPhone実機・WSL/Tailscale実接続は未再試験。旧実機試験の合格を統合後へ転記しない。
- 外付けキーボードの実機4セルは、旧試験でもblockedのまま。
- 統合後のソースは[current-source-manifest.json](current-source-manifest.json)へ別記する。snapshot作成だけではテスト成功を意味しない。

## 変更前のmainで実施した検証

2026-10-08、変更前のmain `96dbcbb`を別checkoutで実行。WindowsのNodeはv22.23.3。以下のdashboard結果は変更前の基準値であり、統合後の合格として流用しない。

| コマンド・対象 | 結果と証拠 |
| --- | --- |
| `npm ci --prefix dashboard` | 成功、audit 0。実行結果を確認、専用ログは未保存 |
| `npm test --prefix dashboard` | 182/182成功、fail 0。[ログ](logs/main-baseline-windows.txt) |
| `cargo fmt --check` | 成功。実行結果を確認、専用ログは未保存 |
| `cargo clippy --all-targets -- -D warnings` とrelease版 | 両方とも既存2件で失敗。[releaseログ](logs/main-clippy-release.txt) |
| `cargo test --release --locked` | 85件成功（unit 69、log境界4、native 9、settings 3）。実行結果を確認、専用ログは未保存 |
| `cargo test --release --example benchmark_extended` / `cargo test --release --example benchmark_models` | それぞれ2/2、5/5成功。実行結果を確認、専用ログは未保存 |
| WSL `cargo build --release --locked` | Linux Cargo 1.99で成功。[ログ](logs/main-wsl-build.txt) |
| `node --test tests/model_benchmark/fence.test.mjs` | WindowsはsymlinkのEPERMで1失敗・1成功。WSLでは2/2成功。[WSLログ](logs/main-wsl-fence.txt) |
| 隔離WSLの`sh tests/regress.sh` | 53 checks、ALL PASS。隔離HOMEと合成DSH stubを使用。[ログ](logs/main-wsl-regress.txt) |
| `npm test --prefix tests/e2e` | 3つの主要フローを完了した後、終了時のconsole error検査で失敗。[ログ](logs/main-e2e-windows.txt) |

clippyの2件は`src/search.rs:290`のunused importと`src/main.rs:659`のnonminimal_bool。Issue #52の変更対象外であり、旧版の「clippy警告0」を現在の結果として引き継がない。

E2Eの3フローは、設定、native Serve、Project CLI/MCP・回答・再起動。サーバー停止後、ページを閉じる前のSSEが`ERR_CONNECTION_RESET`となり、`console_errors === []`の検査が失敗した。コマンド全体をpassとは扱わず、`&&`の後続`update-banner.mjs`はこの実行では未実施。原観測はローカル`outputs/issue-52-submission/main-e2e/browser-results.json`に保持。

Rust・CLIの実行対象はmainから変更していないため、その同一ソースについて上記の結果を採用する。Cargoの出力先はリポジトリ外の専用`CARGO_TARGET_DIR`。DSHへの実モデル要求・課金を伴う試験ではない。公開ログは個人の絶対パス接頭辞を一般化し、行末の空白・タブを除去した。[原ログと公開コピーのSHA256](publication-log-manifest.json)を対応づけ、原ログは変更せず保持する。

## 統合後のdashboard

Windows／WSLともNode v22.23.3、作業ディレクトリは`dashboard`。最終ソースで両環境とも全263件成功。初回の全件実行後に見つかった質問長の不具合と、その修正前後の結果も残す。

| 実施順・コマンド | 結果と適用範囲 |
| --- | --- |
| Windows `npm test` | 262/262成功。下記の最終キー長修正より前。[ログ](logs/integrated-windows-tests.txt) |
| 独立レビューの反例 | APIが受理する長い質問をJSON化した保存キーが旧上限を超え、再読み込みで下書きを復元できない問題を再現 |
| 最終修正 | 保存キー上限を64 KiBへ変更。質問8000文字・既定の行動2000文字に制御文字を含む実API最大長の回帰テスト1件を追加し、修正前の失敗を確認 |
| Windows `node --test test/question-recovery.test.mjs test/answer-ui.test.mjs test/answer-startup-recovery.test.mjs` | 最終修正後の関連38/38成功。[ログ](logs/integrated-recovery-final.txt) |
| Windows最終 `npm test` | 最終ソース263/263成功、fail 0・skip 0、exit 0。[ログ](logs/integrated-windows-final-tests.txt) |
| WSLの初回 `npm test` | cgroup委譲なしの環境で187成功・75失敗。`ownership_unavailable`を確認。[失敗ログ](logs/integrated-wsl-tests.txt) |
| WSL `systemd-run --user --scope -p Delegate=yes npm test` | 委譲を有効にしたscope内で、最終ソース263/263成功、fail 0・skip 0。[ログ](logs/integrated-wsl-delegated-tests.txt) |
| Windows `npm run test:updates --prefix tests/e2e` | 更新バナーの5フローPASS。[ログ](logs/integrated-updates-windows.txt) |
| Windows `npm test --prefix tests/e2e` | 主要3フロー後、基準版と同じ終了時SSE resetで失敗。[ログ](logs/integrated-e2e-windows.txt)。後続更新バナーは上の別コマンドで実施 |

WSLの初回失敗を成功に置き換えず、必要な実行条件とともに保持した。統合E2Eもコマンド全体はfailであり、主要フローが完了したこととは区別する。原観測はローカル`outputs/issue-52-submission/integrated-e2e/browser-results.json`に保持。

コードレビューの1件は上記のキー長修正後に再確認し、未解決指摘なし。会話を引き継がない要件レビューでも追加の未充足なし。最終の軽量`secscan.py`は150ファイル・指摘0件だが、`dashboard/test/answer-dom.mjs`についてSemgrep構文解析警告1件があり、このファイルの完全な解析を保証しない。[UTF-8で再実行した最終ログ](logs/integrated-secscan-final.txt)を同梱し、文字化けした旧ログは転載しない。

## 統合後の表示

Windows／Node v22.23.3、loopbackの隔離Project fixture、PC実ブラウザーで実施。DSH・Tailscale・通常CLI起動の再試験ではない。PCの1440px・390px幅で、質問文→初期状態で折り畳んだ参考情報→回答欄の順を確認し、[画像](visual-evidence.md)を保存した。390px幅はPCブラウザーの表示幅試験であり、iPhone実機試験ではない。

| 操作 | 実際の観測 |
| --- | --- |
| 入力中のSSE・再読み込み | 日本語下書きを保持。SSE後のfocusを保持、Q-sseのPOST 0・保存0 |
| 二度押し | 保留中の2回クリックでPOST 1。直後の「送信中…」とdisabledをDOM計測。log（SSE）更新後もPOST 1、解除後に保存1。SSE再描画後のdisabledは自動回帰テストで確認し、今回の実ブラウザーでの再DOM計測とは区別 |
| 保存前の切断 | 本文を保持してロック。復帰後に内容を確認して明示再送し、保存1 |
| 保存後の応答消失 | 本文を保持してロック。復帰後の状態照合で保存済み回答を確認し、利用者による再送なしで保存1 |
| 回答済みの開閉 | 保存した3件を展開して表示 |
| コマンド開閉 | 390px幅の画面内に幅335pxで収まり、開閉成功 |
| 認証401からの復旧 | 案内を読める状態まで表示。有効な完全URLで案内が消え、Q-sseの未送信本文を保持 |

[停止時の実測JSON](integrated-browser-counts.json)は2026-10-08T12:57:35.783Zに更新。POST試行6回、backend転送3回、保存3件で、各質問の保存は1件ずつ。内訳は二度押し1/1/1、保存前切断3/1/1、保存後応答消失2/1/1（POST／転送／保存）。通信断時のPOST増加にはブラウザー側の再試行が含まれ、アプリの自動再送回数として数えない。明示再送の操作と保存照合の観測を件数と併記する。

表示確認に使用したサーバー2本はstop・exit 0で終了し、試験ポートの待受なしを確認した。これらの追試を旧53 pass／4 blockedの履歴セルへ上書きしていない。
