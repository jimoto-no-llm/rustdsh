import { metricView, observationView, ratioView } from "./observations.mjs";

const $ = (id) => document.getElementById(id);
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
const number = (value) =>
  value == null ? "未取得" : value.toLocaleString("ja-JP");
const money = (value) => (value == null ? "未取得" : "$" + value.toFixed(2));
const ratio = (numerator, denominator) =>
  numerator == null || denominator == null || denominator === 0
    ? null
    : numerator / denominator;
const percentage = (value) =>
  value == null ? "未取得" : (value * 100).toFixed(1) + "%";
function card(label, value, detail, progress, warning = false) {
  const element = node("section", undefined, "card");
  element.append(
    node("div", label, "label"),
    node("div", value, "value" + (warning ? " warn" : "")),
    node("div", detail, "detail"),
  );
  if (progress != null) {
    const bar = node("div", undefined, "bar");
    const fill = node("span");
    fill.style.width = Math.min(100, Math.max(0, progress * 100)) + "%";
    bar.append(fill);
    element.append(bar);
  }
  return element;
}
function emptyRow(text, columns) {
  const tr = node("tr");
  const cell = node("td", text, "empty");
  cell.colSpan = columns;
  tr.append(cell);
  return tr;
}
const date = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "未申告";
const freshnessLabels = {
  fresh: "",
  stale: "古い情報",
  unknown: "鮮度未確認",
  unavailable: "未取得",
};
let openObservations = new Set();
function provenance(view, label, format = String, id = "") {
  const element = node("div", undefined, "observation");
  element.dataset.freshness = view.freshness;
  element.dataset.kind = view.kind || "unknown";
  const heading = node("div", undefined, "observation-heading");
  if (label) heading.append(node("span", label + "："));
  heading.append(
    node("span", view.label, "provenance-badge " + (view.kind || "unknown")),
  );
  if (view.freshness === "stale" || view.freshness === "unknown")
    heading.append(
      node("span", freshnessLabels[view.freshness], "provenance-badge " + view.freshness),
    );
  element.append(heading);
  if (view.value != null && !view.current)
    element.append(node("div", "前回の報告値：" + format(view.value), "sub"));
  const o = view.observation;
  element.append(node("div", "観測：" + date(o?.observed_at), "sub"));
  const details = node("details", undefined, "observation-details");
  details.dataset.observationId = id;
  details.open = openObservations.has(id);
  const summary = node("summary", "報告元・参照対象");
  summary.dataset.observationId = id;
  details.append(
    summary,
    node("div", "報告元：" + (o?.source || "未申告")),
    node("div", "報告session：" + (o?.session_id || "未申告")),
    node("div", "参照対象：" + (o?.reference || "未申告")),
    node("div", "受信：" + date(o?.recorded_at)),
  );
  if (o?.observed_at && o.max_age_seconds) {
    const expiresAt = new Date(Date.parse(o.observed_at) + o.max_age_seconds * 1000);
    details.append(node("div", "鮮度期限：" + date(expiresAt.toISOString())));
  }
  element.append(details);
  return element;
}
function metricText(state, key, format, now) {
  const view = metricView(state, key, now);
  return view.current
    ? (view.kind === "estimated" ? "推定 " : "") + format(view.value)
    : freshnessLabels[view.freshness];
}
function metricCard(state, now, label, value, detail, fields, progress, warning) {
  const element = card(label, value, detail, progress, warning);
  for (const [name, key, format = number] of fields)
    element.append(
      provenance(metricView(state, key, now), name, format, "metric:" + key),
    );
  return element;
}
function rateText(state, a, b, now) {
  const result = ratioView(state, a, b, now);
  if (result.reason === "incompatible") return "比較不可";
  if (result.value !== null)
    return (metricView(state, a, now).kind === "estimated" ? "推定 " : "") + percentage(result.value);
  const views = [metricView(state, a, now), metricView(state, b, now)];
  if (views.some((view) => view.freshness === "stale")) return "古い情報";
  if (views.some((view) => view.freshness === "unknown")) return "鮮度未確認";
  return "未取得";
}
export function renderReports(state, now = Date.now()) {
  openObservations = new Set(
    [...document.querySelectorAll("details.observation-details[open]")]
      .map((element) => element.dataset.observationId),
  );
  const activeDisclosure = document.activeElement?.dataset?.observationId;
  const metric = (key, format = number) => metricText(state, key, format, now);
  const progress = (a, b) => ratio(
    metricView(state, a, now).current ? state.metrics[a] : null,
    metricView(state, b, now).current ? state.metrics[b] : null,
  );
  const currentDone = state.tasks.filter((task) => {
    const view = observationView(task.status, task.observation, now);
    return task.status === "done" && view.current && view.kind !== "estimated";
  }).length;
  const pending = state.questions.filter((question) => question.answer === null &&
    (!state.question_contracts?.cards[question.id] || state.question_contracts.cards[question.id].status === "open"));
  const answered = state.questions.filter((question) => question.answer !== null).length;
  const counts = ["done", "doing", "todo", "blocked"]
    .map(
      (status) =>
        `${status} ${state.tasks.filter((task) => task.status === status).length}`,
    )
    .join(" · ");
  $("cards").replaceChildren(
    metricCard(state, now,
      "従来の累計報告（API換算）",
      metric("total_cost_usd", money),
      "台帳とは別の入力 · 上限 " + metric("total_budget_usd", money),
      [["費用", "total_cost_usd", money], ["上限", "total_budget_usd", money]],
      progress("total_cost_usd", "total_budget_usd"),
    ),
    metricCard(state, now,
      "直近のセッション",
      metric("session_cost_usd", money),
      `${state.metrics.session_id || "session未申告"}　上限 ${metric("session_budget_usd", money)}`,
      [["費用", "session_cost_usd", money], ["上限", "session_budget_usd", money]],
      progress("session_cost_usd", "session_budget_usd"),
    ),
    metricCard(state, now,
      "キャッシュ読み込み率",
      rateText(state, "cached_input_tokens", "input_tokens", now),
      `${metric("model_calls")} 回の呼び出し（入力トークン加重）`,
      [["キャッシュ", "cached_input_tokens"], ["入力", "input_tokens"], ["呼び出し", "model_calls"]],
    ),
    metricCard(state, now,
      "ツールのエラー率",
      rateText(state, "tool_errors", "tool_calls", now),
      `${metric("tool_errors")} / ${metric("tool_calls")} 件`,
      [["エラー", "tool_errors"], ["ツール", "tool_calls"]],
    ),
    metricCard(state, now,
      "文脈の読み落とし",
      metric("context_misses"),
      "報告元で検出した回数",
      [["検出数", "context_misses"]],
      undefined,
      metricView(state, "context_misses", now).current && state.metrics.context_misses > 0,
    ),
    metricCard(state, now,
      "自動続行",
      metric("auto_continues"),
      `拒否 ${metric("refusals")} · APIエラー ${metric("api_errors")}`,
      [["続行", "auto_continues"], ["拒否", "refusals"], ["APIエラー", "api_errors"]],
    ),
    card("鮮度内の完了報告", `${currentDone} / ${state.tasks.length}`, "全報告の内訳：" + counts),
    card("未回答の質問", String(pending.length), `回答済み ${answered}`),
  );
  $("task-milestones").textContent = [
    ...new Set(state.tasks.map((task) => task.milestone).filter(Boolean)),
  ].join(" / ");
  $("tasks").replaceChildren(
    ...state.tasks.map((task) => {
      // #57: 端末を替えても同じ行へ戻れる安定アンカー。
      const tr = node("tr");
      tr.id = "task-" + task.id;
      const status = node("td");
      const view = observationView(task.status, task.observation, now);
      const statusLabel = (view.kind === "estimated" ? "推定 " : "") +
        task.status + (view.current ? "" : "（" + freshnessLabels[view.freshness] + "）");
      status.append(node(
        "span", statusLabel,
        "status " + (view.current && view.kind !== "estimated" ? task.status : ""),
      ));
      const title = node("td", task.title);
      title.append(provenance(view, undefined, String, "task:" + task.id));
      const reference = task.decision_reference;
      if (reference) {
        const successorStatus = {
          current: "現行",
          replaced: "置換済み",
          withdrawn: "撤回",
          hold: "保留",
        }[reference.replacement_status];
        const label = reference.confirmation_required
          ? `要確認 · ${reference.reason} · 参照: ${reference.policy || reference.id}` +
            (reference.replacement_policy
              ? ` → 後継${successorStatus ? `（${successorStatus}）` : ""}: ${reference.replacement_policy}`
              : "")
          : `決定 ${reference.id} · ${reference.policy}`;
        title.append(
          node(
            "div",
            label,
            reference.confirmation_required ? "warn" : "sub",
          ),
        );
      }
      tr.append(
        node("td", task.id, "id"),
        status,
        title,
        node("td", task.blocker),
      );
      const taskLink = node("a", task.id);
      taskLink.href = "#task-" + encodeURIComponent(task.id);
      taskLink.dataset.taskId = task.id;
      tr.children[0].replaceChildren(taskLink);
      [...tr.children].forEach((cell, index) => {
        cell.dataset.label = ["ID", "状態", "題名", "ブロック要因"][index];
      });
      return tr;
    }),
  );
  if (!state.tasks.length)
    $("tasks").append(emptyRow("タスクはまだ登録されていません", 4));
  renderEvents(state, now);
  if (activeDisclosure)
    [...document.querySelectorAll("summary[data-observation-id]")]
      .find((summary) => summary.dataset.observationId === activeDisclosure)?.focus();
}
function renderEvents(state, now) {
  $("events").replaceChildren(
    ...state.events
      .slice(-30)
      .reverse()
      .map((event) => {
        const element = node("article", undefined, "event");
        element.append(
          node("strong", event.title),
          node(
            "div",
            `${event.type} · ${new Date(event.created_at).toLocaleString("ja-JP")}`,
            "sub",
          ),
        );
        if (event.detail) element.append(node("p", event.detail));
        if (event.artifact) element.append(node("code", event.artifact));
        element.append(provenance(
          observationView(event.title, event.observation, now),
          undefined, String, "event:" + event.sequence,
        ));
        return element;
      }),
  );
  if (!state.events.length)
    $("events").append(
      node("div", "進捗・成果物の報告はまだありません", "empty"),
    );
}
