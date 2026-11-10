# Native Devin ACP delegation

`native-web` の `devin_cli` は `devin --permission-mode auto acp` を使います。
`devin -p` の非対話実行では、内部ツールの承認要求を拒否しながら終了コード0・
空のstdoutになることがあり、委譲先の調査が成功したかを判定できませんでした。

既定ではモデルによる委譲提案をRust側で個別承認します。その後、DevinがACPの
`session/request_permission` を送ると、rustdshが要求された操作とコマンド・
パスなどの詳細を表示し、利用者の一度限りの許可または拒否をDevinへ返します。
`allow_always` は選びません。`allow_once` がない要求や異なるセッションの要求は
拒否します。未提供のファイル・ターミナルなどのクライアント機能も拒否します。

Devinは許可不要と判断する読み取り専用ツールを `auto` の規則で実行できます。
Devinの全操作自動承認フラグや、ワークスペース信頼を迂回する指定は付けません。
ユーザーのDevin設定ファイルや権限ルールを書き換えることもありません。

TUIの `/permission full-access` を確認して選ぶと、通常モードではRustが委譲と
ACPの内部操作を個別確認なしで承認し、`auto_allow` を記録します。
ACPにはその要求だけの `allow_once` を返し、`allow_always` は選びません。
Plan中や読み取り専用ではDevinの起動を禁止します。フルアクセスは現在のRust
プロセス内だけで有効で、次の起動時は毎回確認へ戻ります。

ACPのセッションにはRustが保持する正確なワークスペースを渡します。
モデルへのコンテキストにも同じパスをJSON文字列として渡し、別のディレクトリを
推測したり、許可なく近隣フォルダを探索したりしないよう指示します。

## 結果と中断

結果は `transport: "acp"` と次の状態を含みます。

- `processStarted`: Devinのプロセスを起動したこと
- `completed` / `executed`: 正常終端・非空の応答・承認拒否なし・ツール失敗なしの場合だけtrue
- `permissionDenied`: 内部の承認を拒否したこと
- `failedToolCalls`: ACPで失敗したツールが報告されたこと
- `completionUnknown`: タイムアウト・プロトコル異常などで完了を確認できないこと
- `stdout`: Devinの最終テキスト。`stderr` は空で、ACP以外の診断はモデルへ渡しません

ACPサーバーは常駐プロセスなので、`exitCode` はnullです。プロセス起動や終了コードを
タスクの成功と同一視しません。拒否・中断・失敗した時点までに、一部の操作が実行されて
いる場合はあります。`executed: false` だけから「何も実行されなかった」とは判断できません。

`timeout` は初期化・生成・承認待ちを含みます。時間切れでは内部の承認表示を解除し、
可能な範囲でACPのcancelled応答を返してから子プロセスを終了します。中断時は既存の
子プロセス管理に従い、Unixではプロセスグループを終了します。
ACPのメッセージ・総出力・最終テキストはそれぞれ上限を設けています。

この機能はRust組み込みの `devin_cli` 向けです。別配布のDSH用単独プラグインとは
ホストも呼び出し経路も異なります。

参照: [ACP permissions](https://agentclientprotocol.com/protocol/tool-calls)、
インストール済みDevin CLIの `devin acp --help` / `devin --help`。
