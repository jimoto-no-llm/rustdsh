// Read-only diagnostic projection. A quiet process is not evidence of a hang.
export const quietOutputThresholdSeconds = 5 * 60;
export const browserPollGapThresholdMs = 5_000;

const timestampMs = (value) => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function processObservation(scope, observedAt) {
  const status = [
    "running",
    "stopping",
    "exit_confirmed",
    "unverifiable",
  ].includes(scope?.status)
    ? scope.status
    : "unknown";
  return {
    key: "managed_process_scope",
    label: "管理対象プロセス",
    status,
    value: status,
    source: "管理対象プロセス監視",
    observed_at: observedAt,
  };
}

function unavailable(key, label, source, observedAt) {
  return {
    key,
    label,
    status: "unavailable",
    value: null,
    source,
    observed_at: observedAt,
  };
}

export function diagnoseManagedRun({
  run_id = null,
  scope = null,
  process_exit = null,
  last_output_at = null,
  browser_poll_gap_ms = null,
  observed_at = new Date().toISOString(),
} = {}) {
  const observedMs = timestampMs(observed_at) ?? Date.now();
  const observed = new Date(observedMs).toISOString();
  const scopeObservation = processObservation(scope, observed);
  const outputMs = timestampMs(last_output_at);
  const outputAgeSeconds = outputMs === null
    ? null
    : Math.max(0, Math.floor((observedMs - outputMs) / 1000));
  const outputStatus = outputMs === null
    ? "not_observed"
    : outputAgeSeconds >= quietOutputThresholdSeconds
      ? "quiet"
      : "recent";
  const gapMs = Number.isFinite(browser_poll_gap_ms) && browser_poll_gap_ms >= 0
    ? Math.floor(browser_poll_gap_ms)
    : null;
  const browserStatus = gapMs === null
    ? "initial_observation"
    : gapMs >= browserPollGapThresholdMs
      ? "reconnected_after_gap"
      : "connected";

  let state = "unknown";
  let summary = "実行状態は未確認です";
  const guidance = [];
  if (!run_id) {
    state = "no_run";
    summary = "管理中の実行はありません";
  } else if (scopeObservation.status === "exit_confirmed") {
    state = "process_scope_exited";
    summary = "管理対象プロセスの終了を確認しました。作業結果は未確認です";
    guidance.push("Harness画面で最終状態と結果を確認してください。");
  } else if (process_exit) {
    state = scopeObservation.status === "running"
      ? "root_exited_descendants_running"
      : "root_process_exited";
    summary = scopeObservation.status === "running"
      ? "起動元プロセスの終了を観測しました。管理対象の子孫プロセスは実行中です"
      : "起動元プロセスの終了を観測しました。作業結果は未確認です";
    guidance.push("終了コードとHarness画面の最終状態を確認してください。");
  } else if (scopeObservation.status === "running") {
    if (outputStatus === "quiet") {
      state = "quiet_process";
      summary = `管理対象は実行中、${outputAgeSeconds}秒間標準出力・標準エラーなしです。停止とは判定しません`;
      guidance.push("長い正常処理や上流の待機もあり得ます。停止前にHarness画面のtask状態を確認してください。");
    } else {
      state = "process_running";
      summary = "管理対象プロセスは実行中です。Harnessのtask状態は未観測です";
      guidance.push("現在のtaskやrequestの状態はHarness画面で確認してください。");
    }
  } else if (scopeObservation.status === "stopping") {
    state = "stopping";
    summary = "停止を要求しました。終了確認を待っています";
  } else {
    summary = "管理対象の生存状態を確認できません。停止済みとは判定しません";
    guidance.push("監視接続を確認してください。状態が未確認のままならHarness画面を開き直してください。");
  }

  const output = {
    key: "managed_process_output",
    label: "管理プロセスの出力",
    status: outputStatus,
    value: last_output_at,
    source: "管理対象Harnessプロセスの標準出力・標準エラー到着時刻（内容は保存しない）",
    observed_at: outputMs === null ? observed : new Date(outputMs).toISOString(),
    age_seconds: outputAgeSeconds,
  };
  const rootExit = {
    key: "managed_root_exit",
    label: "起動元プロセスの終了",
    status: process_exit ? "observed" : "not_observed",
    value: process_exit
      ? {
          code: Number.isInteger(process_exit.code) ? process_exit.code : null,
          signal: typeof process_exit.signal === "string"
            ? process_exit.signal
            : null,
        }
      : null,
    source: "子プロセスの終了イベント",
    observed_at: timestampMs(process_exit?.observed_at) === null
      ? observed
      : new Date(timestampMs(process_exit.observed_at)).toISOString(),
  };
  const browser = {
    key: "dashboard_browser_poll",
    label: "認証済み画面ポーリング",
    status: browserStatus,
    value: gapMs,
    source: "人間認証済み /api/managed-process 要求の間隔",
    observed_at: observed,
  };

  if (browserStatus === "reconnected_after_gap")
    guidance.push("管理画面との接続間隔が空きました。これはHarnessの実行状態を示すものではありません。");
  guidance.push("この画面はAPI待ち、task heartbeat、CPU/GPU活動を取得しません。未取得は活動ゼロを意味しません。");

  return {
    schema: 1,
    run_id: typeof run_id === "string" ? run_id : null,
    state,
    summary,
    outcome: "not_assessed",
    stop_action: "manual_only",
    observed_at: observed,
    observations: [
      scopeObservation,
      rootExit,
      output,
      browser,
      unavailable(
        "task_heartbeat",
        "Harness task heartbeat",
        "現在のHarness連携はtaskのheartbeatを公開していません",
        observed,
      ),
      unavailable(
        "api_wait",
        "API待ち",
        "現在のHarness連携はproviderの待機状態を公開していません",
        observed,
      ),
      unavailable(
        "cpu_activity",
        "CPU活動",
        "現在のダッシュボードは収集していません",
        observed,
      ),
      unavailable(
        "gpu_activity",
        "GPU活動・資源待ち",
        "現在のダッシュボードは収集していません",
        observed,
      ),
    ],
    guidance,
  };
}
