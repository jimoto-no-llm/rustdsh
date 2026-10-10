# 提出記録の来歴と限界

この履歴はmain `96dbcbb`への統合前のものです。ここにある合格・画像・74件の結果を、統合後のソースで再実施した証拠として使用しません。[統合後の検証](../../current-integration.md)を別記しています。

このディレクトリは複数の実施時点の結果をまとめた提出資料です。結果JSONのtarget.shaは基点6040075f5ca339adafceeb81d39458c7c7bd64aeで、dirty=trueは追加のUI・認証案内修正を含む提出状態を示します。各セルがこの最終状態で実施されたことを示す値ではありません。最終ソースとの対応は親ディレクトリの提出資料を併せて確認してください。[戻る・リンクの追試](navigation-auth.md)と[UI・認証案内の後続検証](followup-verification.md)を分けて記録しています。

- 旧local18セル: ec5fbf7で実施。日時・観測値を保持し、再試験扱いにしていません。
- 旧desktop WSL/Tailscale18セル: 当時の6040075での同一WSL+Tailscale試行を共有します。
- 旧iPhone実接続・Harness・API: 原記録の環境と日時を保持。途中の障害や手動復旧、Safariとアプリ内ブラウザーの区別の限界を各要約に残します。
- 新しい戻る2セル: 6040075+スマホUI修正後、認証案内修正前。下表のbefore/app.mjsとbefore/ui.htmlがこの後続段階のUIソースを記録します。同一iPhone/WSL/Tailscale試行の2経路です。
- 最新の認証案内修正: 最終Windows/WSL各74/74、表示・復旧の追試を別資料に記載。全57セルの再実行ではありません。
- mobile-localはPC viewport、mobile-wsl/tailscaleはphysical-phone。PCキーボード合格はiPhoneの外付けキーボード合格を意味しません。
- blocked4セルはiPhone外付けキーボード不足によるkeyboard/cancel × WSL/Tailscale。タッチによる閉じる確認をEsc確認に置き換えません。
- 53 passは経路セル数です。同一試行や同一回答を複数セルで参照し、独立53試行ではありません。
- 認証エラーの原因条件は再現済みですが、以前の特定時刻の操作順は記録不足で未特定です。現在の完全URLリンク・貼り付け成功と区別します。
- 障害注入は合成fixtureの中継で行いました。無線環境全般・モデル実行・全端末・全操作の保証は含みません。

## 配布した証拠の扱い

各セルのevidenceリンクは、このreport配下に同梱したテキスト要約へ到達します。原資料の相対ラベル・観測値・時刻・制約を残しており、原画像や生ログそのものではありません。画像には接続先等が含まれるため配布しません。ローカルの旧記録は変更せず保持しています。下表のSHA256は要約の採録元を特定する値であり、内容を単独で検証するものではありません。

| ローカル原資料ラベル（未同梱） | SHA256 |
| --- | --- |
| `outputs/issue-52-complete/report/results-final.json` | `0884713e1507ebb88bee189b9c1639e601bb4cfc6017b5833681223fba333f75` |
| `outputs/issue-52-navigation-auth/notes.md` | `41d7b164b6054463e9271fc82c79e3b07213972044b593dfa9472a455c12b299` |
| `outputs/issue-52-navigation-auth/phone-result.json` | `351d38e24b1fa2644188da0e1f3da1dcf2f72d3808f65447b242c8eee03cc16d` |
| `outputs/issue-52-mobile-ui/browser-observations.json` | `efc3b706f6bfc758b271127b459e470e5afc7cf16010e3dfba237efa28fd889d` |
| `outputs/issue-52-auth-notice/notes.md` | `720f2399ee54f9dcd571438450fad9ccb04f088f5633d315650269925d9b9f43` |
| `outputs/issue-52-auth-notice/windows-final.log` | `1c4c6c2ec7750944e93de6492d0591f4ed07858f9747356cdf192e5a2971fe5d` |
| `outputs/issue-52-auth-notice/wsl-final.log` | `3f5c1af1882d397e37a8cd76837da0648cd2570d4eb5b2c2f0d68fc49aa105c8` |
| `outputs/issue-52-auth-notice/before/app.mjs` | `c1ae31cb5cb69477f2b5e4d77e7950edb60c5ce5eb5c268ae0de5d2ba13d24b8` |
| `outputs/issue-52-auth-notice/before/ui.html` | `bfc8b76888440dce634a916e8f3bcb4363dd2683133d2da2e51c09310c64cca9` |

## 対応表

| 本資料 | 採録元 |
| --- | --- |
| local-history.md | 旧results-final.jsonのlocal18セル、各セルのlegacy証拠ラベル |
| desktop-connections.md | 同JSONのdesktop WSL/Tailscale18セル、current観測資料 |
| phone-history.md | 同JSONの旧iPhone16セル、current/final-evidence観測資料 |
| harness-history.md | 同JSONのHarness2セル、currentの公式DSH接続資料 |
| api-history.md | 同JSONのAPI1セル |
| navigation-auth.md | 後続navigation-auth/notes.mdとphone-result.json |
| followup-verification.md | mobile-ui/browser-observations.json、auth-notice/notes.mdとWindows/WSL最終ログ |
