# 利用経路ごとのQAレポート

Project dashboardの実画面を試し、確認できた範囲と未確認の経路を保存します。
このディレクトリは開発用です。通常のdashboard起動にQA用のAPIや状態は追加しません。
結果はJSONから静的HTMLへ生成し、状態・端末・操作・接続経路・証拠の水準で絞り込めます。

## 準備とレポート生成

以下はリポジトリのルートで実行します。Node.js 22+が必要です。
ブラウザーfixtureにはdashboardの依存パッケージと実ブラウザーも必要です。

```sh
npm ci --prefix dashboard
node dashboard/qa/cli.mjs init work/issue-52-qa/results.json
```

`init`は現在のcheckoutのHEAD SHAとdirty状態を記録します。既存JSONは上書きせず、
結果が空の状態から始めます。未記録の経路はすべて`not-run`です。
試験した結果だけをJSONの`results`へ追加し、証拠ファイルをJSONと同じディレクトリか
その配下へ保存します。

```sh
node dashboard/qa/cli.mjs validate work/issue-52-qa/results.json
node dashboard/qa/cli.mjs report work/issue-52-qa/results.json work/issue-52-qa/report.html
```

生成した`report.html`をブラウザーで開きます。状態の「未確認」は`blocked`と
`not-run`をまとめて表示し、「未実施」は`not-run`だけを表示します。
各行の「手順・観測・証拠」には前提条件、環境、時刻、測定値、証拠リンクがあります。
JavaScript無効時にも全経路の表を読めますが、絞り込みは使えません。

`validate`と`report`はデータ形式と参照ファイルの存在・保存範囲を検査します。
ブラウザー試験を自動実行したり、証拠の内容から合否を決めたりするコマンドではありません。
HTMLは入力JSONとは別ファイルとして同じディレクトリへ出力します。
既存ファイルへの出力は拒否します。再生成するときは`report-2.html`などの新しい出力名を
指定してください。JSONだけを修正しても、生成済みHTMLの表示は更新されません。

## 経路と証拠の水準

経路定義は[`catalog.mjs`](catalog.mjs)にあります。
Project dashboardはdesktop/mobile × local/WSL/Tailscale × 9操作の54セルです。
基本の回答セルは入力方法を限定せず、送信と保存結果を確認します。
keyboardセルはマウスなしの導線を別に検証します。同じ観測を両セルで参照する場合は、
その旨を記録し、独立した2回の試験として数えません。

操作は回答、keyboard、入力中のSSE更新、再読込、戻る、cancel、二度押し、
受理前の切断、保存後の応答消失です。これにAPI回帰1セルと、
DSH Harness Web UIのdesktop/mobile実接続2セルを加えています。

| `level` | 確認したこと | 対象セルの最低条件 |
| --- | --- | --- |
| `fixture` | API・模擬環境の回帰 | `project-api-fixture`のみ。`npm test --prefix dashboard`の実行結果を残す |
| `browser` | 実ブラウザーでのProject画面操作 | localの各セル。下記fixtureを操作した場合も、実ブラウザー観測があればこの水準 |
| `real-connection` | 記載した経路での実接続と操作 | WSL、Tailscale、Harnessの各セル。実際にその経路へ接続する |

mobile viewportはPCブラウザーの幅を変更した試験です。`environment.device`へ
幅・高さやエミュレーションの条件を記載し、実機phoneと区別します。
mobileの実接続をpass/failにするには実機を使い、`environment.device`を
`physical-phone`とします。機種・OS・ブラウザー版は環境欄や観測メモへ残します。
WSL・Tailscale経路を試していなければ、localの成功を転記せず`not-run`のままにします。

| `status` | 記録する場面 |
| --- | --- |
| `pass` | 経路の手順を実施し、必要な証拠と測定値から問題がないと確認できた |
| `fail` | 経路の手順を実施し、入力消失などの問題を確認した。失敗の証拠も残す |
| `blocked` | 実施を試みたが、環境や前提条件の不足で判定まで進めなかった |
| `not-run` | 未実施。理由だけを記録できる。結果そのものを省略してもこの状態になる |

