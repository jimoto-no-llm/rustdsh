import { ProductLocaleError } from "./product-locale.mjs";
import { RunnerError } from "./agent-runners.mjs";

export const cliEntries = [
  ["error.budgetAdmissionAction", "budget-admissionの操作またはオプションが不正です", "Invalid budget-admission action/options", "budget-admission 操作或选项无效"],
  ["error.agentsAction", "agentsの操作またはオプションが不正です", "Invalid agents action/options", "agents 操作或选项无效"],
  ["error.agentsSubmit", "agents submitには--agent、--project、--prompt-fileが必要です", "agents submit requires --agent, --project and --prompt-file", "agents submit 需要 --agent、--project 和 --prompt-file"],
  ["error.agentRunner", "エージェント実行エラー: {code}", "Agent runner: {code}", "代理运行器错误：{code}"],
  ["error.privateJson", "非公開JSON要求ファイルの処理に失敗しました（{operation}、コード{code}）", "Private JSON request file operation failed ({operation}, code {code})", "私密 JSON 请求文件操作失败（{operation}，代码 {code}）"],
  ["error.costPureOptions", "cost-ledgerのvalidate/public/schemaには--input-fileが必要です。projectは指定できません", "Cost ledger validate/public/schema requires --input-file and takes no project", "cost-ledger 的 validate/public/schema 需要 --input-file，不能指定 project"],
  ["error.nativeAbsolute", "RDSH_BINは絶対パスで指定してください", "RDSH_BIN must be an absolute path", "RDSH_BIN 必须为绝对路径"],
  ["error.nativeMissing", "rdshがPATHにありません（RDSH_BINでも指定できます）", "rdsh is not installed on PATH (or set RDSH_BIN)", "PATH 中未安装 rdsh（也可设置 RDSH_BIN）"],
  ["error.taskOutcomesAction", "task-outcomesの操作またはオプションが不正です", "Invalid task-outcomes action/options", "task-outcomes 操作或选项无效"],
  [
    "error.portRange",
    "ポートは1024～65535の整数で指定してください",
    "Port must be an integer between 1024 and 65535",
    "端口必须为 1024 到 65535 之间的整数",
  ],
  [
    "error.inputRequired",
    "入力JSONファイルを指定してください",
    "Specify the input JSON file",
    "请指定输入 JSON 文件",
  ],
  [
    "error.inputFile",
    "入力JSONは256 KiB以下の通常ファイルである必要があります",
    "Input JSON must be a regular file of at most 256 KiB",
    "输入 JSON 必须为不超过 256 KiB 的普通文件",
  ],
  [
    "error.inputLimit",
    "入力JSONが256 KiBを超えています",
    "Input JSON exceeds 256 KiB",
    "输入 JSON 超过 256 KiB",
  ],
  [
    "error.inputInvalid",
    "入力JSONが不正です",
    "Input JSON is invalid",
    "输入 JSON 无效",
  ],
  [
    "error.nodeInjection",
    "管理対象Nodeへの注入は非対応です。固定ランタイムを使う前にNODE_OPTIONS/NODE_PATHを解消してください",
    "Managed Node injection is unsupported; resolve NODE_OPTIONS/NODE_PATH before using the pinned runtime",
    "不支持向受管 Node 注入。使用固定运行时前请处理 NODE_OPTIONS/NODE_PATH",
  ],
  [
    "error.selectionChanged",
    "固定CLIへの委譲前に管理対象の選択が変わりました。選択を更新してください",
    "Managed selection changed before pinned CLI dispatch; refresh the selection",
    "转交固定 CLI 前受管选择已改变。请刷新选择",
  ],
  [
    "error.pinnedChanged",
    "固定CLIまたはランタイムのパスが変わりました。記録済みリリースを復元してください",
    "Pinned CLI/runtime path changed; restore the captured release",
    "固定 CLI 或运行时路径已改变。请恢复已记录的版本",
  ],
  [
    "error.managedMissing",
    "管理対象の実行または既定設定が存在しません",
    "Managed run/default no longer exists",
    "受管运行或默认设置已不存在",
  ],
  [
    "error.dshExecutable",
    "--executableで元のDSH実行ファイルを指定してください",
    "Specify the original DSH executable with --executable",
    "请使用 --executable 指定原始 DSH 可执行文件",
  ],
  [
    "error.managedPinned",
    "この実行またはプロジェクトは管理対象リリースに固定されています。記録済みコマンドを使うにはexecutable/entrypointを省略してください",
    "This run/project pins a managed release; omit executable/entrypoint to use its captured command",
    "此运行或项目已固定到受管版本。请省略 executable/entrypoint 以使用已记录的命令",
  ],
  [
    "error.releaseOptions",
    "リリース選択オプションにはreleaseが必要です",
    "Release selection options require release",
    "版本选择选项需要 release",
  ],
  [
    "error.managedDispatch",
    "管理対象への委譲には記録済みCLI接続またはネイティブ検証が必要です",
    "Managed dispatch requires a captured CLI attachment or native qualification",
    "受管转交需要已记录的 CLI 连接或原生验证",
  ],
  [
    "error.backupOptions",
    "バックアップ用オプションにはbackupが必要です",
    "Backup options require backup",
    "备份选项需要 backup",
  ],
  [
    "error.integrationOptions",
    "統合または作業者用オプションには対応するコマンドが必要です",
    "Integration/worker options require their command",
    "集成或工作者选项需要相应命令",
  ],
  [
    "error.workerOptions",
    "作業者ワークスペース用オプションにはworkersが必要です",
    "Worker workspace options require workers",
    "工作者工作区选项需要 workers",
  ],
  [
    "error.budgetOptions",
    "予算制御にはsession-ledger start/resumeまたはreply-consumer once/serveで--budget-guardと--worker-idが必要です",
    "Budget enforcement requires --budget-guard and --worker-id on session-ledger start/resume or reply-consumer once/serve",
    "预算控制需要在 session-ledger start/resume 或 reply-consumer once/serve 中指定 --budget-guard 和 --worker-id",
  ],
  [
    "error.retryOptions",
    "再試行用オプションには--retryが必要です",
    "Retry options require --retry",
    "重试选项需要 --retry",
  ],
  [
    "error.retryAdapters",
    "--retryはadaptersでのみ使えます",
    "--retry is available for adapters only",
    "--retry 仅可用于 adapters",
  ],
  [
    "error.checkpointOptions",
    "チェックポイント用オプションにはcheckpointが必要です",
    "Checkpoint options require checkpoint",
    "检查点选项需要 checkpoint",
  ],
  [
    "error.acceptanceOptions",
    "受入検証用オプションにはacceptanceが必要です",
    "Acceptance options require acceptance",
    "验收选项需要 acceptance",
  ],
  [
    "error.routingOptions",
    "モデル経路用オプションにはroutingが必要です",
    "Model route options require routing",
    "模型路由选项需要 routing",
  ],
  [
    "error.releaseAction",
    "release stage、inspect、canary、promote、rollbackのいずれかを指定してください",
    "Specify release stage, inspect, canary, promote or rollback",
    "请指定 release stage、inspect、canary、promote 或 rollback",
  ],
  [
    "error.stageInput",
    "stageには信頼するコードの入力ファイルだけを明示指定してください",
    "Stage requires only an explicit trusted code input file",
    "stage 仅接受明确指定的可信代码输入文件",
  ],
  [
    "error.captureStage",
    "コードの記録用入力はrelease stageでのみ使えます",
    "Code capture input is for release stage only",
    "代码记录输入仅可用于 release stage",
  ],
  [
    "error.inspectRegistry",
    "inspectはプロジェクトの登録情報を使います",
    "Inspect uses the project registry",
    "inspect 使用项目注册表",
  ],
  [
    "error.releaseSelection",
    "正確なリリースIDと現在のプロジェクト選択リビジョンを指定してください",
    "Select an exact release ID and current project selection revision",
    "请指定确切版本 ID 和当前项目选择修订号",
  ],
  [
    "error.backupAction",
    "backupの操作またはオプションが不正です",
    "Invalid backup action/options",
    "backup 操作或选项无效",
  ],
  [
    "error.archiveFile",
    "--archive-fileを指定してください",
    "Specify --archive-file",
    "请指定 --archive-file",
  ],
  [
    "error.reexportOptions",
    "再エクスポートには--archive-idと--output-fileだけを指定してください",
    "Re-export requires --archive-id and --output-file only",
    "重新导出仅需 --archive-id 和 --output-file",
  ],
  [
    "error.archiveMissing",
    "復元済みアーカイブが見つかりません",
    "Restored archive not found",
    "找不到已恢复的存档",
  ],
  [
    "error.exportSelection",
    "--selection-fileと、exportでは--output-fileを指定してください",
    "Specify --selection-file and export --output-file",
    "请指定 --selection-file，并在 export 中指定 --output-file",
  ],
  [
    "error.restoreOptions",
    "--archive-fileと--expected-revisionを指定してください",
    "Specify --archive-file and --expected-revision",
    "请指定 --archive-file 和 --expected-revision",
  ],
  [
    "error.integrationAction",
    "integrationの操作またはオプションが不正です",
    "Invalid integration action/options",
    "integration 操作或选项无效",
  ],
  [
    "error.expectedRevision",
    "--expected-revisionを指定してください",
    "Specify --expected-revision",
    "请指定 --expected-revision",
  ],
  [
    "error.subagentsAction",
    "subagentsの操作またはオプションが不正です",
    "Invalid subagents action/options",
    "subagents 操作或选项无效",
  ],
  [
    "error.workersAction",
    "workersの操作またはオプションが不正です",
    "Invalid workers action/options",
    "workers 操作或选项无效",
  ],
  [
    "error.costOptions",
    "cost-ledger declare/reportには--input-fileが必要です。inspectには入力ファイルを指定できません",
    "Cost ledger declare/report requires --input-file; inspect takes no input file",
    "cost-ledger declare/report 需要 --input-file；inspect 不接受输入文件",
  ],
  [
    "error.budgetAction",
    "budget policy/usageには--input-fileが必要です。inspectは読取専用です",
    "Budget policy/usage requires --input-file; inspect is read only",
    "budget policy/usage 需要 --input-file；inspect 为只读操作",
  ],
  [
    "error.instructionOptions",
    "instruction contextには--consumer-id、submit/resolveには--input-fileが必要です",
    "Instruction context requires --consumer-id; submit/resolve requires --input-file",
    "instruction context 需要 --consumer-id；submit/resolve 需要 --input-file",
  ],
  [
    "error.replyAction",
    "対応するオプションでreply-consumer inspect、once、serveのいずれかを指定してください",
    "Specify reply-consumer inspect, once or serve with supported options",
    "请使用受支持的选项指定 reply-consumer inspect、once 或 serve",
  ],
  [
    "error.replyInspect",
    "回答の検査ではCLIを起動しません",
    "Reply inspection never launches a CLI",
    "回答检查不会启动 CLI",
  ],
  [
    "error.entrypointOriginal",
    "entrypointには元の実行ファイルが必要です",
    "An entrypoint requires the original executable",
    "entrypoint 需要原始可执行文件",
  ],
  [
    "error.replyRun",
    "回答の適用には正確な--run-idが必要です。個別のコマンドIDは検査専用です",
    "Reply consumption requires an exact --run-id; individual command IDs are for inspection only",
    "应用回答需要确切的 --run-id；单个命令 ID 仅用于检查",
  ],
  [
    "error.routingAction",
    "routing bind、inspect、probe、allow-changeのいずれかを指定してください",
    "Specify routing bind, inspect, probe or allow-change",
    "请指定 routing bind、inspect、probe 或 allow-change",
  ],
  [
    "error.routingUnsupported",
    "routingに非対応のオプションです",
    "Unsupported option for routing",
    "routing 不支持此选项",
  ],
  [
    "error.routingMatch",
    "オプションをroutingの操作に合わせてください",
    "Options must match the routing action",
    "选项必须与 routing 操作匹配",
  ],
  [
    "error.probeExecutable",
    "probeには元のCLI実行ファイルが必要です",
    "probe requires the original CLI executable",
    "probe 需要原始 CLI 可执行文件",
  ],
  [
    "error.probeBind",
    "検証する前にモデル要求を紐付けてください",
    "Bind the model request before probing it",
    "探测前请绑定模型请求",
  ],
  [
    "error.acceptanceAction",
    "acceptance define、run、report、inspectのいずれかを指定してください",
    "Specify acceptance define, run, report or inspect",
    "请指定 acceptance define、run、report 或 inspect",
  ],
  [
    "error.acceptanceUnsupported",
    "acceptanceに非対応のオプションです",
    "Unsupported option for acceptance",
    "acceptance 不支持此选项",
  ],
  [
    "error.acceptanceMatch",
    "入力オプションをacceptanceの操作に合わせてください",
    "Input options must match the acceptance action",
    "输入选项必须与 acceptance 操作匹配",
  ],
  [
    "error.criterionOptions",
    "基準、対象範囲、画像はrunまたはreportでのみ使えます",
    "Criterion, scope and images apply to run or report only",
    "标准、范围和图片仅可用于 run 或 report",
  ],
  [
    "error.checkpointAction",
    "checkpoint record、list、inspect、resume、start-newのいずれかを指定してください",
    "Specify checkpoint record, list, inspect, resume or start-new",
    "请指定 checkpoint record、list、inspect、resume 或 start-new",
  ],
  [
    "error.entrypointExecutable",
    "--entrypointには--executableが必要です",
    "--entrypoint requires --executable",
    "--entrypoint 需要 --executable",
  ],
  [
    "error.checkpointDsh",
    "チェックポイントからのネイティブ復旧はDSHだけに対応しています",
    "Checkpoint native recovery supports DSH only",
    "检查点原生恢复仅支持 DSH",
  ],
  [
    "error.summaryOptions",
    "要約と文脈喪失の確認はstart-newでのみ使えます",
    "Summary and context-loss choice apply to start-new only",
    "摘要和上下文丢失确认仅可用于 start-new",
  ],
  [
    "error.recordReferences",
    "実行と再試行の参照はrecordでのみ使えます",
    "Run and retry references apply to record only",
    "运行和重试引用仅可用于 record",
  ],
  [
    "error.verifyInspect",
    "--verify-nativeはinspectでのみ使えます",
    "--verify-native applies to inspect only",
    "--verify-native 仅可用于 inspect",
  ],
  [
    "error.listOptions",
    "listには実行ファイルやチェックポイントIDを指定できません",
    "list takes no executable or checkpoint ID",
    "list 不接受可执行文件或检查点 ID",
  ],
  [
    "error.recordCheckpoint",
    "recordがチェックポイントIDを割り当てます",
    "record allocates a checkpoint ID",
    "record 会分配检查点 ID",
  ],
  [
    "error.originalExecutable",
    "元のCLI実行ファイルを指定してください",
    "Specify the original CLI executable",
    "请指定原始 CLI 可执行文件",
  ],
  [
    "error.startNewOptions",
    "start-newには--summary-fileと--accept-context-lossが必要です",
    "start-new requires --summary-file and --accept-context-loss",
    "start-new 需要 --summary-file 和 --accept-context-loss",
  ],
  [
    "error.summaryFile",
    "要約は65536バイト以下の通常ファイルである必要があります",
    "Summary must be a regular file of at most 65536 bytes",
    "摘要必须为不超过 65536 字节的普通文件",
  ],
  [
    "error.summaryLimit",
    "要約が65536バイトを超えています",
    "Summary exceeds 65536 bytes",
    "摘要超过 65536 字节",
  ],
  [
    "error.retryHistoryAction",
    "retry-history listまたはinspectを指定してください",
    "Specify retry-history list or inspect",
    "请指定 retry-history list 或 inspect",
  ],
  [
    "error.runHistoryAction",
    "run-history list、inspect、eventsのいずれかを指定してください",
    "Specify run-history list, inspect or events",
    "请指定 run-history list、inspect 或 events",
  ],
  [
    "error.pagingAction",
    "ページ指定はlistまたはeventsでのみ使えます",
    "Paging applies to list or events",
    "分页仅可用于 list 或 events",
  ],
  [
    "error.sessionAction",
    "session-ledger list、record、resolve、start、resumeのいずれかを指定してください",
    "Specify session-ledger list, record, resolve, start or resume",
    "请指定 session-ledger list、record、resolve、start 或 resume",
  ],
  [
    "error.recordRun",
    "recordが新しい実行IDを割り当てます",
    "record allocates a new run ID",
    "record 会分配新的运行 ID",
  ],
  [
    "error.attachDsh",
    "接続できるのはDSH ACPだけです",
    "Only DSH ACP can be attached",
    "仅可连接 DSH ACP",
  ],
  [
    "error.nativeId",
    "resumeにはrun-idを使ってください。session IDは元のCLIから取得します",
    "Use run-id for resume; session IDs come from the native CLI",
    "resume 请使用 run-id；会话 ID 来自原始 CLI",
  ],
  [
    "error.startRun",
    "startが新しい実行IDを割り当てます",
    "start allocates a new run ID",
    "start 会分配新的运行 ID",
  ],
  [
    "error.resumeRun",
    "resumeには--run-idが必要です",
    "resume requires --run-id",
    "resume 需要 --run-id",
  ],
  [
    "error.resumeRecorded",
    "resumeは記録済みの作業ディレクトリ、タスク、providerを使います",
    "resume uses the recorded cwd, task and provider",
    "resume 使用已记录的工作目录、任务和提供商",
  ],
  [
    "error.retryDsh",
    "--retryにはadapters --cli dshと元のCLIの明示パスが必要です",
    "--retry requires adapters --cli dsh and explicit original CLI paths",
    "--retry 需要 adapters --cli dsh 和明确的原始 CLI 路径",
  ],
  [
    "error.smokeDsh",
    "スモーク検証はDSH ACPアダプターだけに対応しています",
    "Smoke supports the DSH ACP adapter only",
    "冒烟测试仅支持 DSH ACP 适配器",
  ],
  [
    "error.probeCli",
    "実行ファイルを検証するときは--cliを指定してください",
    "Specify --cli when probing an executable",
    "探测可执行文件时请指定 --cli",
  ],
  [
    "error.stopped",
    "ダッシュボードは停止中です。先に起動してください",
    "Dashboard is stopped; start it first",
    "仪表盘已停止。请先启动",
  ],
  [
    "error.projectEvents",
    "イベントはprojectモードでのみ使えます",
    "Events are available in project mode only",
    "事件仅可用于 project 模式",
  ],
  [
    "error.tunnelId",
    "OpenAI Platformのトンネル設定にあるtunnel_idを指定してください",
    "Provide the tunnel_id from OpenAI Platform tunnel settings",
    "请提供 OpenAI Platform 隧道设置中的 tunnel_id",
  ],
  [
    "error.tunnelKey",
    "接続前にCONTROL_PLANE_API_KEYをローカルで設定してください。キーをコマンド引数やチャットに書かないでください",
    "Set CONTROL_PLANE_API_KEY locally before connecting; do not put keys in command arguments or chat",
    "连接前请在本地设置 CONTROL_PLANE_API_KEY。不要将密钥放入命令参数或聊天",
  ],
  [
    "error.mcpCredential",
    "ダッシュボードのMCP資格情報が不正です。再起動してください",
    "Invalid dashboard MCP credential; restart the dashboard",
    "仪表盘 MCP 凭据无效。请重新启动仪表盘",
  ],
  [
    "error.wrongRuntime",
    "別のプロジェクトのダッシュボードです",
    "Wrong project dashboard runtime",
    "仪表盘运行时属于其他项目",
  ],
  [
    "error.tunnelStart",
    "トンネル接続の前にprojectダッシュボードを起動してください",
    "Start the project dashboard before connecting its tunnel",
    "连接隧道前请启动 project 仪表盘",
  ],
  [
    "error.tunnelRestart",
    "トンネル接続の前にダッシュボードを再起動してください",
    "Restart the dashboard before connecting its tunnel",
    "连接隧道前请重新启动仪表盘",
  ],
  [
    "error.trayWindows",
    "--trayにはネイティブWindowsが必要です。ターミナルモードでは省略してください",
    "--tray requires native Windows; omit it for terminal mode",
    "--tray 需要原生 Windows；终端模式请省略此选项",
  ],
  [
    "error.unknownCommand",
    "不明なコマンドです。--helpを使ってください",
    "Unknown command; use --help",
    "未知命令；请使用 --help",
  ],
  [
    "error.argumentParsing",
    "コマンド引数が不正です: {detail}",
    "Invalid command arguments: {detail}",
    "命令参数无效：{detail}",
  ],
  [
    "error.language",
    "--languageにはen、zh-CN、jaのいずれかを指定してください",
    "--language must be en, zh-CN or ja",
    "--language 必须为 en、zh-CN 或 ja",
  ],
  [
    "error.context",
    "処理に失敗しました: {detail}",
    "{detail}",
    "操作失败：{detail}",
  ],
  [
    "settings.read",
    "rdshの表示言語設定を読み込めません: {file}",
    "Cannot read rdsh language setting: {file}",
    "无法读取 rdsh 语言设置：{file}",
  ],
  [
    "settings.invalid",
    "rdshの設定が不正です: {file}",
    "Invalid rdsh settings: {file}",
    "rdsh 设置无效：{file}",
  ],
  [
    "settings.language",
    "rdsh設定のgeneral.languageが不正です: {file}",
    "Invalid general.language in rdsh settings: {file}",
    "rdsh 设置中的 general.language 无效：{file}",
  ],
  [
    "help.project",
    "Projectモード: プロジェクトの指標、タスク、質問、人間の返答、/mcp。",
    "Project mode: project metrics, tasks, questions, human feedback, and /mcp.",
    "Project 模式：项目指标、任务、问题、人工反馈和 /mcp。",
  ],
  [
    "help.harness",
    "Harnessモード: 管理対象のDeepSeek Harness Web画面とQR接続ページを別に起動します。",
    "Harness mode: a separate managed DeepSeek Harness Web UI and QR landing page.",
    "Harness 模式：独立启动受管 DeepSeek Harness 网页界面和二维码连接页面。",
  ],
  [
    "help.windows",
    "Windowsランチャー: project/harnessの既定は通知領域のトレイです。--no-trayでターミナルモードを使います。",
    "Windows launcher: notification-area tray by default for project/harness; --no-tray keeps terminal mode.",
    "Windows 启动器：project/harness 默认使用通知区域托盘；--no-tray 保持终端模式。",
  ],
  [
    "help.tray",
    "Node CLIの直接起動: ネイティブWindowsでは--trayでトレイを有効にします。",
    "Direct Node CLI: --tray enables the tray on native Windows.",
    "直接使用 Node CLI：--tray 在原生 Windows 上启用托盘。",
  ],
  [
    "help.tailscale",
    "Tailscale Serveは各ローカルサーバーをHTTPSで非公開共有します。",
    "Tailscale Serve shares each loopback server privately over HTTPS.",
    "Tailscale Serve 通过 HTTPS 私密共享各本地回环服务器。",
  ],
  [
    "help.session",
    "session-ledger start/resumeは元のsession IDを確認してから所有するACPプロセスを停止します。プロンプトは送信しません。",
    "Session-ledger start/resume confirms the native ID then stops its owned ACP process; it sends no prompt.",
    "session-ledger start/resume 确认原生会话 ID 后停止其拥有的 ACP 进程；不会发送提示词。",
  ],
  [
    "help.reply",
    "reply-consumer once/serveは指定された元のsessionを明示的に再開し、現在の人間の返答を一度だけ送信します。返答で実行権限は増えません。結果がない場合は再送を保留します。",
    "Reply-consumer once/serve explicitly resumes that exact native session and sends current human replies once. Replies grant no new execution permissions. Missing results block replay.",
    "reply-consumer once/serve 明确恢复对应的原生会话，并将当前人工回答发送一次。回答不授予新的执行权限。缺少结果时禁止重放。",
  ],
  [
    "help.pinned",
    "選択済みまたは固定済みの管理対象リリース",
    "selected/pinned managed release",
    "已选择或固定的受管版本",
  ],
  ["arg.command", "コマンド", "command", "命令"],
  ["arg.directory", "ディレクトリ", "directory", "目录"],
  ["arg.port", "ポート", "port", "端口"],
  ["arg.number", "数値", "number", "数字"],
  ["arg.file", "ファイル", "file", "文件"],
  ["arg.name", "名前", "name", "名称"],
  ["arg.path", "パス", "path", "路径"],
  ["arg.script", "スクリプト", "script", "脚本"],
  ["arg.relative-path", "相対パス", "relative-path", "相对路径"],
  [
    "status.stopping",
    "ダッシュボードを停止しています",
    "Stopping dashboard",
    "正在停止仪表盘",
  ],
  [
    "status.revoked",
    "イベント購読を解除しました",
    "Event subscriptions revoked",
    "已撤销事件订阅",
  ],
  [
    "status.started",
    "{command}を起動: {url}",
    "{command}: {url}",
    "已启动 {command}：{url}",
  ],
  [
    "status.open",
    "rdsh-dashboard openで開きます。Ctrl-Cで停止します。",
    "Open with rdsh-dashboard open; Ctrl-C to stop.",
    "使用 rdsh-dashboard open 打开；按 Ctrl-C 停止。",
  ],
  [
    "tray.diagnostics",
    "トレイの診断: {detail}",
    "tray diagnostics: {detail}",
    "托盘诊断：{detail}",
  ],
  [
    "share.disabled",
    "ローカル接続のみ。Tailscale共有は起動時に有効にできます。",
    "Local connection only. Enable Tailscale sharing at startup.",
    "仅限本地连接。可在启动时启用 Tailscale 共享。",
  ],
  [
    "share.not_installed",
    "このPCにTailscaleをインストールしてください。",
    "Install Tailscale on this computer.",
    "请在此电脑安装 Tailscale。",
  ],
  [
    "share.login_required",
    "このPCとスマホでTailscaleにログインし、接続してください。接続後に「接続を更新」を押すとQRコードが表示されます。",
    "Sign in to Tailscale on this computer and phone. After connecting, refresh the connection to show a QR code.",
    "请在此电脑和手机上登录并连接 Tailscale。连接后刷新连接以显示二维码。",
  ],
  [
    "share.dns_required",
    "TailscaleのMagicDNSを有効にしてください。",
    "Enable Tailscale MagicDNS.",
    "请启用 Tailscale MagicDNS。",
  ],
  [
    "share.ready",
    "スマホでTailscaleに接続してから、QRコードを読み取ってください。",
    "Connect your phone to Tailscale, then scan the QR code.",
    "请先将手机连接到 Tailscale，再扫描二维码。",
  ],
  [
    "share.consent_required",
    "Tailscale Serveの利用設定を行ってから接続を更新してください。",
    "Configure Tailscale Serve access, then refresh the connection.",
    "请配置 Tailscale Serve 访问权限后刷新连接。",
  ],
  [
    "share.setup_required",
    "Tailscale接続を確認してください: {detail}",
    "Check the Tailscale connection: {detail}",
    "请检查 Tailscale 连接：{detail}",
  ],
  [
    "status.tailscale",
    "Tailscale: {state}",
    "Tailscale: {state}",
    "Tailscale：{state}",
  ],
  ["shareState.disabled", "無効", "disabled", "已禁用"],
  ["shareState.not_installed", "未インストール", "not_installed", "未安装"],
  ["shareState.login_required", "ログインが必要", "login_required", "需要登录"],
  ["shareState.dns_required", "DNS設定が必要", "dns_required", "需要配置 DNS"],
  ["shareState.ready", "準備完了", "ready", "已就绪"],
  [
    "shareState.consent_required",
    "利用設定が必要",
    "consent_required",
    "需要授权设置",
  ],
  [
    "shareState.setup_required",
    "接続設定が必要",
    "setup_required",
    "需要连接设置",
  ],
];

