# rustdsh用workflow memberボード

DSHの読み取り専用進捗ボードを、固定したsource patchと実行可能な適用・診断ツールとして同梱します。既存の独立したplugin導入ツールと同じ配置を使い、launcherや実行エンジンは変更しません。`workflow-run`を二重登録するpluginではありません。

patchはDSHのUI・テスト・文書・lockfileの18ファイルだけを変更します。baseは `f97c0438fb1608bbc4c08c88a27344249795ea22`（source package `0.1.7-rc.2`）、board commitは `7bd9ac31c23fe369d1fa9a6849869f04967d6ee5` です。`manifest.json`にchecksum・commit・変更ファイル・適用後18ファイルのGit blob IDを固定し、無関係なDSH sourceや履歴はvendorしません。DSHのMIT noticeは `DSH-LICENSE` に保持し、ZCode sourcecopyはありません。

## 対応sourceの準備

Node.js 22以降とGitが必要です。検証済みbaseのcleanな隔離DSH checkoutを選択します。例えば `sahenjp/deepseek-harness` を別ディレクトリへcloneし、上記baseでdetached checkoutします。global npm package、導入済みprofile、他タスクのcheckoutは指定しないでください。Git管理外のpackageディレクトリは拒否しますが、Git checkoutが稼働中の導入先にリンクされているかは検出できません。隔離sourceの選択は利用者が行います。

rustdsh checkoutから実行します。PowerShellでも同じコマンドです。

```sh
node plugins/workflow-board/source-patch.mjs --source ../dsh-board-source --check
node plugins/workflow-board/source-patch.mjs --source ../dsh-board-source --apply
```

既定は書き込まないcheckです。directory link/junction経由でもCLIを実行できます。applyはsource root・exact base・patch checksum・commit header・18ファイルの一致とcleanな作業ツリーを要求し、patch全体を事前確認してから適用し、reverse checkと全対象blobで検証します。成功時は `applied`、全対象が一致し無関係なtracked/untracked編集がない繰返しだけ `already-applied` を返します。CRLFのtextはclean filterを実行せずGitのLF blobと照合します。Gitの所有者検査を保持し、repository fsmonitorは無効にして、利用者のwhitespace設定によるpatchの変更・誤拒否を防ぎます。事前確認に失敗した既存ファイルは保持します。`APPLY_FAILED`・`VERIFY_FAILED`の場合は再試行前にsource diffを確認してください。書込失敗を隠すresetは行いません。

適用したDSH sourceは通常のworkspace手順でbuildし、そのbuildの導入方法を明示的に選択してください。このツールはpackage導入・build script実行・DSH差替え・profile変更・タスク開始/停止を行いません。rdshは選択した元DSHへ委譲を続けます。上流更新や異なるsource revisionには再検証したpatchが必要で、互換性を推測して適用しません。

## 表示内容と検証

既存の永続 `workflow-run` renderer/reducerを拡張し、会話内toggleと既存右ペインのtabに、開始済みmemberだけをrunId＋member.seqで表示します。running・completed・failed・cancelled・interrupted、memberラベル、厳密なphase、成功完了数/開始数を表示し、model名・未開始queue・課題数・結果・成果物は捏造しません。子会話リンクは親のdirect-child catalogとrunning条件を維持します。SessionごとにChat keyだけを保存し、live projectionから復元します。狭い画面、折畳み、Escape、focus保持に対応します。

表示projectionには、run終了後の遅延member-startを無視する、member outcomeとrun stop reasonは最初の記録を保持する、run終了時にoutcome未記録のmemberをinterruptedと表示する変更も含みます。遅れて届いた最初のmember outcomeで、そのmemberの状態は確定できます。既存run panelとboardに共通するrenderer/reducerの変更で、実行エンジンと永続イベント記録は変更しません。

```sh
node --test plugins/workflow-board/tests/source-patch.test.mjs
```

適用ツールは一時Git fixtureでcheck、実適用、nested新規ファイル・stage済みの繰返し、空白path、link/junction起動、適用済みsourceへの別編集、blob/CRLF、root/revision違い、checksum/header/対象違い、所有者/fsmonitor、whitespace設定、複数ファイル競合、書込・適用後検証失敗を確認します。同梱patchの実header・numstatもmanifestと照合します。network・model・profileは不要で、CIはNode 22のLinux/macOS/Windowsで実行します。

同梱board sourceはDSHのfocused 49テストと、実Chromeの1440px/390px・明暗テーマ・reload・Session切替・live状態移動・focus・Escape・正規リンク・text escapeのfixture QAを通過しています。productionコンポーネント＋scriptedイベントの検証で、導入済み実サーバーの確認ではありません。実導入/差替え、実workflowと完全なDSH build/GUI/web gateは未検証です。以前の導入済みDSH `0.2.0-rc.2`は関連イベントの公開接点が一致しますが、このsource baseではなく、自動patchしません。関連：[rustdsh #83](https://github.com/sahenjp/rustdsh/issues/83)。