入力消失、focus消失、重複回答を観測した結果は`pass`にできません。
未取得の値は省略または`null`とし、推測で`false`や`0`を埋めないでください。
POSTを2回観測しても、耐久feedbackが1件なら「重複回答2件」ではありません。
Projectの各操作を`pass`とするには、入力消失・重複回答・POST数・feedback件数を
実測します。回答・keyboard・二度押し・切断復帰は、確認対象の回答が保存された
最終状態で判定し、feedback 1件・POST 1回以上を必要とします。
SSE入力・再読込・戻る・cancelは未送信の操作なので、POST・feedbackとも0件を確認します。
SSE入力とcancelではfocus保持も必要です。keyboardは送信でフォームが消えるため、
送信前のキーボード移動と送信後のfocus先を観測メモに書き、同じ入力欄への保持を
確認できない場合は`focus_preserved: null`とします。

検査できるのは記録された値の整合性です。証拠を実際に読んだり、ブラウザーで操作したり
せずに合格を保証するものではありません。途中の状態は最終合格として記録せず、
完了できなかった理由とともに`blocked`、または実際の不具合なら`fail`にします。

## 実ブラウザー用fixture

```sh
node dashboard/qa/fixture.mjs --directory work/issue-52-fixtures
```

`--directory`は任意の親ディレクトリです。省略時はOSの一時ディレクトリを使います。
起動ごとに新しい`rdsh-qa-*`子ディレクトリとsynthetic projectを作り、
実際の`startDashboard()`、`ui.html`、`app.mjs`をloopbackで起動します。
既存projectの状態を使わず、Tailscaleは有効にしません。

実機をTailscale経由で確認するときは、共有する合成データとポートを決め、
次のように明示的に有効化します。`--port`を省略すると空きポートを選びます。

```sh
node dashboard/qa/fixture.mjs --directory work/issue-52-fixtures --port 59131 --tailscale
```

`tailscale_browser_url`を対象端末で開きます。既存の`enableShare()`で実際のServe設定を
確認してから、そのHTTPS originだけを中継の許可先へ追加します。起動後にServeを
手動設定するだけでは、ローカル専用fixtureが外部Hostを拒否します。
認証は実サーバーが引き続き検査します。別Host/Originや不正なブラウザー鍵は拒否します。
障害は中継で発生させるため、実無線切断の試験と区別してください。
これは通常のrdsh-dashboard起動や、本体のTailscale共有設定の確認を代用しません。
`stop`は既存仕様と同じくServe設定を残します。試験専用ポートの経路が不要なら、
対象を確認して`tailscale serve --https=59131 off`でそのポートだけ解除します。

起動時に表示される`browser_url`を実ブラウザーで開きます。
fragmentに含まれる鍵はこのfixture専用です。証拠にURL・ヘッダー・`runtime.json`を
貼り付けず、結果用の`result_file`と画面の観測を保存してください。
端末は開いたままにして、次のコマンドを1行ずつ入力します。

| コマンド | 動作 |
| --- | --- |
| `help` | 利用できるコマンドを表示 |
| `log` | 実サーバーへsynthetic進捗を追加し、SSE更新を起こす |
| `hold` | 次の回答POSTをサーバーへ渡す前に保留。後続POSTは通常どおり観測・転送 |
| `release` | 保留中のPOSTを実サーバーへ渡し、応答を返す |
| `drop-before` | 次の回答POSTをサーバーへ渡す前に切断。その後もofflineを維持 |
| `drop-after` | 次の回答POSTでSSEを切断し、実サーバーの応答を破棄。その後もofflineを維持 |
| `resume` | 接続を復帰し、未使用の障害指定を解除。保留中POSTには先に`release`が必要 |
| `status` | 件数と状態を表示し、`result_file`へ保存 |
| `stop` | このfixtureのサーバーだけを停止。作成したファイルは残す |

