# rustdsh用workflow memberボード

DSHの読み取り専用進捗ボードを、固定されたsource patchと実行可能な適用・診断ツールとして同梱します。既存の独立したplugin導入ツールと同じ配置を採用しており、launcherや実行エンジンは変更しません。`workflow-run`を二重登録するpluginではありません。

patchはDSHのUI・テスト・文書・lockfileの18ファイルのみを変更します。baseは `f97c0438fb1608bbc4c08c88a27344249795ea22`（source package `0.1.7-rc.2`）、board commitは `7bd9ac31c23fe369d1fa9a6849869f04967d6ee5` です。`manifest.json`にchecksum・commit・変更ファイル・適用後の18ファイルのGit blob IDを固定しており、無関係なDSH sourceや履歴はvendorしません。DSHのMIT noticeは `DSH-LICENSE` に保持されており、ZCode sourcecopyはありません。

## 対応sourceの準備

Node.js 22以降とGitが必要です。検証済みbaseのcleanで隔離されたDSH checkoutを選択してください。例えば `sahenjp/deepseek-harness` を別ディレクトリへcloneし、上記baseでdetached checkoutします。global npm package、導入済みprofile、他タスクのcheckoutは指定しないでください。Git管理外のpackageディレクトリは拒否されますが、Git checkoutが稼働中の導入先にリンクされているかどうかまでは検出できません。隔離sourceの選択は利用者が行います。

rustdsh checkoutから実行します。PowerShellでも同じコマンドです。

```sh
node plugins/workflow-board/source-patch.mjs --source ../dsh-board-source --check
node plugins/workflow-board/source-patch.mjs --source ../dsh-board-source --apply
```

既定の動作は書き込みを行わないcheckです。directory linkやjunction経由でもCLIを実行できます。applyはsource root・exact base・patch checksum・commit header・18ファイルの一致とcleanな作業ツリーを要求し、patch全体を事前確認した上で適用し、reverse checkおよび全対象blobによって検証します。成功時は `applied` を返し、全対象が一致していて無関係なtracked/untrackedの編集がない再実行時のみ `already-applied` を返します。CRLFのtextはclean filterを実行せずにGitのLF blobと照合します。Gitの所有者検査を維持しつつrepository fsmonitorを無効化することで、利用者のwhitespace設定によるpatchの改変や誤拒否を防ぎます。事前確認に失敗した既存ファイルは保持されます。`APPLY_FAILED` や `VERIFY_FAILED` が発生した場合は、再試行前にsource diffを確認してください。書き込み失敗を隠蔽するようなresetは行いません。

適用後のDSH sourceは通常のworkspace手順でbuildし、そのbuildの導入方法を明示的に選択してください。このツールは、package導入・build script実行・DSH差替え・profile変更・タスクの開始や停止を行いません。rdshは選択された元のDSHへの委譲を継続します。上流の更新や異なるsource revisionには再検証したpatchが必要となるため、互換性を推測して適用することはありません。

## 表示内容と検証

既存の永続的な `workflow-run` renderer/reducerを拡張し、会話内のtoggleと既存の右ペインにあるtabに、開始済みのmemberのみをrunId＋member.seqで表示します。running・completed・failed・cancelled・interrupted、memberラベル、厳密なphase、成功完了数/開始数を表示し、model名・未開始queue・課題数・結果・成果物を捏造することはありません。子会話リンクは親のdirect-child catalogとrunning条件を維持します。SessionごとにChat keyのみを保存し、live projectionから復元します。画面の縮小、折りたたみ、Escapeキー操作、focus保持に対応しています。

表示projectionには、run終了後の遅延したmember-startを無視する変更、member outcomeとrun stop reasonは最初の記録を保持する変更、run終了時にoutcome未記録のmemberをinterruptedと表示する変更も含まれます。遅れて届いた最初のmember outcomeによって、そのmemberの状態を確定できます。既存のrun panelとboardに共通するrenderer/reducerの変更であり、実行エンジンと永続イベント記録は変更しません。

```sh
node --test plugins/workflow-board/tests/source-patch.test.mjs
```

適用ツールは、一時的なGit fixtureを用いて、check、実際の適用、nested新規ファイルやstage済みの繰り返し実行、空白を含むpath、link/junction経由の起動、適用済みsourceへの別編集、blob/CRLFの扱い、root/revisionの違い、checksum/header/対象の違い、所有者検査やfsmonitor、whitespace設定、複数ファイルの競合、書き込みや適用後検証の失敗を確認します。同梱されているpatchの実際のheaderやnumstatもmanifestと照合します。network・model・profileは不要で、CIはNode 22環境のLinux/macOS/Windowsで実行します。

同梱されているboard sourceは、DSHのfocused 49テストに加え、実Chrome環境における1440px/390px・明暗テーマ・reload・Session切替・live状態移動・focus・Escape・正規リンク・text escapeのfixture QAを通過しています。これはproductionコンポーネントとscriptedイベントによる検証であり、導入済みの実サーバーにおける確認ではありません。実際の導入や差替え、実workflow、および完全なDSH build/GUI/web gateは未検証です。以前の導入済みDSH `0.2.0-rc.2` は関連イベントの公開接点が一致しますが、このsource baseではないため、自動ではpatchを適用しません。関連：[rustdsh #83](https://github.com/jimoto-no-llm/rustdsh/issues/83)。
