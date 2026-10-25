# rustdsh 用 workflow member ボード

このディレクトリには読み取り専用のDSH workflow boardを、検証済みのsource patchと実行可能な適用・診断ツールとして同梱しています。rdshの既存の独立したplugin/installツールと同じ構成を採用し、launcherと実行エンジンは変更しません。`workflow-run` pluginをもう1つ登録するものではありません。

patchが変更するのは、DSHのUI・テスト・文書・lockfileの18ファイルのみです。baseは `f97c0438fb1608bbc4c08c88a27344249795ea22`（source package `0.1.7-rc.2`）、board commitは `7bd9ac31c23fe369d1fa9a6849869f04967d6ee5` です。`manifest.json` でpatchのchecksumとcommit、対象fileの一覧、適用後の18ファイルすべてのGit blob IDを固定しています。無関係なDSH sourceや履歴はvendorしません。DSHのMIT noticeは `DSH-LICENSE` に残しており、ZCodeのsourceはコピーしていません。

## 対応するDSH sourceの準備

Node.js 22以降とGitが必要です。検証済みのbaseに合わせた、cleanで隔離されたDSH source checkoutを選択してください。例えば、`sahenjp/deepseek-harness` を別ディレクトリにcloneし、上記のbaseをdetached状態でcheckoutしてください。global npm package、導入済みprofile、他のタスクのcheckoutは指定しないでください。Git管理外のpackageディレクトリは拒否されますが、Git checkoutが稼働中の導入先にリンクされているかどうかは検出できません。隔離されたsource checkoutの選択は利用者が行います。

rustdshのcheckoutから実行します。PowerShellでも同じコマンドを実行できます。

```sh
node plugins/workflow-board/source-patch.mjs --source ../dsh-board-source --check
node plugins/workflow-board/source-patch.mjs --source ../dsh-board-source --apply
```

既定の動作は書き込みを行わないcheckです。directory linkやjunction経由でもCLIを実行できます。applyには明示的に指定したsource root、exact base、patch checksum、commit headerと対象18ファイルの一致、cleanな作業ツリーが必要です。書き込み前にGitでpatch全体を確認し、適用後はreverse checkと全対象blobを検証して、成功時に `applied` を返します。再実行時に `already-applied` を返すのは、全対象の内容が一致し、無関係なtracked/untrackedの編集もない場合に限られます。CRLFのtextはclean filterを実行せずにGitのLF blob表現と照合します。Gitの所有者検査は維持し、repositoryのfsmonitor commandは無効化します。利用者のwhitespace設定によるpatchの改変や誤拒否を防ぎます。事前確認に失敗した場合は、既存のファイルを保持します。`APPLY_FAILED` や `VERIFY_FAILED` が発生した場合は、再試行前にsource diffを確認してください。書き込みの失敗を隠すためにcheckoutをresetすることはありません。

適用後のDSH sourceは通常のworkspace手順でbuildし、そのbuildの導入方法を明示的に選択してください。このツールはpackageの導入、build scriptの実行、DSHの差替え、profileの変更、タスクの開始・停止を行いません。rdshは引き続き、選択された元のDSHへ委譲します。上流の更新や異なるsource revisionには再検証したpatchが必要となるため、互換性を推測して適用することはありません。

## 表示内容と検証

既存の永続的な `workflow-run` renderer/reducerを拡張し、会話内のtoggleと既存の右ペイン内のtabを追加します。各cardは開始済みのmemberだけを表し、runIdとmember.seqの組み合わせで識別されます。columnはrunning・completed・failed・cancelled・interruptedに分かれ、memberラベル、厳密なphase、成功して完了したmemberの数/開始したmemberの数は永続化された記録に基づいて表示します。model名、queue待ちのtask、reportの数、結果、成果物を捏造することはありません。子会話への遷移では親のdirect-child catalogとrunning状態の確認を維持します。保存するのはSessionごとに選択したChat keyだけで、表示に使う情報は既存のlive projectionから復元します。画面幅が狭い場合の表示、折りたたみ、Escapeキー操作、focus保持に対応しています。

表示projectionには遅延・重複した記録への対応も含まれます。run終了後に遅れて届いたmember-startは無視し、member outcomeとrun stop reasonは最初に記録されたものを優先します。run終了時にoutcomeが記録されていないmemberは、interruptedと表示します。遅れて届いたoutcomeがそのmemberの最初の記録であれば、そのmemberの状態を確定できます。これらは既存のrun panelとboardで共通するrenderer/reducerの変更であり、実行エンジンと永続化されたイベント記録は変更しません。

```sh
node --test plugins/workflow-board/tests/source-patch.test.mjs
```

適用ツールのtestでは一時的なGit fixtureを使って、書き込みを伴わない事前確認と実際の適用を確認します。さらに、入れ子のdirectoryにある新規ファイル、stage済みの状態で再実行した場合の冪等性、空白を含むpath、link/junction経由のCLI起動、dirtyなsourceや適用済みsourceに加えた無関係な編集を対象とします。blobの完全一致とCRLFの扱い、root/revisionの相違、checksum/header/対象範囲の相違、所有者検査の維持とfsmonitorの無効化、whitespace設定、複数ファイルにまたがるpatch全体の競合、書き込みと適用後検証での失敗注入も確認します。bundle testでは同梱されているpatchの実際のheaderとnumstatをmanifestと照合します。これらのtestにnetwork・model・profileは不要で、CIはLinux/macOS/Windows上のNode 22環境で実行します。

同梱されているboard sourceは、DSHの対象機能に絞った49件のtestと、実Chrome環境でのfixture QAを通過しています。QAでは1440px/390pxの表示、明暗テーマ、reload、Session切替、live状態の遷移、focus、Escape、許可されたリンク、text escapeを確認しています。この検証ではscriptedイベントでproductionコンポーネントを動作させており、導入済みの実サーバーへ接続して確認したものではありません。実際の導入や差替え、実サーバーでのworkflow使用、完全なDSH build/GUI/web gateは未検証です。以前に導入したDSH `0.2.0-rc.2` と今回のsourceでは、関連イベントの公開インターフェースが一致しています。ただし、以前に導入したDSHは今回のsource baseではないため、自動でpatchを適用することはありません。関連：[rustdsh #83](https://github.com/jimoto-no-llm/rustdsh/issues/83)。