`result_file`は最新状態で更新されます。各確認点で別名の証拠ファイルへコピーし、
後の操作で比較元を失わないようにします。記録には全体と質問別のPOST試行数、転送数、
耐久feedback件数があります。offline中も本文を最大131072バイトまで読み、既知の質問IDを
取得できたPOSTは質問別試行数へ計上します。全体の試行数から質問別試行数の合計を引いた
`answer_post_unattributed`には、未知ID、不正・サイズ超過・中断された本文、受信中で
まだ質問を特定できないリクエストが含まれます。
Chromeなどは切断されたリクエストを自動再試行することがあります。POST試行数は通信の
試行回数であり、クリック回数ではありません。試す質問を1件に絞って前後差を比較し、
重複回答の有無はその質問の耐久feedback件数で判定します。
結果には回答本文を含めないため、下書き・回答本文・focusはブラウザーでも確認します。

優先する操作は次のとおりです。

1. `Q-sse`へ未送信の回答を入力し、focusを置いたまま`log`を実行する。
   本文、focus、feedback 0件を確認する。
2. `hold`を指定して`Q-double`を送信し、二度押しやEnter、`log`後の再送を試す。
   `release`後、回答POST数とfeedback件数をそれぞれ確認する。
3. `drop-before`を指定して`Q-before`を送信する。下書きとfeedback 0件を確認し、
   `resume`後の再送で表示とfeedbackが1件になるか確認する。
4. `drop-after`を指定して`Q-after`を送信する。応答を失った時点の画面と保存件数を
   記録し、処理完了後に`resume`する。再接続後の表示と重複の有無を確認する。
5. `Q-navigation`を使い、keyboard、再読込、別ページから戻る操作を個別に試す。
   cancelは回答下書きからコマンドパレットをボタンで開き、Escapeで閉じる操作。
   質問の取消しや送信済み回答の取消しを意味しない。

各経路は[`catalog.mjs`](catalog.mjs)の手順で判定します。別の回答試験と混ぜないよう、
必要に応じて`stop`後に新しいfixtureを起動してください。読み込み直後だけでなく、
SSE再接続後やブラウザーの戻る操作後の実画面も観測します。

## 結果JSONの契約

[`report.mjs`](report.mjs)が受け付けるschemaは`1`です。未知のフィールド、
未知または重複した`case_id`は拒否されます。1ファイルは1つの対象版の記録であり、
各セルの結果は1件です。別の対象版・実行結果を比較する場合は別ディレクトリへ保存します。

次は**形式を示す架空の例**です。SHA、環境、時刻、コマンド、数値、証拠を
実際の観測へ置き換えてください。

```json
{
  "schema": 1,
  "target": {
    "sha": "0000000000000000000000000000000000000000",
    "dirty": true,
    "note": "形式例。実際のHEADと、source-diff.txtおよび新規ソースの保存場所へ置き換える。"
  },
  "results": [
    {
      "case_id": "project-desktop-local-sse-draft",
      "status": "pass",
      "level": "browser",
      "observed_route": "local",
      "tested_at": "2026-10-08T00:00:00Z",
      "environment": {
        "os": "実際のOSと版",
        "node": "実際のNode.js版",
        "browser": "実際のブラウザー名と版",
        "device": "実際のPCとviewport寸法"
      },
      "command": "node dashboard/qa/fixture.mjs --directory work/issue-52-fixtures; Q-sseへ入力し、端末でlogを実行",
      "reason": "形式例。入力中の更新後も本文とfocusが保持され、未送信だった。",
      "evidence": ["sse-after.png", "sse-status.json", "source-diff.txt"],
      "observations": {
        "input_lost": false,
        "duplicate_answers": 0,
        "answer_requests": 0,
        "feedback_count": 0,
        "focus_preserved": true,
        "detail": "形式例。画面観測とfixtureの前後記録を対応させる。"
      }
    },
    {
      "case_id": "project-mobile-tailscale-answer",
      "status": "not-run",
      "reason": "この実行では実機phoneからTailscale Serveへ接続していない。"
    }
  ]
}
```

