# #52: 再試験の実操作と証拠

2026-10-08 UTC。WindowsのCodex in-app browserから、合成データで起動した実際の
Project dashboardを操作した。Node.jsは22.23.3。ブラウザーの版番号は未取得。
入力・クリック・キー・再読込・戻るは実ブラウザー操作、DOM読取りは観測、
障害操作はfixtureのstdinで行った。DOM書換えや直接の回答API呼出しをブラウザー操作の
代わりにはしていない。

## 試験対象と接続

| 記録prefix | 接続先・環境 | 観測した幅 |
| --- | --- | --- |
| `desktop` | Windows上のNode 22 fixtureへloopback接続 | DOM 1265×720、PCブラウザー |
| `wsl` | WindowsブラウザーからWSL内のNode 22 fixtureへ接続 | DOM 1265×720、PCブラウザー |
| `mobile390` | Windows上の新しいfixture、PCブラウザーの狭い表示幅 | inner width 390px、DOM 375×844（縦スクロールバー15px） |

WSLの採用runは`rdsh-qa-kJc7Iv`、ブラウザー接続先のportは`38823`。
事前確認用の`rdsh-qa-jJ1mMI`、port `38457`とは別のrunであり、その集計を使わない。
mobileの採用runは`rdsh-qa-WNxhR6`、port `57687`。新規タブ作成後に表示幅を設定し、
各DOM観測の幅375pxと[画面](mobile390-sse.jpg)の狭い表示を照合した。
WindowsからWSL上の実サーバーへ到達したことは確認対象に含むが、通信断そのものは
同じfixtureのloopback proxyで発生させた。無線切断やTailscale障害を実施したという意味ではない。

記録対象版は`ec5fbf7c7ee5342fe9952dc0da0097c887aa427e`。
desktop初回の起動時点とWSL用snapshotは`576d5fa`由来だが、
`app.mjs`、`ui.html`、`server.mjs`、`qa/fixture.mjs`は対象版と同じである。
ソースの照合根拠は[起動元の記録](environment/browser-source-provenance.json)を参照。
Windows/LinuxのNode試験は対象版のcheckoutで実行し、dashboard 28ファイルのGit blobと
改行をLFへそろえたSHA-256が一致することを
[検証記録](environment/node22-verification-summary.json)に残した。
改行差があるファイルについて、生バイト列まで同一とは主張しない。

## 実施手順

各runは新しい合成projectと5質問で開始した。起動はリポジトリルートから
`node dashboard/qa/fixture.mjs --directory <isolated-parent>`。
起動時に渡された試験専用URLをブラウザーで開き、次の順で確認した。
試験用認証情報・URLのfragment・`runtime.json`は公開用証拠に含めない。

| 操作 | 実操作と合否に使う観測 | 対応する証拠 |
| --- | --- | --- |
| SSE入力 | `Q-sse`へ日本語2行の下書きを入力してfocusを置き、stdin `log`。本文完全一致、回答欄focus、POST/feedback 0件を確認 | DOM `*-input`/`*-sse`、`*-unsent.json`、`*-sse.jpg` |
| cancel | 下書きを保持して送信ボタンへTab移動し、Ctrl+Kでパレットを開く。Escapeで閉じ、元ボタンfocus・本文・未送信を確認 | DOM `*-palette`/`*-cancel`、`*-unsent.json` |
| reload/back | 同じ未送信下書きで再読込。続いて別ページへ移動してブラウザーで戻る。本文と認証の復帰、POST/feedback 0件を確認 | DOM `*-reload`/`*-back`、`*-unsent.json`、`*-back.jpg` |
| keyboard/answer | キーボードで`Q-sse`回答欄へ移動し、回答を入力、Tabで送信ボタン、Enterで送信。回答済み表示の本文とfeedback 1件を照合 | DOM `*-keyboard-*`/`*-answer-visible`、`*-keyboard.json` |
| 二度押し | `Q-double`へ入力、stdin `hold`で次のPOSTを保留して二度押し。`log`後も送信ボタンdisabled・textarea read-onlyが維持されることを確認し、`release` | DOM `*-double-held`/`*-double-sse`/`*-double-saved`、`*-held.json`/`*-double.json` |
| 受理前切断 | `Q-before`へ入力、`drop-before`後に送信。本文保持と結果確認待ち、対象feedback 0件を確認。`resume`後に保存なしを照合し、明示再送 | DOM `*-before-offline`/`*-before-*`、`*-before-offline.json`/`*-before-final.json` |
| 保存後の応答消失 | desktop/WSLは`Q-after`、mobileの採用再試験は未使用の`Q-navigation`へ入力。`drop-after`後に送信し、本文保持と結果確認待ち、対象feedback 1件を確認。`resume`後に同じ回答が表示され、再送不要であることを確認 | desktop/WSLのDOM `*-after-offline`/`*-after-saved`と集計、mobileのDOM `mobile390-after-recheck-*`と`mobile390-after-recheck-offline.json`/`mobile390-final.json` |

cancelはコマンドパレットを閉じる操作であり、質問取消・送信取消・実行停止ではない。
answerとkeyboardは同じ`Q-sse`送信の結果を共有する。独立した2回の送信試験ではない。
送信後は元フォームがなくなるため、keyboardの`focus_preserved`は`null`とし、
送信前の移動と送信後のfocus先をDOM記録で示す。

## Raw証拠の読み方

[browser-observations.json](browser-observations.json)は、操作地点ごとの`label`、UTC時刻、
回答欄の値、active要素、送信ボタンのdisabled状態、textareaのreadOnly状態、
回答済み本文、接続表示、viewportを持つ。最終集計だけでは入力保持やfocusは分からないため、
このDOM記録と画面を併用する。DOMの記録時刻とfixture集計時刻は別の観測点である。

