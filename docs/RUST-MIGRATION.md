# Rust移行台帳（v0.5.0 / #516）

対象ソース: **`b713e88132d7388573d3667f57d19e1f633a8647`**。
[#516](https://github.com/jimoto-no-llm/rustdsh/issues/516) の段階的移行を判断するための静的台帳であり、Issueの完了宣言ではない。
[ROADMAP](<ROADMAP.md>) は方向、Issueはstatus sourceとして維持する。

## 読み方と母集団

- **実装あり**: このSHAにRustの責務・CLI dispatchがある。**接続あり**: JS callerがそのRust経路を呼ぶ。両者は別に数える。
- **テストあり**: リンク先に契約を固定するテストがあるという意味。今回の文書更新でその試験を実行・成功確認したという意味ではない。
- **未検証**: この台帳では実環境の動作・性能・全OS互換を再確認していない。ファイル名一致、main着地、テストの存在だけで移行完了にしない。
- 旧Issue bodyの基準は `2db470bd15d2efbe58c9ff1a43e6679e5cea4d4a`。
  JS系185 files / 48,251 lines、旧対象106 / 29,946、Rust src32 / 24,817という履歴はそのまま残す。
  旧script/filterは提示されていないため、今回との差を同一母集団の増減・置換率・移植率として扱わない。

今回の計測はリポジトリrootで `git ls-files -z` により列挙した追跡ファイルだけを使う。
拡張子は `.js .mjs .cjs .jsx .ts .mts .cts .tsx`（大文字小文字を変換しない）。
宣言ファイルも含むため、JS系の全数は実行コードの量と同義ではない。
物理linesは空行・コメントを含むLF数＋末尾LFのない非空最終行1、CRLFも1行。
Rustは追跡された `src/**/*.rs` 全体で、inline testと専用test moduleを含み、外部のintegration testやrootのbuild scriptは含めない。

JS系は次の優先順で一度だけ分類する（意味解析による除外ではない）。

1. `docs/` と `media/` 配下は説明・evidence・制作補助として別枠。
2. パス要素 `test/tests/__tests__/fixture/fixtures/bench/benches/benchmark/benchmarks`、
   またはbasenameに `.test.` / `.spec.` / `fixture` / `benchmark` を含むもの、`bench-` 始まりを除外（この判定はcase-insensitive）。
3. 残りを**一次棚卸し対象**とする。Rustへ移すべきpolicy/runtime、ブラウザー処理、host adapter、build補助を含み、全数をそのまま移植予定とはしない。
   例えば隔離simulatorのfixtureは名前だけでは除外されない。分類の意味上の限界を残す。

### JS系の実測

| 領域 | 全追跡files | 全物理lines | 一次棚卸しfiles | 一次棚卸しlines |
| --- | ---: | ---: | ---: | ---: |
| Dashboard | 274 | 87,706 | 147 | 53,302 |
| plugins | 92 | 14,824 | 50 | 9,159 |
| desktop | 20 | 1,055 | 10 | 589 |
| security | 4 | 238 | 4 | 238 |
| scripts | 19 | 1,420 | 7 | 508 |
| tests | 52 | 10,074 | 0 | 0 |
| docs | 6 | 655 | 0 | 0 |
| media | 10 | 1,229 | 0 | 0 |
| **合計** | **477** | **117,201** | **218** | **63,796** |

別枠はtest/fixture/bench **243 / 51,521**、docs/media **16 / 1,884**。
拡張子別filesは `.mjs` 434、`.js` 32、`.tsx` 8、`.ts` 2、`.cjs` 1、残り0。
scriptsの7件には4つのbuild/runtime helperに加え、自前の
[headless cleanup](<../scripts/headless-runtime/runtime/plugins/rdsh-session-cleanup/cleanup.mjs>) 等3件を含める。
これは上流DSHそのものや生成物ではなく、owned sessionの終了を待つJS実装である。

**この表の非対象**: HTML内inline script（Rustの[serve UI](<../src/ui.html>)・[setup UI](<../src/setup.html>)も含む）、
PowerShell/shell/Python、HTML/CSS/画像等、上流DSH配布物・インストール済み依存、生成build資産。
HTML内scriptとPS/sh/pyには実行責務が残り得るが、本表のJS拡張子台帳とは別に調べる。
上流・生成物をRustDSH自身の残存JSや削減成果へ足さない。

### 再計測

同じSHAのcleanなソースで、以下をrootから実行する（GitとPython 3の標準libraryのみ）。
追跡パス一覧は `git ls-files -z`、各領域・除外区分、Rust各ファイルまで再現できる。
異なるSHAやソースの未commit変更があれば新しいsnapshotとして扱う。

```sh
python3 - <<'PY'
from collections import Counter
from pathlib import Path, PurePosixPath
import re, subprocess

print('SHA', subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip())
paths = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')[:-1]
exts = {'.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'}
aux = re.compile(
    r'(^|/)(tests?|__tests__|fixtures?|bench|benches|benchmarks?)(/|$)'
    r'|(^|/)(bench-[^/]*|[^/]*(?:\.(?:test|spec)\.|fixture|benchmark)[^/]*)$', re.I)
def lines(p):
    b = Path(p).read_bytes()
    return b.count(b'\n') + bool(b and not b.endswith(b'\n'))
def bucket(p):
    if p.startswith(('docs/', 'media/')):
        return 'evidence-media'
    return 'test-fixture-bench' if aux.search(p) else 'inventory'
def report(label, selected):
    print(label, len(selected), sum(map(lines, selected)))
js = [p for p in paths if PurePosixPath(p).suffix in exts]
report('JS total', js)
print('extensions', dict(sorted(Counter(PurePosixPath(p).suffix for p in js).items())))
for k in ['inventory', 'test-fixture-bench', 'evidence-media']:
    report(k, [p for p in js if bucket(p) == k])
for area in sorted({p.split('/')[0] for p in js}):
    group = [p for p in js if p.split('/')[0] == area]
    report(area + ' total', group)
    report(area + ' inventory', [p for p in group if bucket(p) == 'inventory'])
rs = [p for p in paths if p.startswith('src/') and p.endswith('.rs')]
report('Rust src including inline tests', rs)
for p in rs:
    report(p, [p])
PY
```

### Rust srcの全数（45 files / 55,726物理lines）

以下は責務分類とは独立したソース台帳。テスト部分を差し引いたproduction SLOCではない。

| ソース | lines | ソース | lines |
| --- | ---: | --- | ---: |
| [answer_applications.rs](<../src/answer_applications.rs>) | 2,634 | [auth.rs](<../src/auth.rs>) | 2,890 |
| [auth_sharing.rs](<../src/auth_sharing.rs>) | 241 | [budget_admission.rs](<../src/budget_admission.rs>) | 2,648 |
| [compact.rs](<../src/compact.rs>) | 510 | [compute.rs](<../src/compute.rs>) | 475 |
| [context.rs](<../src/context.rs>) | 4,735 | [context_hook.rs](<../src/context_hook.rs>) | 643 |
| [cost_ledger.rs](<../src/cost_ledger.rs>) | 2,321 | [deps.rs](<../src/deps.rs>) | 3,003 |
| [desktop.rs](<../src/desktop.rs>) | 1,652 | [distro.rs](<../src/distro.rs>) | 197 |
| [dsh_args.rs](<../src/dsh_args.rs>) | 331 | [executable.rs](<../src/executable.rs>) | 34 |
| [file_lock.rs](<../src/file_lock.rs>) | 780 | [file_security.rs](<../src/file_security.rs>) | 783 |
| [guard.rs](<../src/guard.rs>) | 966 | [inspect.rs](<../src/inspect.rs>) | 1,865 |
| [instruction_queue.rs](<../src/instruction_queue.rs>) | 1,958 | [js_json.rs](<../src/js_json.rs>) | 153 |
| [local_http.rs](<../src/local_http.rs>) | 436 | [locale.rs](<../src/locale.rs>) | 539 |
| [locale_test.rs](<../src/locale_test.rs>) | 204 | [main.rs](<../src/main.rs>) | 4,210 |
| [models.rs](<../src/models.rs>) | 2,727 | [opencode_header.rs](<../src/opencode_header.rs>) | 372 |
| [passthrough.rs](<../src/passthrough.rs>) | 1,010 | [providers.rs](<../src/providers.rs>) | 4,196 |
| [question_contracts.rs](<../src/question_contracts.rs>) | 1,835 | [rdsh_config.rs](<../src/rdsh_config.rs>) | 2,234 |
| [search.rs](<../src/search.rs>) | 479 | [serial_proxy.rs](<../src/serial_proxy.rs>) | 1,152 |
| [serve.rs](<../src/serve.rs>) | 307 | [setup_web.rs](<../src/setup_web.rs>) | 309 |
| [shutdown.rs](<../src/shutdown.rs>) | 70 | [slim.rs](<../src/slim.rs>) | 160 |
| [subagent_plan.rs](<../src/subagent_plan.rs>) | 1,599 | [task_outcomes.rs](<../src/task_outcomes.rs>) | 1,010 |
| [token_handoff.rs](<../src/token_handoff.rs>) | 279 | [tokens.rs](<../src/tokens.rs>) | 361 |
| [tool_security.rs](<../src/tool_security.rs>) | 501 | [update_auto.rs](<../src/update_auto.rs>) | 472 |
| [websearch.rs](<../src/websearch.rs>) | 793 | [worker_git.rs](<../src/worker_git.rs>) | 1,113 |
| [worker_scopes.rs](<../src/worker_scopes.rs>) | 539 | — | — |

## 責務・接続・残存の台帳

これは主要な移行境界の分類であり、218件すべての意味監査ではない。
CLI入口は [Rust dispatch](<../src/main.rs>) と [Dashboard bridge](<../dashboard/cli.mjs#L339-L489>) を照合した。
説明コメントに古い「未移植」「削除済み」があっても、実際のimport/callを優先する。
例えば [answer側header](<../src/answer_applications.rs#L26-L48>) の「instruction queue未移植」は現存するRust moduleと一致しない。
同headerのclock/生成IDの差もあるため、apply全体の無条件byte一致とはしない。
[契約bridge試験](<../dashboard/test/rust-contracts-bridge.test.mjs#L32-L74>) の引数・exit転送確認はWindowsではskipされる。

| 境界 | Rustにある責務 / 接続状態 | 残るJS責務・根拠 / テスト所在 |
| --- | --- | --- |
| subagent plan（旧8項目） | [deterministic planner](<../src/subagent_plan.rs#L1-L13>) は実装・旧CLI接続あり。planだけでagentを起動しない | [CLI転送](<../dashboard/cli.mjs#L442-L454>) は引数・終了statusのadapter。[Rust契約](<../tests/subagents_cli.rs#L1-L43>) / [JS bridge試験](<../dashboard/test/subagent-bridge.test.mjs>)。optimizerの実行制御とは別物 |
| serial proxy（旧8項目） | [HTTP queue/stream処理](<../src/serial_proxy.rs>) のnative実装あり | Dashboard全体のHTTP移行ではない。[既存仕様](<SERIAL-PROXY.md>) / [integration test](<../tests/serial_proxy.rs>) |
| task outcomes（旧8項目） | [報告・固定milestone criteria](<../src/task_outcomes.rs#L1-L25>) のpure CLIあり | [state import/mutation](<../dashboard/state.mjs>) とMCP schemaのJS実装は残る。doneは報告で受入証明ではない。[CLI契約](<../tests/task_outcomes_cli.rs#L1-L60>) |
| worker scope（旧8項目） | [宣言検証・batch policy](<../src/worker_scopes.rs>) あり | [JS側](<../dashboard/worker-scopes.mjs>) はnative能力確認・fallbackとpath helperも持つため薄いadapterだけとはしない。DSHのruntime権限とは別。[試験](<../tests/worker_scopes.rs>) |
| cost ledger（旧8項目） | [scope/report/validate/public/schema](<../src/cost_ledger.rs#L1-L26>) あり。pure CLIはprivate request file経由で接続 | [JS ledger](<../dashboard/cost-ledger.mjs>) はstate/MCP/budget依存に残る。報告値と請求実績を混同しない。[CLI契約](<../tests/cost_ledger_cli.rs>) |
| context engine（旧8項目） | [retrieval/packing/verifier](<../src/context.rs#L1-L17>) と [hook設定](<../src/context_hook.rs#L1-L10>) あり | native context生成とDSHが実際にhookを読んだことは別。[設定・境界](<ARCHITECTURE.md>)。本台帳ではmodel/runtime注入を再実証していない |
| budget admission（旧8項目） | [予約・精算・replay検証](<../src/budget_admission.rs#L1-L25>) のpure CLIあり | [JS admission](<../dashboard/budget-admission.mjs>) とstate/budget serverは残る。provider呼出や自動解放をRust移行済みとしない。[CLI契約](<../tests/budget_admission_cli.rs>) |
| worker Git（旧8項目） | [観測・worktree操作](<../src/worker_git.rs#L45-L99>) と [native request](<../dashboard/worker-git.mjs#L181-L288>) 接続あり | [legacy fallback](<../dashboard/worker-git.mjs#L325-L338>) とworkspace orchestrationはJSに残る。native存在だけで全Git処理削除済みとはしない。[試験](<../tests/worker_git_cli.rs>) |
| question contracts（追加） | [typed revision/fingerprint/validity](<../src/question_contracts.rs#L1-L21>) のpure CLI・旧CLI bridgeあり | [state](<../dashboard/state.mjs>) はJS契約を直接呼ぶ。承認cardの保存は実行許可発行ではない。[CLI契約](<../tests/question_contracts_cli.rs>) |
| answer applications（追加） | [返信のclaim/ack/phase/projection](<../src/answer_applications.rs#L1-L52>) のpure CLI・旧CLI bridgeあり | [state reply mutation](<../dashboard/state.mjs#L451-L520>) はregister/ackをJSで処理。[CLI契約](<../tests/answer_applications_cli.rs>)。Rust内にもpartial instruction helperが残り、共有化済みではない |
| instruction queue（追加） | [validate/context/submit/resolve/control + JSONL serve](<../src/instruction_queue.rs>) あり | [server](<../dashboard/server.mjs#L285-L299>) は `RDSH_DASHBOARD_RUST_INSTRUCTION_QUEUE=1` のopt-in（または明示worker注入）。[state](<../dashboard/state.mjs#L451-L520>) のsubmit/resolve/controlだけworker候補で、413はJS fallback、commitはJS。[Rust試験](<../tests/instruction_queue_cli.rs>) / [worker試験](<../dashboard/test/instruction-queue-worker.test.mjs>)。既定live経路を全面Rustとしない |
| local HTTP / token handoff（追加） | [framing/Host/Origin/token/上限](<../src/local_http.rs>) と [保護ファイル作成・drop cleanup](<../src/token_handoff.rs>) あり | callerは [serve](<../src/serve.rs#L19-L40>) / [setup web](<../src/setup_web.rs#L12-L27>)。Node Dashboard serverを置換していない。[HTTP inline test](<../src/local_http.rs#L357-L435>) / [handoff inline test](<../src/token_handoff.rs#L243-L279>) |
| compute（追加） | [bounded stdio compute](<../src/compute.rs>) あり | [plugin bridge](<../plugins/rdsh-compute/index.js#L1-L70>) はopt-in、JS fallbackあり。pure string処理の境界であり、DSH本体のRust化ではない |

### 残存JSを「ホスト要求」と「移すべき責務」に分ける

- **薄いhost adapterとして残す境界**: [subagent登録](<../plugins/rdsh-subagent-optimizer/index.js>) の
  `ctx.effect` / provider登録・native parent policy snapshot、[headless cleanup登録](<../scripts/headless-runtime/runtime/plugins/rdsh-session-cleanup/index.js>) の
  runtime cleanup APIなど、現在のDSH JSホストとの接点。JS APIをRust関数名で置換しただけでは使えない。
  ここでhostのnative APIと呼ぶものは、RustDSHへ移植済みという意味ではない。
- **adapterと呼んで隠さない残存policy/runtime**: [optimizer](<../plugins/rdsh-subagent-optimizer/optimizer.js>) の
  並列数・queue上限・重複拒否・待機後context照合・dispose完了待ち、
  [answer guard](<../plugins/rdsh-answer-guard/index.js>) のsilent判定・nudge上限、
  [security isolation](<../security/tool-isolation.mjs>) のsnapshot/制限・拒否条件、
  [headless cleanup本体](<../scripts/headless-runtime/runtime/plugins/rdsh-session-cleanup/cleanup.mjs>) のowned集合・pending待機・失敗集約。
  これらは実行中の状態・安全判断であり、ホスト登録だけの薄いadapterではない。
  [optimizer仕様](<../plugins/rdsh-subagent-optimizer/README.md>) の対応版や権限維持を保つ必要がある。
- **Node側に残る大きな境界**: [server](<../dashboard/server.mjs>) は認証・HTTP/MCP・各store統合、
  [CLI](<../dashboard/cli.mjs>) は多数のorchestration、[process scope](<../dashboard/process-scope.mjs>) は
  所有権・子process・Docker/OS制御を持つ。Rust worker-scopeの宣言検証とは別責務。
  Dashboardの状態永続化・lock・復旧もまだJSであり、Node常駐不要とは主張しない。
- **browser/UIとbuild補助**: DOM/event描画とhost SDK接続は、policy抽出の可否と別に扱う。
  JS系全数に含まれる型宣言・制作補助まで「未移植runtime」とは数えない。
  上流のagent loop/profile bootは [既存architecture](<ARCHITECTURE.md#big-picture>) の委譲境界で、新protocolや全rewriteを本台帳で設計しない。

## 次の最小スライス候補（1件、実装は別変更）

### `backup inspect` のread-only native化

独立CLIの未移植候補は残っている。
[現入口](<../dashboard/cli.mjs#L1096-L1123>) の `backup inspect --archive-file` は、project/serverを使う他のbackup操作と分岐し、
[readBackupJson → backupInspection](<../dashboard/backup-files.mjs>) をローカルで実行している。
このSHAの [Rust command一覧](<../src/main.rs#L97-L102>) に当該操作はなく、
旧8項目・追加native CLIの再実装ではない。
ただし現inspectも [共通locale読込](<../dashboard/cli.mjs#L572-L585>) を通るため、設定非依存とは呼ばない。

- **狙い・最小範囲**: inspectの読取・検証・既存JSON投影だけをRustへ移し、旧入口は既存CLI bridge方式に薄くする。
  preview/export/restore/history、server認証、state migration、archive format/schema変更は含めない。
  「checksumを出すだけ」には縮めない。検証を抜くと既存の安全契約を失う。
- **依存と規模の境界**: [backup-files](<../dashboard/backup-files.mjs#L9-L38>) の通常ファイル・2 MiB・UTF-8・同一file identity確認と、
  [history validator](<../dashboard/history-backup.mjs#L348-L533>) が依存本体。
  validatorはselection正規化、canonical SHA256、record相互参照、reviewed/withheld text、authority拒否まで持つ。
  ファイル名から73行だけの移植と見積もらず、これらをinspectの一つの垂直スライスに含める。
  既存serde_json/sha2/file safety helperを照合し、新依存や新IPC protocolを前提にしない。
  JS validatorは他のbackup/state caller用に残す。
- **実装前に解く既知差分**: 正常値で上書きされる重複keyに `1e309` やlone surrogateが含まれても、Nodeはlast-wins後のarchiveを受理する。
  既存archiveを使う追加実験でもchecksum不変で受理したため、途中で拒否する通常のserde読込へ単純置換できない。
  JSのtrim/空白/URL判定とRust既定判定の差、既存Rust file helperのhard-link数・親symlink制限の差もある。
  全面native化はこれらの受理範囲・安全契約の一致が前提。JS互換境界を残す場合も、その残存を明示しNode不要完了とは呼ばない。
- **互換・安全受入**: [仕様](<HISTORY-BACKUP.md>) と [既存CLI/file試験](<../dashboard/test/history-backup.test.mjs#L597-L705>) をoracleにし、
  有効archiveのstdout JSON・field/key順・selection digest、無効入力のlocale診断/stderr/exitを旧CLIと比較する。
  canonical sort・JSON数値表現・UTF-16長/順序・UTC時刻、改竄checksum、再sealしたauthority/参照破損、
  未知field、review漏れ、秘密らしいtextも境界値を含め判定が一致すること。
  symlink/device/FIFO/dir、open前後の差替え、2 MiB境界、壊れたUTF-8/JSONでブロック・追跡・書換えしないこと。
  archiveは履歴に過ぎず、実行権限・session・受入成功を復元しない。
- **実装完了の条件**: Windows/macOS/Linuxの差分試験、既存backup側の回帰、同条件の起動時間・peak memory比較、
  SHA固定のCI/reviewとmerge後確認を分けて残す。現JS testのsymlink確認はWindowsでskipされるので追加確認が必要。
  今回は候補のcall pathを読んだだけで、Rust実装・性能改善・全OS動作を達成したとはしない。

instruction workerの既定有効化やDashboard全state移行は、この候補へ抱き合わせない。
既存nativeへの接続拡大は別途latency・永続互換・復旧の受入が必要である。

## 今回の検証範囲

母集団の再計測、ローカルリンク117件、差分whitespaceを確認した。
`RDSH_CHECK_BASE=upstream/main sh scripts/check.sh changed` の選択checkは成功したが、markdownlintはローカル未導入のためskip。
`npx --no-install markdownlint-cli2 docs/RUST-MIGRATION.md` でも利用できず、lint/CI成功は未確認である。
追加のNode実験では、既存archiveと重複keyへoverflow/lone surrogateを追加した計3条件すべてで、checksum不変の受理を確認した。
native実装の差分試験・evidence全体の再現・provider実行・全CI/全OS試験・起動/常駐メモリ測定は未実施。
前提修正や他PRのCI成功を #516 の受入へ読み替えない。
