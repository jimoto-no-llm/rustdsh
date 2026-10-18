# ローカルSwarm：実モデル10ジョブ

2026-10-18、`origin/main` の `2f89d31`（rdsh 0.9.0）を作業ブランチへ統合し、
WSL Ubuntuで Gas City → rdsh → DeepSeek Harness → DeepInfra の実行を確認した。
各ジョブが専用Gitリポジトリのコードを編集し、外部からもテストを実行した。

## 確認した結果

| 項目 | 結果 |
| --- | --- |
| 対象ジョブ | 10件すべて完了、異なるDSHセッション10個 |
| 成果物 | `calc.mjs` を実際に編集。受入テストは変更なし |
| 独立した受入確認 | 4 assertions × 10件、すべて成功 |
| DSHプロセスの最大同時稼働 | 10件。全10件が重なった時間65.883秒 |
| dispatchから受入確認まで | 112.858秒 |
| モデルのstep / ツール呼出し | 63 / 53 |
| 使用モデル | `Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo` |
| 対象10件のAPI費用見積もり | $0.0458345。usageからの推定で、請求明細ではない |
| 契約試験 | 8件成功（CLI 5、worker 3） |
| Rust検証 | release build、fmt、Clippy（警告0）成功 |
| 既存回帰試験 | `tests/regress.sh`: 107 checks成功、後続のpipe終了試験2件も成功 |

[集計証跡](../cloud/evidence/local-gascity-dsh-ten-20261018.json)には各セッション、
終了コード、成果物、テストのハッシュ、usage、計測上の制約を記録した。
同時稼働はプロセスの起動から終了までの重なりであり、モデル提供側のGPU同時推論数は測定していない。

終了処理では、Cityを動かしたままセッション記録を閉じた際、追加の `gc-11` が起動した。
City停止で中断され、DSHセッションヘッダーのみが残った。API送信の有無と追加料金は不明。
この1件は成功10件に含めず、記録も閉鎖した。最終確認は稼働worker 0、active session 0。
今後の終了順は**City停止が成功してからセッション記録を閉じる**。
この手順修正後の有料再試験は行っていない。

## 導入済み環境を使う

この端末のWSL Ubuntuに次の構成を配置済み。現在Cityは停止している。

```sh
export RDSH_LOCAL_ROOT="$HOME/.local/share/deepflow-swarm/runs/gascity-dsh-ten-20261018-main2f89d31"
repo=/mnt/c/Users/ryo-n/Codex_dev/rustdsh
sh "$repo/scripts/gascity-local.sh" status
```

各workerのタスクは `$RDSH_LOCAL_ROOT/city/work/worker-00/task.md` などにある。
次の実行前にタスクと対象コードを編集する。`runtime.json` にバイナリ、モデル、
資格情報ファイルのパスを設定しており、資格情報の値はリポジトリへ保存していない。
以下の `session new` は実APIを使用する。

```sh
sh "$repo/scripts/gascity-local.sh" start
sh "$repo/scripts/gascity-local.sh" session new worker-00 --no-attach --json
sh "$repo/scripts/gascity-local.sh" session list --json
```

結果は `$RDSH_LOCAL_ROOT/state/<GC_SESSION_ID>/result.json`、ログは同ディレクトリの
`stdout.jsonl` と `stderr.txt`、成果物は各workerのworkspaceに残る。
`code: 0` と `completed: true` の両方を確認し、成果物の受入テストも実行する。
`result.json` がない実行は終了不明として調べる。同じworkerへ作業中の別タスクを投入しない。

終了時は、まずCityを停止する。成功を確認してから、実際に返されたセッションIDを閉じる。

```sh
sh "$repo/scripts/gascity-local.sh" stop
sh "$repo/scripts/gascity-local.sh" status
sh "$repo/scripts/gascity-local.sh" session close <GC_SESSION_ID>
sh "$repo/scripts/gascity-local.sh" session list --json
```

## 最小構成と実装

- `scripts/gascity-dsh-worker.mjs`: Gas CityのProvider用アダプター。プロンプトが引数に
  なければ `gc prime` で取得し、DSH本体へ委譲する。Agent Loopは追加していない。
- セッションごとにHOME、DSH_HOME、TMPDIRを作成する。同一GC_SESSION_IDの再起動は
  排他的なディレクトリ作成で拒否し、既存結果を上書きしない。
- 環境変数はallowlistで構築する。指定したDeepInfraキーのみを渡し、収集した出力から
  そのキーを除去する。資格ファイルの内容をCLI引数へ渡さない。
- `scripts/gascity-local.sh`: 導入済み設定を読み、既存の `rdsh swarm` / `gc` を実行する。
  Gas City実行ファイルのSHA-256を照合する。独自Schedulerは持たない。
- workerは180秒でtimeout、5秒後に強制終了。強制停止によって結果が保存されない場合は
  不明扱いで、成功や自動再実行には変換しない。

今回必要だった追加実行物はGas City 1.5.0とjq 1.8.1。既存Node 24.15.0と
DeepSeek Harness 0.2.1-rc.2を利用し、rdshは統合ソースからビルドした。
Gas CityはMIT、DSHはMIT、jqはMITおよび同梱コンポーネントの表示条件を確認した。
コミット・配布物のハッシュは[upstream-lock](../cloud/upstream-lock.json)の
`local_runtime` と[第三者表示](../THIRD_PARTY_NOTICES.md)にある。
Cargo SBOMはrdsh 0.9.0へ更新。外部バイナリの推移的依存物すべての配布資格を示すものではない。

## 今回の範囲

単一ホスト、file Beads、subprocess Providerのone-shotセッションを検証した。
10個のworkspaceは別Gitリポジトリだが、OSユーザーは共通であり、コンテナ相当の
読み取り・通信隔離はない。信頼できる公開fixtureでの動作確認まで。

この最小Cityはcore packの自動スケジュールを除外しているため、`gc status` で
core未導入の警告が出る。タスクQueue、Dolt、Refinery、nudge、自動復旧、
Private Repoの境界試験、Kubernetesは今回の合格対象に含めていない。
Gas Town互換アダプターは変更していない。