必須条件と制限は次のとおりです。

- `target.sha`は小文字16進数40桁、`dirty`はboolean、`note`は空でない文字列。
  `init`後にソースを変更した場合、対象版の説明と証拠も更新して再試験する。
- `not-run`で指定できるのは`case_id`、`status`、空でない`reason`だけ。
  実施日時や実行証拠を持つ結果として扱わない。
- それ以外は`level`、`observed_route`、`tested_at`、`environment`、`command`、
  `reason`、`evidence`、`observations`が必須。`observed_route`は経路定義と一致させる。
  `tested_at`はUTCのISO時刻（末尾`Z`、小数秒は任意で最大3桁）。
- `environment`の`os`、`node`、`browser`、`device`は各500文字以内の空でない文字列。
  APIのみならbrowser/deviceに「対象外」、取得前にblockedとなった項目には未取得の理由を記す。
- `evidence`は最大20個。pass/failには1個以上と経路に必要な水準の証拠が必要。
  blockedは空配列にできるが、障害ログを残せる場合は参照する。
- `observations`の各項目は任意で、booleanの`input_lost`・`focus_preserved`、
  0以上の安全な整数の`duplicate_answers`・`answer_requests`・`feedback_count`、
  空でない文字列の`detail`だけを受け付ける。数値とbooleanは未取得なら`null`にできる。
- SSE入力、二度押し、受理前切断、保存後応答消失のpass/failでは、
  `input_lost`・`duplicate_answers`・`feedback_count`の実測が必須。
  SSE入力以外の3経路では`answer_requests`の実測も必須。
- 上のfail条件に加え、Projectの全9操作のpassには
  `input_lost: false`・`duplicate_answers: 0`・POST数・feedback件数の実測が必須。
  送信操作と未送信操作の件数条件、SSE/cancelのfocus条件は「経路と証拠の水準」に従う。
  API回帰とHarness接続にProject回答の件数条件は適用しない。
- 通常の文字列は4000文字以内。証拠パスは512文字以内で、ASCII英数字・`_`・`-`・
  区切りの`.`・`/`を使う。拡張子は`png/jpg/jpeg/gif/txt/json/html/log/md`。
  URL、絶対パス、空白、クエリ、`..`は使えない。

証拠パスはJSON・HTMLのあるディレクトリからの相対パスです。
CLIは実際のファイルの存在も確認し、外部ディレクトリへ向くsymlinkも拒否します。
配布・移動するときはJSON、HTML、証拠をディレクトリごと保持してください。

dirtyなcheckoutではSHAだけで試験対象を特定できません。追跡済みの変更は
`git diff --binary HEAD`の出力を`source-diff.txt`などへ保存し、未追跡の新規ソースも
別途保存して`target.note`に対応関係を記します。`git diff`だけでは未追跡ファイルを
含められません。差分を保存してもSHAにcommit済みという意味にはなりません。
fixtureの認証情報や実projectのデータを証拠へ混入させないでください。

## DSHとリリース手順との境界

rdshは高速なRust処理以外を既存DSHへ委譲し、Agent loopやprofile起動を
再実装しません。Project dashboardの質問・回答と、harnessモードが開く
元DSH Web UIは別の対象です。このfixtureはProjectのHTTP・SSE・画面だけを使い、
DSH、WSL、Tailscale、インストール済みランチャーの起動やモデル実行は検証しません。

Harnessの実接続セルは既存の`rdsh-dashboard harness`手順で別途確認します。
Dotの実トリガーや有料APIの実行も、このレポートのlocal成功からは確認済みにできません。
リリース全体のversion更新・配布・インストーラー確認は
[#7](https://github.com/sahenjp/rustdsh/issues/7)の範囲を維持します。
