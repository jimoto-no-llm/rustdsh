import { buildInbox, buildAttentionHistory } from "./attention.mjs";

const byId = (id) => document.getElementById(id);
const kinds = { question: "未回答の質問", failure: "失敗の報告", dependency: "依存待ちの報告", blocked: "停止中 · 種類未報告" };
const impacts = { critical: "重大", high: "大", medium: "中", low: "小" };
const actions = { reported: "報告", updated: "報告を更新", resolved: "解消を報告", replaced: "原因を変更", reopened: "再発を報告", answered: "回答済み", cancelled: "取消し", expired: "期限切れ" };
let lastState;
let installed = false;

function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function time(value) {
  return value ? new Date(value).toLocaleString("ja-JP") : "未報告";
}

function metadata(item) {
  const list = element("dl", undefined, "attention-meta");
  for (const [label, value] of [
    ["期限", time(item.deadline)],
    ["影響", impacts[item.impact] || "未報告"],
    ["次の一手", item.next_action || "未報告"],
  ]) {
    list.append(element("dt", label), element("dd", value));
  }
  if (item.blocker) list.append(element("dt", "停止理由"), element("dd", item.blocker));
  return list;
}

function targetButton(item) {
  const button = element("button", `${item.source === "question" ? "質問" : "タスク"} ${item.id} へ`);
  button.type = "button";
  button.dataset.attentionLink = JSON.stringify([item.source, item.id]);
  button.dataset.attentionFocus = button.dataset.attentionLink;
  button.addEventListener("click", () => {
    const rows = byId(item.source === "question" ? "questions" : "tasks");
    const target = [...rows.children].find((row) => row.id === `${item.source}-${item.id}`);
    if (!target) return;
    for (let parent = target.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === "DETAILS") parent.open = true;
    target.scrollIntoView({ block: "center" });
    const input = item.source === "question" ? target.querySelector("textarea") : null;
    if (input) input.focus();
    else {
      target.tabIndex = -1;
      target.focus();
    }
  });
  return button;
}

function badges(items, questions) {
  const result = element("span", undefined, "attention-badges");
  const seen = new Set();
  for (const item of items) {
    const question = item.source === "question" ? questions.get(item.id) : null;
    const approval = question?.decision_kind
      ? question.decision_kind === "approval" : Boolean(question?.default_action);
    const label = question
      ? `${approval ? "承認依頼" : "相談"} · 緊急度 ${question.urgency}`
      : kinds[item.kind];
    if (seen.has(label)) continue;
    seen.add(label);
    result.append(element("span", label, question
      ? "kind" + (approval ? " kind-approval" : "") : "status"));
  }
  return result;
}

function summaryValue(label, value) {
  const field = element("span", undefined, "attention-summary-value");
  field.append(element("span", label, "sub"), element("span", value, "attention-preview"));
  return field;
}

