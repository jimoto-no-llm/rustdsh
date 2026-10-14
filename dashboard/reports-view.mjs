import { text, formatDateTime, formatNumber } from "./locale.mjs";
import { metricView, observationView, ratioView } from "./observations.mjs";
import { eventIdentifier, eventTargetId } from "./annotation-identifiers.mjs";

const $ = (id) => document.getElementById(id);
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
const number = (value) =>
  value == null ? text("report.unavailable") : formatNumber(value);
const money = (value) => (value == null ? text("report.unavailable") : "$" + value.toFixed(2));
const ratio = (numerator, denominator) =>
  numerator == null || denominator == null || denominator === 0
    ? null
    : numerator / denominator;
const percentage = (value) =>
  value == null ? text("report.unavailable") : (value * 100).toFixed(1) + "%";
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
  value ? formatDateTime(value) : text("report.unreported");
const freshnessLabels = {
  fresh: "",
  stale: text("report.stale"),
  unknown: text("report.unknown"),
  unavailable: text("report.unavailable"),
};
let openObservations = new Set();
function provenance(view, label, format = String, id = "") {
  const element = node("div", undefined, "observation");
  element.dataset.freshness = view.freshness;
  element.dataset.kind = view.kind || "unknown";
  const heading = node("div", undefined, "observation-heading");
  if (label) heading.append(node("span", label + "："));
  heading.append(
    node("span", text("observation.kind." + (view.kind || "unknown")), "provenance-badge " + (view.kind || "unknown")),
  );
  if (view.freshness === "stale" || view.freshness === "unknown")
    heading.append(
      node("span", freshnessLabels[view.freshness], "provenance-badge " + view.freshness),
    );
  element.append(heading);
  if (view.value != null && !view.current)
    element.append(node("div", text("report.previous") + format(view.value), "sub"));
  const o = view.observation;
  element.append(node("div", text("report.observed") + date(o?.observed_at), "sub"));
  const details = node("details", undefined, "observation-details");
  details.dataset.observationId = id;
  details.open = openObservations.has(id);
  const summary = node("summary", text("report.sourceDetails"));
  summary.dataset.observationId = id;
  details.append(
    summary,
    node("div", text("report.source") + (o?.source || text("report.unreported"))),
    node("div", text("report.session") + (o?.session_id || text("report.unreported"))),
    node("div", text("report.reference") + (o?.reference || text("report.unreported"))),
    node("div", text("report.received") + date(o?.recorded_at)),
  );
  if (o?.observed_at && o.max_age_seconds) {
    const expiresAt = new Date(Date.parse(o.observed_at) + o.max_age_seconds * 1000);
    details.append(node("div", text("report.expires") + date(expiresAt.toISOString())));
  }
  element.append(details);
  return element;
}
function metricText(state, key, format, now) {
  const view = metricView(state, key, now);
  return view.current
    ? (view.kind === "estimated" ? text("report.estimated") : "") + format(view.value)
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
  if (result.reason === "incompatible") return text("report.incompatible");
  if (result.value !== null)
    return (metricView(state, a, now).kind === "estimated" ? text("report.estimated") : "") + percentage(result.value);
  const views = [metricView(state, a, now), metricView(state, b, now)];
  if (views.some((view) => view.freshness === "stale")) return text("report.stale");
  if (views.some((view) => view.freshness === "unknown")) return text("report.unknown");
  return text("report.unavailable");
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
        `${text("task.status."+status)} ${state.tasks.filter((task) => task.status === status).length}`,
    )
    .join(" · ");
  $("cards").replaceChildren(
    metricCard(state, now,
      text("report.total"),
      metric("total_cost_usd", money),
      text("report.separate") + metric("total_budget_usd", money),
      [[text("report.cost"), "total_cost_usd", money], [text("report.limit"), "total_budget_usd", money]],
      progress("total_cost_usd", "total_budget_usd"),
    ),
    metricCard(state, now,
      text("report.recent"),
      metric("session_cost_usd", money),
      text("report.sessionLimit", {session:state.metrics.session_id || text("report.noSession"), limit:metric("session_budget_usd",money)}),
      [[text("report.cost"), "session_cost_usd", money], [text("report.limit"), "session_budget_usd", money]],
      progress("session_cost_usd", "session_budget_usd"),
    ),
    metricCard(state, now,
      text("report.cacheRate"),
      rateText(state, "cached_input_tokens", "input_tokens", now),
      text("report.modelCalls", {count:metric("model_calls")}),
      [[text("report.cache"), "cached_input_tokens"], [text("report.input"), "input_tokens"], [text("report.calls"), "model_calls"]],
    ),
    metricCard(state, now,
      text("report.toolErrorRate"),
      rateText(state, "tool_errors", "tool_calls", now),
      text("report.toolCalls", {errors:metric("tool_errors"),calls:metric("tool_calls")}),
      [[text("report.errors"), "tool_errors"], [text("report.tools"), "tool_calls"]],
    ),
    metricCard(state, now,
      text("report.contextMisses"),
      metric("context_misses"),
      text("report.detectedBySource"),
      [[text("report.detected"), "context_misses"]],
      undefined,
      metricView(state, "context_misses", now).current && state.metrics.context_misses > 0,
    ),
    metricCard(state, now,
      text("report.autoContinue"),
      metric("auto_continues"),
      text("report.apiErrors", {refusals:metric("refusals"),errors:metric("api_errors")}),
      [[text("report.continued"), "auto_continues"], [text("report.refused"), "refusals"], [text("report.apiError"), "api_errors"]],
    ),
    card(text("report.currentDone"), `${currentDone} / ${state.tasks.length}`, text("report.breakdown") + counts),
    card(text("report.pending"), String(pending.length), text("report.answered", {count:answered})),
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
      const statusLabel = (view.kind === "estimated" ? text("report.estimated") : "") +
        text("task.status."+task.status) + (view.current ? "" : "（" + freshnessLabels[view.freshness] + "）");
      status.append(node(
        "span", statusLabel,
        "status " + (view.current && view.kind !== "estimated" ? task.status : ""),
      ));
      const title = node("td", task.title);
      title.append(provenance(view, undefined, String, "task:" + task.id));
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
        cell.dataset.label = ["ID", text("report.status"), text("report.title"), text("report.blocker")][index];
      });
      return tr;
    }),
  );
  if (!state.tasks.length)
    $("tasks").append(emptyRow(text("report.noTasks"), 4));
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
        element.id = eventTargetId(eventIdentifier(event));
        element.append(
          node("strong", event.title),
          node(
            "div",
            `${event.type} · ${formatDateTime(event.created_at)}`,
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
      node("div", text("report.noEvents"), "empty"),
    );
}
