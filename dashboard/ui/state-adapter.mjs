// 既存dashboard状態 → rdsh-ui/1 envelope の読み取り専用橋渡し。
// 新規取得・推測・書き込みはしない。欠損は null のまま渡し描画側が未取得表示する。
const POLICY_STATUS = {
  within_budget: "予算内",
  warning: "soft到達：警告",
  blocked: "hard到達：新規受付停止",
  paused: "管理者が停止",
  unknown: "費用未確認：新規受付停止",
  period_closed: "対象期間外：新規受付停止",
  inactive: "制御終了",
};
function trunc(value, max) {
  if (typeof value !== "string") return "未取得";
  return value.length > max ? value.slice(0, max) + "\u2026" : value;
}
function known(value) {
  return value === null || value === undefined ? null : String(value);
}
function moneyAmount(policy) {
  if (!policy || typeof policy.currency !== "string") return null;
  const used = known(policy.effective);
  const hard = known(policy.hard_limit);
  if (used === null && hard === null) return null;
  return policy.currency + " " + (used === null ? "未取得" : used) +
    " / " + (hard === null ? "未取得" : hard);
}
function spentAmount(policy) {
  if (!policy || typeof policy.currency !== "string") return null;
  const spent = known(policy.spent);
  return spent === null ? null : policy.currency + " " + spent;
}
export function buildUiEnvelope(state) {
  const blocks = [];
  const book = state && typeof state === "object" ? state.budget_admission : null;
  const policies = book && Array.isArray(book.policies) ? book.policies : [];
  blocks.push({
    id: "ui-budget-policies",
    kind: "simple-table",
    title: "予算ポリシー",
    data: {
      columns: ["対象", "状態", "使用/上限", "報告済み"],
      rows: policies.map((p) => [
        p && typeof p.run_id === "string" && p.run_id ? "run " + p.run_id : "project全体",
        p && typeof p.status === "string" ? (POLICY_STATUS[p.status] || p.status) : null,
        moneyAmount(p),
        spentAmount(p),
      ]),
    },
    observation: { kind: "measured", source: "dashboard budget_admission" },
  });
  const decisions = book && Array.isArray(book.decisions) ? book.decisions : [];
  const points = [];
  let currency = null;
  for (const d of decisions) {
    if (!d || typeof d !== "object" || d.kind !== "usage") continue;
    const value = typeof d.amount === "string" ? Number(d.amount) : NaN;
    if (!Number.isFinite(value)) continue;
    if (currency === null && typeof d.currency === "string") currency = d.currency;
    if (typeof d.currency === "string" && d.currency !== currency) continue;
    points.push([points.length, value]);
  }
  // No recorded amounts means no chart: an empty series is not a zero line.
  if (points.length > 0)
    blocks.push({
      id: "ui-reported-cost-trend",
      kind: "chart.line",
      title: "報告額の推移（予算判断履歴）",
      data: { points, x_unit: "報告順", y_unit: currency || "-" },
      observation: { kind: "agent_reported", source: "dashboard budget decisions" },
    });
  const questions = state && Array.isArray(state.questions)
    ? state.questions.filter((q) => q && typeof q === "object" && q.answer === null)
    : [];
  for (const q of questions.slice(0, 10)) {
    blocks.push({
      id: "ui-question-" + trunc(typeof q.id === "string" ? q.id : "unknown", 80),
      kind: "agent.approval",
      title: "未回答の質問",
      data: {
        operation: trunc(typeof q.question === "string" ? q.question : "質問内容未取得", 120),
        target: typeof q.id === "string" ? q.id : "id未取得",
      },
    });
  }
  blocks.push({
    id: "ui-summary",
    kind: "text",
    data: {
      text: "予算ポリシー" + policies.length + "件 \u00b7 未回答の質問" + questions.length + "件 \u00b7 報告額の記録" + points.length + "件",
    },
    observation: { kind: "measured", source: "dashboard state" },
  });
  return {
    protocol: "rdsh-ui/1",
    session_id: "dashboard",
    message_id: "state-" + (state && state.revision !== undefined ? String(state.revision) : "unknown"),
    revision: state && typeof state.revision === "number" ? state.revision : 0,
    blocks,
  };
}