export function renderAttention(state) {
  lastState = state;
  if (!installed) {
    byId("attention-sort").addEventListener("change", () => renderAttention(lastState));
    installed = true;
  }
  const list = byId("attention-list");
  const focused = list.contains(document.activeElement)
    ? document.activeElement.dataset.attentionFocus : null;
  const openGroups = new Set([...list.querySelectorAll("details[open]")]
    .map((details) => details.dataset.groupId));
  const questions = new Map(state.questions.map((question) => [question.id, {
    ...question, decision_kind: state.question_contracts?.cards[question.id]?.snapshot.decision.kind,
  }]));
  const inbox = buildInbox(state, byId("attention-sort").value);
  byId("attention-count").textContent = `${inbox.groups.length} 組 / ${inbox.itemCount} 件`;
  list.replaceChildren(...inbox.groups.map((group) => {
    const card = element("details", undefined, "attention-group");
    card.dataset.groupId = group.id;
    card.open = openGroups.has(group.id);
    const summary = element("summary");
    summary.dataset.attentionFocus = JSON.stringify(["group", group.id]);
    const overview = element("span", undefined, "attention-summary");
    const subject = element("span", undefined, "attention-subject");
    subject.append(badges(group.items, questions));
    subject.append(element("span", group.items[0].title +
      (group.items.length > 1 ? ` ほか${group.items.length - 1}件` : ""), "attention-title attention-preview"));
    if (group.cause_id) {
      subject.append(element("span", `原因: ${group.cause_id} · ${group.items.length}件`, "sub attention-preview"));
    }
    overview.append(subject,
      summaryValue(group.items.length > 1 ? "期限（最短）" : "期限", time(group.deadline)),
      summaryValue(group.items.length > 1 ? "影響（最大）" : "影響", impacts[group.impact] || "未報告"),
      summaryValue("次の一手", group.next_action || "未報告"));
    summary.append(overview);
    card.append(summary);
    const members = element("div", undefined, "attention-members");
    for (const item of group.items) {
      const member = element("section", undefined, "attention-member");
      member.append(badges([item], questions));
      member.append(element("h3", item.title));
      if (group.cause_id) member.append(element("p", `原因: ${group.cause_id}`, "sub"));
      member.append(metadata(item), targetButton(item));
      const question = item.source === "question" ? questions.get(item.id) : null;
      if (question?.default_action) member.append(element("p", `既定の行動（自動実行なし）: ${question.default_action}`, "sub"));
      members.append(member);
    }
    card.append(members);
    return card;
  }));
  if (!inbox.itemCount) list.append(element("p", "いま対応が必要な報告はありません。", "empty"));
  if (focused) {
    const target = [...list.querySelectorAll("[data-attention-focus]")]
      .find((item) => item.dataset.attentionFocus === focused);
    (target || byId("attention-sort")).focus();
  }

  const history = buildAttentionHistory(state);
  history.sort((a, b) => (b.recorded_at || "").localeCompare(a.recorded_at || "") ||
    (b.sequence || 0) - (a.sequence || 0) || a.id.localeCompare(b.id));
  const expanded = new Set([...byId("attention-history-list").querySelectorAll("details[open]")]
    .map((details) => details.dataset.historyKey));
  const focusedHistory = byId("attention-history-list").contains(document.activeElement)
    && document.activeElement.tagName === "SUMMARY"
    ? document.activeElement.parentElement.dataset.historyKey : null;
  byId("attention-history-count").textContent = String(history.length);
  byId("attention-history-list").replaceChildren(...history.map((entry) => {
    const item = element("article", undefined, "attention-history-entry");
    item.append(element("strong", `${entry.id} · ${entry.title}`));
    item.append(element("p", `${time(entry.recorded_at)} · ${entry.action === "answered" ? "回答済み" : actions[entry.action] || entry.action}`, "sub"));
    if (entry.attention.cause_id) item.append(element("p", `原因: ${entry.attention.cause_id}`, "sub"));
    item.append(metadata({ ...entry.attention, blocker: entry.blocker || entry.attention.blocker }));
    if (entry.previous_attention) {
      const previous = element("details");
      previous.dataset.historyKey = JSON.stringify([entry.id, entry.sequence]);
      previous.open = expanded.has(previous.dataset.historyKey);
      previous.append(element("summary", "変更前の報告"));
      if (entry.previous_attention.cause_id) previous.append(element("p", `原因: ${entry.previous_attention.cause_id}`, "sub"));
      previous.append(metadata({ ...entry.previous_attention, blocker: entry.previous_blocker || entry.previous_attention.blocker }));
      item.append(previous);
    }
    return item;
  }));
  if (!history.length) byId("attention-history-list").append(element("p", "履歴はまだありません。", "empty"));
  if (focusedHistory) {
    [...byId("attention-history-list").querySelectorAll("details")]
      .find((details) => details.dataset.historyKey === focusedHistory)
      ?.querySelector("summary").focus({ preventScroll: true });
  }
}
