# Cloud Swarm / Cloud Harness Runtime（初期実装）

この文書は2026-10-18の実装範囲を示す。`rdsh swarm` は固定した Gas City
`gc` 実行ファイルへの委譲入口、`rdsh cloud` は Agent Sandbox の
`SandboxClaim` を操作する独立した入口である。両者を同じジョブへ同時に
dispatch しない。Gas City の Agent Sandbox Runtime Provider 接続は未実装。

## 固定した調査対象と再利用判断

コミットと LICENSE は [`cloud/upstream-lock.json`](../cloud/upstream-lock.json)
に記録した。調査時の `rustdsh` は `3e109918`、`swarm-rdsh` は
`b9edd76c`。`swarm-rdsh` には既存の未コミット変更があり、変更していない。

| 既存実装 | 今回の判断 |
| --- | --- |
| `src/subagent_plan.rs`, `src/worker_scopes.rs`, `dashboard/worker-sandbox.mjs` | ローカルの計画・作業範囲・worktree の契約。クラウドのAttempt識別子と専用workspace設計に反映。クラスタ共有Leaseへ転用しない。 |
| `src/budget_admission.rs`, `src/cost_ledger.rs`, `dashboard/resource-admission.mjs`, `dashboard/gpu-leases.mjs` | ローカルの予算・資源制御。クラウドのCPU/メモリ/LLM料金の事前予約として扱わない。 |
| `docs/RUN-RECOVERY.md` | 不明な終了を成功とみなさない方針を継承。実際のタスク復旧はGas City側の責務。 |
| `swarm-rdsh/adapters/gt-dsh/` | Gas Town / Beads / DSH の実モデル1ジョブ接続契約。既存の公開fixture E2Eは手動復旧を含み、通常運用資格ではない。今回のコードはこのアダプターを変更しない。 |
| Gas City `internal/runtime/k8s/` | 既存ProviderはPodを直接作成し、tmuxのliveness、Nudge、Attach、Stop、Relaunch、Dolt環境投影を持つ。`SandboxClaim` を使うにはProvider変更が必要。 |
| Agent Sandbox `SandboxClaim` / `SandboxWarmPool` | Claim作成、Ready、WarmPool補充、Cold fallbackは上流Controllerへ委譲。Claimの`env`または`volumeClaimTemplates`はWarmPoolを迂回する。 |
| Kueue | 既存のQueue・Admissionを利用する予定。SandboxClaimのKueue連携は今回未実装であり、Claim作成をKueue承認済みと見なさない。 |

## 使い方

### Gas City委譲

`gc` は [`cloud/upstream-lock.json`](../cloud/upstream-lock.json) にある
コミットから別途ビルドし、実行ファイルのSHA-256を計測する。

```sh
rdsh swarm --gc-binary /opt/gascity/bin/gc --gc-sha256 <64桁のSHA256> \
  --city /srv/my-city doctor
rdsh swarm --gc-binary /opt/gascity/bin/gc --gc-sha256 <64桁のSHA256> \
  --city /srv/my-city init
rdsh swarm --gc-binary /opt/gascity/bin/gc --gc-sha256 <64桁のSHA256> \
  --city /srv/my-city start
rdsh swarm --gc-binary /opt/gascity/bin/gc --gc-sha256 <64桁のSHA256> \
  --city /srv/my-city status
rdsh swarm --gc-binary /opt/gascity/bin/gc --gc-sha256 <64桁のSHA256> \
  --city /srv/my-city stop
```

`RDSH_GASCITY_BIN`、`RDSH_GASCITY_SHA256`、`RDSH_GASCITY_CITY` も使える。
`rdsh` はコマンド引数をシェルへ渡さず、Gas Cityの終了コードを反映する。
Gas City以外のScheduler、task DB、Refineryは作らない。

### Agent Sandbox Claim

`rdsh cloud` は明示したときだけ起動する。制御側はPod内ServiceAccountの
tokenとCAを既定で読み、`RDSH_CLOUD_API_SERVER`、
`RDSH_CLOUD_TOKEN_FILE`、`RDSH_CLOUD_CA_FILE` でHTTPS接続先と
資格ファイルを明示できる。資格内容を引数・出力へ含めない。

