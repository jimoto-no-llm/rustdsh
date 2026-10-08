# 追指示の投稿・競合・適用タイミングの検証

対象は [Issue #19](https://github.com/sahenjp/rustdsh/issues/19) と
[実装契約](../../INPUT-INSTRUCTIONS.md) です。変更前は
`c80879ef90943e6020f3283033fb988209af5359`（PR #138）です。
ローカルfixtureと実画面での技術QAを完了しました。
実provider・実機スマホ・Tailscale越しの応答確認や、Production採用は含みません。

## 実画面の変更前・変更後

| 変更前                                  | 変更後                                    |
| --------------------------------------- | ----------------------------------------- |
| ![変更前のプロジェクト画面](before.png) | ![追指示フォームと対象session](after.png) |

既存画面と同じ実ブラウザーで、別々の所有した一時projectを表示しました。
元のACPクライアントにlocal fixtureを接続し、consumerの登録を照合しています。
ブラウザーのraw captureをPNGに形式変換した画像です。UI内容の合成や生成は行っていません。

## 競合と下書きの保持

編集中に管理エージェントが「元のAPIを維持」と投稿しても、ブラウザーの「APIを削除」
という下書きは保持されました。保存すると、配送を保留して新旧の指示を比較できました。
人間の比較チェックを入れて取り下げるまで、競合した指示のnative送信はありません。
ページの開き直しでも下書きを復元し、概要の確認待ち件数から対象へ移動できました。

![競合した新旧の指示と人間による確認](conflict.png)
![ページを開き直した後の下書き復元](draft-restored.png)

## 明示中断とsteer非対応

処理中のinput IDを画面で確認し、その入力に対して人間が中断を選びました。
元のCLIのcancelled prompt resultを受け取り、その後の追指示を同じrun/sessionへ送りました。
希望がsteerの場合は「非対応・次ターン待ち」を表示し、steerのプロトコル要求は送っていません。

![現在の入力を確認して中断を選ぶ画面](interrupt-confirmation.png)
![キャンセル結果の確認後に追指示入力を処理](interrupt-complete.png)
![steer非対応のため次ターン待ち](steer-queued.png)

## 結果不明とスマホ幅

別の所有したnative fixtureで、1回のeffect後に応答を失わせました。
表示は「結果不明・再送を保留」で、成功・失敗を断定していません。
複数consumerを切り替えても、選んだ対象の入力だけを表示することを確認しました。

390×844のブラウザー表示領域からも追指示を保存しました。対象の先行入力は結果不明なので、
その追加入力は保存済み・未適用です。実機スマホからの通信・操作の証明ではありません。
[DOM計測](mobile-geometry.json) ではdocument幅とclient幅がともに375pxで、
水平overflowはなく、selectと本文欄は347pxでした。

![応答を失った入力を不明と表示](result-unknown.png)
![390pxのブラウザー表示領域](mobile-390px.png)
![スマホ幅から同じ対象に保存し、未適用のまま保持](mobile-saved.png)

## 操作GIF

下書き、復元、競合、中断確認、入力処理完了、steer待ち、結果不明の7つの実画面です。
各PNGを2秒ずつ並べ、異なる画像高さの外側に白い余白を付けています。
個別の細部は上のPNGで確認してください。
[capture manifest](capture-manifest.json) に元画像の寸法と順序があります。

![追指示の操作フロー](flow.gif)

## CLIとnative記録

[実CLIの新旧出力](cli-before-after.json) は、同じJSON・対象を使った比較です。
変更前は `--consumer-id` / `--input-file` を拒否します。
変更後はexact targetのcontext、steerのnext-turn fallback、管理エージェントの保存を返し、
同じIDの再投稿は `duplicate: true` です。所有したnative fixtureへのpromptは1回、
effectも1回、native sessionの開始は1回でした。

[画面操作時のstate・native trace](runtime-observations.json) と
[応答消失時のnative trace](unknown-runtime-observations.json) を保存しています。
通常フローのfixture effectは3回（中断した最初の入力を含む）、
応答消失フローのeffectは1回でした。実providerへの要求は0回です。
検証後に所有したnativeプロセス、サーバー、ブラウザータブ、一時projectを片付けました。

## 自動検証

- Windows Node 22.23.3: dashboard 153/153、145101ms。
- Linux Node 24.21: dashboard 153/153、61298ms。所有プロセス検証用のdelegated cgroup内で実行。
- Rust release tests 62件、回帰検査41件、fmt、clippyの警告0を確認。
- `npm ci` を実行し、package/lockは変更していません。

追指示と回答の混在順序、IDの再送、同時入力と古いreview、管理エージェントの権限、
明示中断、cancel通知だけの応答消失、cancel claim応答の消失、
再接続後のunknown barrier、legacy feedbackによるcursor進行、state破損を検証しています。
最初の読み取りや保存だけをnative入力の完了とする検査はありません。
