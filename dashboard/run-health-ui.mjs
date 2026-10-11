const statusLabels = {
  running: "実行中",
  stopping: "停止要求中",
  exit_confirmed: "終了確認済み",
  unverifiable: "確認不能",
  unknown: "未確認",
  observed: "観測済み",
  not_observed: "未観測",
  recent: "直近に出力あり",
  quiet: "長時間出力なし",
  unavailable: "未取得",
  connected: "接続中",
  reconnected_after_gap: "間隔後に再接続",
  initial_observation: "初回観測",
};

function time(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return "時刻未確認";
  return new Date(value).toLocaleString("ja-JP", { hour12: false });
}

function detail(record) {
  switch (record.key) {
    case "managed_process_scope":
      return `観測 ${time(record.observed_at)} · 出所: ${record.source}`;
    case "managed_root_exit":
      return record.value
        ? `終了を観測 ${time(record.observed_at)} · code ${record.value.code ?? "不明"} · signal ${record.value.signal ?? "なし"}`
        : `終了イベントなし · 確認 ${time(record.observed_at)}`;
    case "managed_process_output":
      return record.value
        ? `最終出力 ${time(record.value)} · ${record.age_seconds}秒前 · 内容は保存していません`
        : `出力チャンクなし · 確認 ${time(record.observed_at)}`;
    case "dashboard_browser_poll":
      if (record.status === "connected")
        return `前回の認証済み確認から ${record.value}ms · ${time(record.observed_at)}`;
      if (record.status === "reconnected_after_gap")
        return `現在の確認は到達 · 前回から ${record.value}ms · ${time(record.observed_at)}`;
      return `間隔はまだ比較できません · ${time(record.observed_at)}`;
    default:
      return `観測 ${time(record.observed_at)} · 出所: ${record.source}`;
  }
}

export function renderManagedRunHealth(target, report, node) {
  const evidenceWasOpen =
    target.querySelector(".run-health-evidence")?.open ?? false;
  if (!report) {
    target.replaceChildren(
      node(
        "p",
        "監視に接続できません。管理対象の現在状態は未確認です。自動停止は行いません。",
        "sub",
      ),
    );
    return;
  }
  const summary = node("p", report.summary, "run-health-summary");
  summary.setAttribute("role", "status");
  summary.setAttribute("aria-live", "polite");
  const facts = node("dl", undefined, "run-health-facts");
  for (const record of report.observations || []) {
    const term = node("dt", record.label);
    const value = node(
      "dd",
      `${statusLabels[record.status] ?? "未確認"} · ${detail(record)}`,
    );
    facts.append(term, value);
  }
  const guidance = node("ul", undefined, "run-health-guidance");
  for (const item of report.guidance || []) guidance.append(node("li", item));
  const evidence = node("details", undefined, "run-health-evidence");
  evidence.open = evidenceWasOpen;
  evidence.append(
    node("summary", "観測元と取得できない情報"),
    facts,
    node(
      "p",
      "観測時刻はこの画面が確認した時刻です。未取得は活動なしを意味しません。",
      "sub",
    ),
    guidance,
  );
  target.replaceChildren(
    summary,
    node(
      "p",
      "作業結果は未評価 · この診断による自動停止はありません",
      "sub",
    ),
    evidence,
  );
}