```sh
rdsh cloud --namespace rdsh-cloud --pool rdsh-worker doctor
rdsh cloud --namespace rdsh-cloud --pool rdsh-worker capacity
rdsh cloud --namespace rdsh-cloud --pool rdsh-worker pool plan \
  --template rdsh-worker --replicas 1 > pool-plan.json
rdsh cloud --namespace rdsh-cloud --pool rdsh-worker pool apply \
  --plan-file pool-plan.json
rdsh cloud --namespace rdsh-cloud --pool rdsh-worker acquire \
  --request-file request.json > lease.json
rdsh cloud --namespace rdsh-cloud --pool rdsh-worker inspect \
  --lease-file lease.json
rdsh cloud --namespace rdsh-cloud --pool rdsh-worker exec \
  --lease-file lease.json -- /usr/local/bin/rdsh --version
rdsh cloud --namespace rdsh-cloud --pool rdsh-worker release \
  --lease-file lease.json
rdsh cloud --namespace rdsh-cloud --pool rdsh-worker reconcile \
  --lease-file lease.json
```

`request.json` の例。イメージはregistry digestまで固定し、Template内の
`worker` containerと完全一致させる。

```json
{
  "run_id": "run-1",
  "task_id": "task-1",
  "attempt_id": "attempt-1",
  "worker_id": "worker-1",
  "idempotency_key": "run-1/task-1/attempt-1",
  "container_name": "worker",
  "image_digest": "registry.example/rdsh-worker@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

AcquireはAttemptから決定的なClaim名を作り、同じAttemptの別key・別所有者を
409相当で拒否する。API timeoutは`phase: unknown`のLeaseを返し、Claimの
UIDを観測できるまで再払い出ししない。`inspect`の結果にある更新済み
`lease`を次の操作へ渡す。解放はUIDとresourceVersionを条件に
`shutdownPolicy: Retain`を設定し、上流ControllerへSandbox削除を依頼する。
ClaimはAttemptのtombstoneとして保持する。`release_requested: true`は
削除完了の証明ではない。`reconcile`で`released`を確認する。

Warm/Coldは上流Sandboxの`agents.x-k8s.io/launch-type`ラベルから読む。
ラベルを読めない場合は`unknown`のままにする。Claim固有の環境変数・PVCは
使用しないため、現在のTemplateはPodごとの`emptyDir`でHOMEとworkspaceを
分離する。資格情報、Git worktree、DSH Sessionの投入・成果物回収は未実装。

現在の`exec`は1回の`kubectl exec`であり、短周期ポーリングはしない。
`RDSH_CLOUD_KUBECONFIG` に絶対パスを指定し、そのAPI serverがClaim側と
同じことを確認する。出力は各stream最大1MiBで切り詰める。
持続接続、Streaming API、キャンセル時のリモート実行停止保証は未実装。
`exec`は結果JSONを出力し、子コマンドの終了コードをCLIへ返す。終了コードを
取得できない場合は非ゼロ終了する。通信失敗時にタスクを自動再実行しない。

## Workerと権限

[`cloud/worker/Dockerfile`](../cloud/worker/Dockerfile) はローカルの固定
rustdshソースと、固定コミットのDeepSeek Harnessをビルドする定義。
[`build.ps1`](../cloud/worker/build.ps1) はクリーンなGit HEADとdigest指定の
ベースイメージを要求する。Dockerデーモンがないため、今回のイメージビルドは
未検証。registryへpushしていない。配布前に実イメージdigestと完全なSBOMを
確定する。

[`cloud/k8s/sandbox-template.yaml`](../cloud/k8s/sandbox-template.yaml) は
非root、read-only root、PodごとのHOME・workspace・tmp、API token自動mount
無効、DNSのみのegressを設定する。モデル接続前に通信先を限定した追加ポリシー
と短命資格の注入方式を確定する。`rdsh cloud acquire` はTemplateのdigest、
資源limit、HOME/workspace分離などを検査する。Host Docker socketをmountしない。
Controller用の最小権限例は[`controller-rbac.yaml`](../cloud/k8s/controller-rbac.yaml)。
`kubectl exec`用には別途、対象namespaceへ限定した短命kubeconfigが必要。

## 負荷・受入の現在地

`rdsh cloud load-test --jobs 10000` はFake Backendに10,000個のAttemptを
順次確保して同時保持し、各Attemptの模擬実行結果を照合して全件解放する無課金試験。
`executed`、`released`、`remaining_sandboxes`で回収件数と解放後の残数を確認する。
FakeはコマンドやAgent Loopを起動せず、外部API・クラスタへ接続しない。
これは単一プロセスの制御データ試験で、
10,000 Pod、10,000 LLM call、分散Controllerの負荷試験ではない。
CIの`cargo test --locked`にFake/Kubernetes API契約試験が含まれる。

最小構成の検証は次のコマンドで行う。Kubernetes契約試験はローカルHTTPサーバー、
Gas City CLI契約試験はSHA-256で固定したNode実行ファイルを代役に使う。
実Gas City Provider接続や実SandboxのE2E合格を意味しない。

```sh
cargo test --locked --bin rdsh cloud::
cargo build --locked
node --test tests/cloud_cli.test.mjs
target/debug/rdsh cloud --backend fake load-test --jobs 10000
```

Windowsでは最後の実行ファイルを`target/debug/rdsh.exe`とする。
同時Acquire、解放済みAttemptの再払い出し拒否、古いUID・消失・Unknown状態での
解放拒否、別Workerの維持を無課金で試験する。今回の追加範囲はこのCLI・Backend
境界に限定し、Dashboard・常駐サービス・新しいSchedulerは追加しない。

実クラスタE2E、Gas City Provider接続、Kueue Admission、LLM/CPU/メモリ/費用
の階層上限、Controller再起動復旧、孤児検出、Dashboard表示、16/32/100並列、
10,000実Sandboxは未実装または未検証。`capacity`で`null`の項目は未計測を
意味し、ゼロ実績を意味しない。Pool applyは費用・容量承認フローができるまで
1 replica以下に制限する。未検証の実クラスタ結果を合格として扱わない。

## DeepInfra API負荷試験（2026-10-18）

[`scripts/deepinfra-load-test.mjs`](../scripts/deepinfra-load-test.mjs) で、
Git除外済みのローカルkey fileから資格情報を読み、固定した短文を
`meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo`へ送った。モデルの掲載単価は
[DeepInfra公式ページ](https://deepinfra.com/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo)
のStandard入力$0.02・出力$0.04／100万token（確認日2026-10-18）。
応答本文やAPI keyは記録しない。成功応答の`usage.estimated_cost`を合算し、
通信結果不明には固定promptと出力上限に基づく保守的な費用予約を加える。

本試験は最大64同時・15分・費用上限$0.0266で実施した。10,496要求中、
10,460件がHTTP成功・指定した`READY`と一致し、429は0件だった。
接続timeout 36件は実行・課金結果を確認できないため成功に含めない。
経過907秒、応答遅延p50/p95/p99は2,633/9,390/10,608ms。
成功応答が返した推定費用は$0.0039748、不明36件への費用予約は$0.0000576。
終了理由は15分の時間制限であり、費用上限到達ではない。結果の機械可読記録は
[`cloud/evidence/deepinfra-api-20261018.json`](../cloud/evidence/deepinfra-api-20261018.json)。
同じ小型モデルで実施した段階試験を合算すると、14,004要求中13,898件成功、
429が31件、通信結果不明が75件、成功応答からの推定費用は$0.00528124。

段階試験では64同時の512件は全件成功、128同時の1024件試行では通信結果不明38件、
256同時の1024件成功までに429が31件発生した。したがって今回の実績は
**10,460件の累積API成功**であり、10,000同時LLM request、10,000 Sandbox、
DSH agent loop、Gas City dispatchの実証ではない。比較可能な以前の大量API試験は
なく、これらの遅延を実装の効率不良と断定しない。

この試験は「成功件数10,000」を停止条件にしていたため、送信試行数は10,496件となり、
指定された最大10,000件を496件超過した。試験スクリプトに独立した
`--max-requests`（上限10,000）を追加し、成功しなかった要求があっても追加送信で
試行件数を超えないよう修正した。超過した事実は取り消せない。

同日、DeepInfraの[`GET /v1/me/rate_limit`](https://docs.deepinfra.com/api-reference/account/account-rate-limit)
をこのAPI keyで照会した結果、`rate_limit: 200`、`tpm_rate_limit: 1100000`だった。
[公式のRate Limits文書](https://docs.deepinfra.com/account/rate-limits)も既定値を
**モデルごとに200同時**と明記する。要求同時数10,000の再試行はCLIの事前検査で
拒否され、モデルAPIへ送った件数は0。口座上限ちょうどの200同時burstでは
client側peak in-flight 200、200要求すべて成功、429・通信不明は0、約4秒、
推定費用$0.000076だった。server側同時実行数を直接観測した値ではない。
このkey・単一モデルの現行上限下では10,000同時API成功は未達。
モデルごとに上限が適用されるため、複数モデルへの分散は別に試験する。

### 複数モデルへの分散試験（2026-10-18）

[`scripts/deepinfra-multimodel-test.mjs`](../scripts/deepinfra-multimodel-test.mjs)で、
DeepInfraのモデル一覧180件からChatタグと入出力料金のある96件を確認した。
60モデルを1件ずつ事前試験し、応答と費用情報を得られた59件から安価な50件を選択。
モデル別上限200件、合計送信上限10,000件、費用上限$0.0266を設定した。

事前試験60件の後、9,940件を一斉に送信した。結果は**送信10,000件、HTTP 200が
66件（うち一斉送信分7件）、429が1件、通信結果不明9,933件**。本文が非空の
応答は46件。クライアント側の最大待機数は9,940件だが、サーバー側で9,940件が
同時受理・実行された証拠ではない。これを10,000同時成功と記録しない。
結果は[`cloud/evidence/deepinfra-multimodel-20261018.json`](../cloud/evidence/deepinfra-multimodel-20261018.json)。

成功応答から判明した費用は$0.00055047。結果不明分には$0.02448097を予約した。
結果不明の要求が課金されたかは不明であり、この2値を実請求額として扱わない。
一斉送信時にローカルNodeプロセスのメモリ使用量は約2.4GBまで増えた。
この実行時は通信失敗の種別を保存しておらず、原因を特定できない。
試験後に種別の集計を追加したが、送信上限に達したため再試験はしていない。
この試験は直接Chat APIの負荷試験であり、SandboxやAgent Loopの試験ではない。
送信上限に達したため、自動再試行はしない。

試験後、同CLIにフォールバック制御を追加した。既定の同時送信上限は256件で、
モデルへ均等に送る。送信総数・費用・TPMの枠内に予備枠を取り、明確なHTTP 429は
事前に疎通を確認した別モデルへ切り替える。通信結果不明、5xx、費用情報欠落、
モデル不一致は新規送信を止め、同じ要求を自動再送しない。これは試験CLIの制御であり、
Gas Town / Gas City / DSH実ジョブの自動モデル切替ではない。
送信上限に達しているため、この変更後の実API試験は未実施。モック契約試験では
429時の切替、結果不明時の停止、上限維持を確認した。

### 10,000件一斉送信の再試験（2026-10-18）

直前に開始した256同時の試験は停止指示を受けて中断した。最終記録がなく、
中断までの送信数と費用は不明で、以下の10,000件とは別の試行である。

[`scripts/deepinfra-burst-10000.mjs`](../scripts/deepinfra-burst-10000.mjs)は、
50個の独立Nodeプロセスを同期起動し、50モデルへ各200件、合計10,000件を送る。
短い固定入力と`max_tokens: 1`を指定し、料金一覧からの事前見積もりは$0.02654674。
これは実請求額の上限保証ではない。モック試験でプロセス間の開始同期と件数を確認した。

[実測記録](../cloud/evidence/deepinfra-burst-10000-20261018.json)では、50プロセスすべてが
各200件の送信開始を報告した。ただし1プロセス（200件）が最終結果を返さず異常終了した。
結果を回収できた9,800件ではHTTP 200が6,688件、429が821件、通信結果不明が
2,291件。クライアント側最大待機数9,800件は、欠けたプロセスの時刻情報を含まない
**下限**であり、正確な最大同時数は不明。サーバー側10,000同時処理、
10,000件成功、Agent LoopやSandboxの実行は証明していない。

成功応答の費用合計は$0.024906217。通信結果不明分の予約額$0.006017481と
異常終了した200件の実請求額は未確定。成功分と予約額の合計は事前見積もりを超えるが、
予約額を実請求額とみなさない。追加のAPI要求や自動再送はしていない。

### 通信・異常終了対策（2026-10-18、実API再試験は未実施）

10,000件一斉送信CLIは、50プロセス×200要求と送信総数10,000の上限を維持する。
HTTP転送をNode標準の`https.request`へ変更し、接続待ち（既定30秒）と要求全体
（既定120秒、接続待ちを含む）に独立した期限を設定した。`--connect-timeout-ms`と
`--request-timeout-ms`で調整できる。TLS成功後にのみHTTP要求を書き込み、
送信前の失敗を`notSent`、送信後の応答欠落を`transportUnknown`として記録する。
応答本文は最大256KiB。429のヘッダーを受信できた場合は、本文が途中で切れても
拒否応答として保持する。転送段階・時刻・エラーコード・応答ステータス・
提供された場合のrequest ID・token使用量を記録し、鍵や応答本文は保存しない。
要求の自動再送・redirect追従は行わない。

結果ファイルの隣に`<out>.journal/`を作り、各ワーカーが送信意図と完了結果を
要求ごとに同期追記する。ワーカー異常終了時も保存済みの成功・費用を回収し、
開始済みで完了記録のない要求は`interruptedUnknown`として費用予約に含める。
ジャーナル破損時は未記録分も結果不明に残す。ファイルへの書き込みはプロセス終了に
備えるもので、電源断に対する永続化を保証しない。最終JSONは一時ファイルから置換する。
親プロセスを中断した場合は、同時に保存されたmanifestとjournalから、追加API呼び出し
なしで別の結果ファイルへ集計を復元できる。

```sh
node scripts/deepinfra-burst-10000.mjs --recover cloud/evidence/RUN.json --out cloud/evidence/RUN-recovered.json
```

復元は送信再開ではない。元のJSONとjournalを両方残すこと。`--recover`時は
ワーカー停止を仮定しないため、未記録の要求を未送信と断定しない。
過去のjournalを持たない試験結果から、失われた200件を復元することはできない。

ローカルの障害注入試験では接続前後のreset、接続期限・応答期限、429本文切断、
応答サイズ制限、実loopback socketの切断、ワーカー強制終了後の復元、
journal末尾破損を確認する。無課金の50プロセス×200要求モック試験では、
10,000件の開始・完了保存とクライアント側10,000同時待機を確認した。
CIにはLinux/Windows向けの同じ無課金試験を追加した。実DeepInfraでの切断率改善、
実TLS接続10,000本、前回のワーカー異常終了の根本原因は未検証・未特定。
接続リセットの発生源は前回の記録だけでは判定できず、期限延長で解消するとは扱わない。

[ローカル検証記録](../cloud/evidence/deepinfra-burst-recovery-offline-20261018.json)：
Node v24.15.0 / Windowsで関連19試験が成功（13.30秒）。10,000件モック部分は8.29秒で、
人工的な応答待ち5秒を含む。これを実APIの性能数値として扱わない。実API送信は0件。

### OpenRouterでの10,000超同時要求（2026-10-18）

[`cloud-api-burst.mjs`](../scripts/cloud-api-burst.mjs)を追加し、DeepInfraのTLS事前接続と
OpenRouterのHTTP/2多重送信に対応した。事前接続ではChat APIを呼ばず、全ワーカーの
接続確認後に同じ時刻で送信を開始する。HTTP/2は接続先の同時stream上限を確認し、
1接続当たり100要求以内とする。終了済み要求と開始要求が同じミリ秒の場合、
終了を先に数えて同時数を過大評価しない。

最初の混合構成（OpenRouter 8,000＋DeepInfra 4,000）はDeepInfraの接続準備が揃わず
送信前に中止した。Chat API要求は0件。その後OpenRouterのみへ切り替えた初回12,000件は、
実装が`models`に4候補を指定したため全件HTTP 400となった。1件の診断で上限3件の
エラーを確認して修正し、修正後の1件はHTTP 200・費用$0.000000639だった。
この失敗試行の直後に確認したアカウント使用額は試行前と同額だった。

ユーザーの単価引上げ指示に従い、試験予算を$0.50、OpenRouterのprovider単価上限を
入力$1・出力$3／100万tokenに設定した。32入力token＋1出力tokenと10%余裕による
12,000件の予約額は$0.462。これは実費の上限保証ではない。
[上流のprovider切替](https://openrouter.ai/docs/guides/routing/provider-selection)と
[モデルフォールバック](https://openrouter.ai/docs/guides/routing/model-fallbacks)を使用し、
クライアント側で結果不明の要求を再送しない。1つのAPI要求内で上流が行うモデル試行数は
クライアントの送信要求数とは別で、実測していない。

修正後の[実行記録](../cloud/evidence/openrouter-burst-12000-20261018-v2.json)と
[検証記録](../cloud/evidence/openrouter-burst-12000-20261018-v2-verification.json)：

| 項目 | 実測 |
| --- | ---: |
| 一斉送信 | 12,000要求、40プロセス、120 HTTP/2接続 |
| HTTP 200 / 重複しないgeneration ID | 各12,000 |
| 指定モデル・使用token・費用を確認した応答 | 11,622 |
| 上記11,622要求が同時に重なった時間 | 501ms |
| 送信済み要求の最大同時待機数 | 12,000 |
| 429 / 通信結果不明 / 回収失敗ワーカー | すべて0 |
| 費用情報欠落（成功確定数から除外） | 378 |
| 検証済み応答のうち本文非空 | 6,588 |
| 応答で判明した費用合計 | $0.01861928363 |
| アカウント使用額の増加（単発診断も含む） | $0.018619718 |

同時数は、準備済み接続へHTTP要求を書き込んだ時刻から、応答全体の受信完了までの
区間の重なり。11,622件について共通する区間はUTC 05:56:24.740〜05:56:25.241。
サーバー内部のGPU推論が同時に走っていた数は計測していない。Sandbox、DSH Agent Loop、
10,000件の実タスク完遂を実証した結果でもない。`max_tokens: 1`のため本文が空の応答もある。

費用情報が欠けた378件はCohereへルーティングされた応答だった。うち3件を
[generation metadata API](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation)
で照会したが404のため個別費用は未確定のまま残した。
公開証跡からキーのファイルパスと口座残高を除外する。API keyや応答本文は
証跡に保存していない。詳細journalはローカルで保持し、Git対象から除外する。

同じ構成の実行例（有料、既存の結果ファイルは上書きしない）：

```sh
node scripts/cloud-api-burst.mjs --deepinfra-key-file PATH --openrouter-key-file PATH --out cloud/evidence/NEW-RUN.json --run true --deepinfra-models 0 --per-model 300 --budget-usd 0.50 --max-input-price 1 --max-output-price 3
```

`--run true`を省略すると事前照会と計画保存だけを行う。現行CLIの一斉送信上限は12,000。
関連21試験を通過し、単価・フォールバック修正後は該当10試験を再実行して通過した。
CIにも無課金試験を登録したが、リモートCIは未実行。追加の実バーストは実施していない。