段階ごとのJSONは全体の累計と質問別の累計を持つ。
`answer_post_attempts`は通信試行数でありクリック数ではない。
耐久回答の重複判定には質問別の`feedback_count`を使う。

| 段階JSONの末尾 | 全体POST試行 | 全体転送 | 全体feedback | 対象質問の確認点 |
| --- | ---: | ---: | ---: | --- |
| `unsent` | 0 | 0 | 0 | Q-sseは未送信 |
| `keyboard` | 1 | 1 | 1 | Q-sseが1件保存 |
| `held` | 2 | 1 | 1 | Q-doubleは試行1・転送0・保存0 |
| `double` | 2 | 2 | 2 | Q-doubleが1件保存 |
| `before-offline` | 3 | 2 | 2 | Q-beforeは試行1・転送0・保存0 |
| `before-final` | 4 | 3 | 3 | Q-beforeは試行2・転送1・保存1 |
| `after-offline` | 5 | 4 | 4 | Q-afterは試行1・転送1・保存1 |
| `final` | 5 | 4 | 4 | 停止済み、未帰属POST 0、Q-navigationは未送信 |

この表はdesktop/WSL両runの実測値である。mobile390も`before-final`までは同じ。
最終記録は[desktop-final.json](desktop-final.json)、[wsl-final.json](wsl-final.json)。
各runの保存回答は4件で、5回の通信試行との差はQ-beforeの受理前切断1回である。
通信が常に一度だけ送られる保証を示す数字ではない。

mobile390の保存後応答消失は同じrunの別質問で再試験したため、最終累計が異なる。

| mobile390の段階JSON | 全体POST試行 | 全体転送 | 全体feedback | 採否・質問別の確認点 |
| --- | ---: | ---: | ---: | --- |
| `mobile390-after-offline.json` | 5 | 4 | 4 | 初回Q-after。本文の意図しない末尾文字により、合格の根拠には採用しない |
| `mobile390-after-recheck-offline.json` | 6 | 5 | 5 | 採用したQ-navigation再試験はPOST1・転送1・feedback1。応答を失った状態 |
| `mobile390-final.json` | 6 | 5 | 5 | 停止済み、未帰属POST0。再接続後もQ-navigationはPOST1・feedback1で追加送信なし |

採用した再試験の本文は`mobile390_再確認_保存後の応答消失`。
DOMの`mobile390-after-recheck-ready`と`-offline`で完全一致し、`-saved`の回答表示にも
同じ本文があることを確認した。初回Q-afterと再試験Q-navigationは別質問であり、
全体feedbackが5件あることを1質問への重複回答とは数えない。
最終記録は[mobile390-final.json](mobile390-final.json)。

## Node 22試験

Windows/Linuxとも隔離したNode 22.23.3を使い、dashboardを作業ディレクトリに
`node --test`へ全`test/*.test.mjs`を渡し45件成功、失敗・skipとも0。
Windowsは元checkoutの既存依存とPowerShellで列挙したFullName配列を使用した。
Linuxは隔離clone内でruntime同梱の`npm-cli.js ci --ignore-scripts --no-audit --no-fund`
（空のuser/global設定と専用cacheを指定）を行い、bashのglobでテストファイルを渡した。
最終ログは[Windows](environment/windows-node22-tests.txt)と
[Linux native filesystem](environment/linux-native-node22-tests.txt)。
初回のGit metadataなしsnapshotではCLI initが失敗し、Linuxの`/mnt/c`上では
fixture CLIのcold startが既存の3秒待ちを超えた。最終試験はGit checkoutを使い、
Linuxはnative filesystemへ移した。同じテストのtimeoutを延ばして合格にしてはいない。
初回失敗も[照合記録](environment/node22-verification-summary.json)に区別して残した。
版管理する初回失敗ログは空行上の空白のみ除去した。エラー本文・数値・時刻は変更していない。

## 採用しない試験・未確認範囲

初回の`mobile-*`runは名称に反してDOM幅1265px、画面もPC幅だった。
mobileのpassには使わず、390pxをDOMと画像で確認した新しい`mobile390-*`runを採用した。
誤設定runの原本は作業用`outputs/issue-52-audit`に保持し、最終証拠と混ぜない。

mobile390の初回Q-afterでは、操作で指定した本文に対して、切断時と保存後のDOM本文に
末尾の全角`ｋ`があった。入力操作・環境・アプリのどこで混入したかは未確定。
送信直前の本文を記録していない初回を本文保持の合格根拠にせず、未使用Q-navigationで
送信直前から記録した再試験を採用した。初回観測もDOM記録に保持しており、
再試験の成功を初回の差の原因解明や一般的なIME対応の証明とは扱わない。

実機phone、タッチ、ソフトキーボード、日本語IMEの変換途中、Tailscale、元DSH Harness、
インストール済み`rdsh-dashboard`起動、Dotの実反応、有料モデル実行は未確認。
日本語文字列の入力成功はIME変換中の保持を証明しない。
完全なofflineページsnapshotや別端末同期は追加していない。
旧版の[失敗記録](../issue-52/browser-checks.md)は今回の結果で上書きしない。

## QA一覧の表示確認

[実ブラウザーの絞り込み記録](filter-browser.json)に、選択欄の実操作と可視行数を保存した。
全57、未確認29、WSL全18・未確認9・pass9、Tailscale全18・pass0、
local mobile9、その保存後応答消失1、real-connection9を確認し、リセット後57へ戻った。
[表示画像](report-final.jpg)でも28 pass・29 not-runと、重複回答の「セル数」表示を確認した。