export const cliCatalog = { en: {}, ja: {}, "zh-CN": {} };
for (const [key, ja, en, zh] of cliEntries) {
  cliCatalog.ja[key] = ja;
  cliCatalog.en[key] = en;
  cliCatalog["zh-CN"][key] = zh;
}
export function cliText(language, key, values = {}) {
  const message = cliCatalog[language]?.[key];
  if (message === undefined) throw new Error(`Unknown CLI message key: ${key}`);
  return message.replace(/\{(\w+)\}/g, (_, name) =>
    String(values[name] ?? `{${name}}`),
  );
}
export class CliDiagnosticError extends Error {
  constructor(key, values = {}) {
    super(cliText("en", key, values));
    this.key = key;
    this.values = values;
  }
}
export function cliErrorText(language, error) {
  if (error instanceof CliDiagnosticError)
    return cliText(language, error.key, error.values);
  if (error instanceof ProductLocaleError)
    return cliText(language, error.key, { file: error.file });
  if (error instanceof RunnerError)
    return cliText(language, "error.agentRunner", { code: error.code });
  return cliText(language, "error.context", { detail: error.message });
}
export function shareText(language, share) {
  if (Object.hasOwn(cliCatalog.en, `share.${share.state}`)) {
    return cliText(language, `share.${share.state}`, {
      detail: share.detail ?? share.message ?? "",
    });
  }
  return share.message;
}

export function shareStateText(language, state) {
  return Object.hasOwn(cliCatalog.en, `shareState.${state}`)
    ? cliText(language, `shareState.${state}`)
    : state;
}
