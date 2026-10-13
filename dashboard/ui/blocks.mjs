// rdsh-ui/1 renderers. node(tag, text, className) keeps this DOM-agnostic.
// The renderer never executes model-supplied code: every kind is a fixed
// renderer and every value is written with textContent.
import {
  observationLabel, validateBlock, fallbackBlock, actionHandling, normalizeBlock,
} from "./registry.mjs";

const TONE_BY_STATUS = { pass: "ok", fail: "danger", hold: "warn" };
const LABEL_BY_STATUS = { pass: "成功", fail: "失敗", hold: "保留" };
const OBSERVATION_KINDS = ["measured", "agent_reported", "estimated", "unavailable"];

function observationBadge(node, block) {
  const observation = block.observation;
  const kind = observation && OBSERVATION_KINDS.includes(observation.kind)
    ? observation.kind : "unavailable";
  const badge = node("span", "観測 " + observationLabel(observation),
    "provenance-badge " + kind);
  badge.setAttribute("title", "観測の種類");
  return badge;
}
function observationDetail(node, block) {
  const observation = block.observation;
  if (!observation) return null;
  const parts = [];
  if (typeof observation.source === "string" && observation.source)
    parts.push("出所: " + observation.source);
  if (typeof observation.observed_at === "string" && observation.observed_at)
    parts.push(observation.observed_at);
  if (parts.length === 0) return null;
  return node("span", parts.join(" ・ "), "ui-observation-detail");
}
function observationLine(node, block) {
  // The kind already shows in the header chip; this line only carries the
  // source and time, so an undeclared observation adds no duplicate text.
  const detail = observationDetail(node, block);
  if (!detail) return null;
  const line = node("p", undefined, "ui-observation");
  line.append(detail);
  return line;
}
function missing(node, text) {
  return node("p", text + "は未取得です。0にはしません。", "caption");
}
function textOf(value) {
  return value === null || value === undefined || value === "" ? "未取得" : String(value);
}
function fieldsFor(node, blockId) {
  if (!node._fields || typeof node._fields !== "object")
    node._fields = Object.create(null);
  if (!Object.hasOwn(node._fields, blockId))
    node._fields[blockId] = Object.create(null);
  return node._fields[blockId];
}
function submitValue(block, node) {
  if (block.kind === "form") {
    const values = {};
    const fields = node._fields && node._fields[block.id];
    for (const field of block.data.fields) {
      const typed = fields ? fields[field.id] : undefined;
      values[field.id] = typeof typed === "string" ? typed.slice(0, 4000) : "";
    }
    return values;
  }
  if (block.kind === "choice") {
    const picked = node._choices ? node._choices[block.id] : null;
    return picked ? { choice_id: picked } : null;
  }
  return null;
}
function actionRow(node, block, emit) {
  const actions = Array.isArray(block.actions) ? block.actions : [];
  if (actions.length === 0) return null;
  const row = node("div", undefined, "ui-actions");
  let note = null;
  for (const action of actions) {
    const handling = actionHandling(action.kind);
    const pressed = node("button", action.label || action.id);
    pressed.setAttribute("data-action-id", String(action.id));
    pressed.setAttribute("data-action-kind", String(action.kind));
    pressed.setAttribute("data-block-id", String(block.id));
    if (handling === "client") {
      row.append(pressed);
      continue;
    }
    if (typeof emit === "function") {
      pressed.addEventListener("click", () => {
        const value = submitValue(block, node);
        if (block.kind !== "choice" && block.kind !== "form") emit(action, block, null);
        else if (value) emit(action, block, value);
        else {
          if (!note) {
            note = node("p", undefined, "detail");
            row.append(note);
          }
          note.textContent = "選択または入力の内容が未取得のため送信しません。";
        }
      });
      row.append(pressed);
    } else {
      pressed.disabled = true;
      row.append(pressed);
    }
    if (handling === "request")
      note = node("p", "この操作は要求として記録され、実行権限は発行されません。", "detail");
    else if (!note && handling === "session" && typeof emit !== "function")
      note = node("p", "この端末では未配線のため無効です。実行権限は発行されません。", "detail");
  }
  if (note) row.append(note);
  return row;
}
function renderText(container, node, block) {
  container.append(node("p", block.data.text, "ui-text"));
}
function renderHeading(container, node, block) {
  container.append(node("p", block.data.text, "ui-heading"));
}
function renderCaption(container, node, block) {
  container.append(node("p", block.data.text, "caption"));
}
function renderCode(container, node, block) {
  container.append(node("pre", block.data.code, "ui-code"));
  if (block.data.language) container.append(node("p", block.data.language, "caption"));
}
function renderCallout(container, node, block) {
  container.append(node("p", block.data.text, "callout " + (block.data.tone || "info")));
}
function renderBadge(container, node, block) {
  container.append(node("span", block.data.label, "badge " + (block.data.tone || "neutral")));
}
function renderKeyValue(container, node, block) {
  const list = node("dl", undefined, "key-value");
  for (const item of block.data.items) {
    list.append(node("dt", item.label));
    list.append(node("dd", textOf(item.value)));
  }
  container.append(list);
}
function renderTable(container, node, block) {
  const scroll = node("div", undefined, "ui-table-scroll");
  const table = node("table", undefined, "ui-table");
  const head = node("tr");
  for (const column of block.data.columns) head.append(node("th", column));
  table.append(head);
  for (const row of block.data.rows) {
    const line = node("tr");
    block.data.columns.forEach((column, index) => {
      const cell = node("td", textOf(row[index]));
      cell.setAttribute("data-label", column);
      line.append(cell);
    });
    table.append(line);
  }
  scroll.append(table);
  container.append(scroll);
}
function renderContainer(container, node, block, emit) {
  const panel = node("section", undefined, "ui-panel");
  if (block.title) panel.append(node("h4", block.title));
  for (const child of block.data.blocks) renderBlock(panel, child, node, emit);
  container.append(panel);
}
function renderChoice(container, node, block, emit) {
  container.append(node("p", block.data.prompt, "ui-prompt"));
  if (!node._choices || typeof node._choices !== "object")
    node._choices = Object.create(null);
  for (const choice of block.data.choices) {
    const label = node("label", undefined, "ui-choice");
    const input = node("input");
    input.setAttribute("type", "radio");
    input.setAttribute("name", block.id);
    input.setAttribute("value", choice.id);
    input.addEventListener("change", () => { node._choices[block.id] = choice.id; });
    label.append(input, node("span", choice.label));
    container.append(label);
    if (choice.detail) container.append(node("p", choice.detail, "caption"));
  }
  if (typeof emit !== "function")
    container.append(node("p", "未配線のため選択は送信されません。", "detail"));
}
function renderForm(container, node, block) {
  const fields = fieldsFor(node, block.id);
  const form = node("form", undefined, "ui-form");
  for (const field of block.data.fields) {
    const label = node("label", field.label);
    const type = field.type || "text";
    const input = type === "textarea" ? node("textarea") : node("input");
    if (type !== "textarea") input.setAttribute("type", type === "number" ? "number" : "text");
    input.setAttribute("name", field.id);
    if (typeof fields[field.id] !== "string") fields[field.id] = "";
    input.value = fields[field.id];
    input.addEventListener("input", (event) => {
      fields[field.id] = event && event.target ? event.target.value : input.value;
    });
    label.append(input);
    form.append(label);
  }
  container.append(form);
}
function renderDiff(container, node, block) {
  if (block.data.path) container.append(node("p", block.data.path, "caption"));
  const panes = node("div", undefined, "ui-diff-panes");
  for (const pane of [["変更前", block.data.before], ["変更後", block.data.after]]) {
    const box = node("section", undefined, "ui-diff-pane");
    box.append(node("h5", pane[0]));
    box.append(node("pre", pane[1]));
    panes.append(box);
  }
  container.append(panes);
}
// SVG shapes must live in the SVG namespace; a plain createElement would
// produce inert HTML elements that never draw.
function svgEl(node, tag, className) {
  const element = typeof node.svg === "function" ? node.svg(tag) : node(tag);
  if (className) element.setAttribute("class", String(className));
  return element;
}
function svgText(node, className, x, y, text) {
  const label = svgEl(node, "text", className);
  label.setAttribute("x", String(x));
  label.setAttribute("y", String(y));
  label.textContent = text;
  return label;
}
function renderTestResults(container, node, block) {
  const counts = { pass: 0, fail: 0, hold: 0 };
  for (const item of block.data.cases) counts[item.status] += 1;
  const order = ["pass", "fail", "hold"];
  const width = 420;
  const rowHeight = 28;
  const height = rowHeight * order.length + 6;
  const maximum = Math.max(counts.pass, counts.fail, counts.hold, 1);
  const svg = svgEl(node, "svg", "ui-chart");
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  // CSS cannot read the viewBox, so the ratio travels with the element.
  svg.setAttribute("style",
    "aspect-ratio: " + width + " / " + height + ";");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "テスト結果の内訳");
  order.forEach((status, index) => {
    const y = index * rowHeight + 6;
    svg.append(svgText(node, "ui-chart-label", 0, y + 12, LABEL_BY_STATUS[status]));
    const span = 62 + Math.round((counts[status] / maximum) * (width - 130));
    const bar = svgEl(node, "rect");
    bar.setAttribute("x", "54");
    bar.setAttribute("y", String(y));
    bar.setAttribute("width", String(span - 54));
    bar.setAttribute("height", "16");
    bar.setAttribute("rx", "4");
    bar.setAttribute("class", "bar-" + TONE_BY_STATUS[status]);
    svg.append(bar);
    svg.append(svgText(node, "ui-chart-value", span + 8, y + 12, String(counts[status])));
  });
  container.append(svg);
  const summary = node("div", undefined, "ui-test-summary");
  for (const status of order)
    summary.append(node("span", LABEL_BY_STATUS[status] + " " + counts[status],
      "badge " + TONE_BY_STATUS[status]));
  container.append(summary);
}
function renderLine(container, node, block) {
  const points = block.data.points;
  const width = 420;
  const height = 150;
  const pad = 16;
  let minX = points[0][0], maxX = points[0][0], minY = points[0][1], maxY = points[0][1];
  for (const point of points) {
    minX = Math.min(minX, point[0]); maxX = Math.max(maxX, point[0]);
    minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]);
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const place = (point) => {
    const x = pad + ((point[0] - minX) / spanX) * (width - pad * 2);
    const y = height - pad - ((point[1] - minY) / spanY) * (height - pad * 2);
    return x.toFixed(1) + "," + y.toFixed(1);
  };
  const svg = svgEl(node, "svg", "ui-chart");
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  // CSS cannot read the viewBox, so the ratio travels with the element.
  svg.setAttribute("style",
    "aspect-ratio: " + width + " / " + height + ";");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "時系列の推移");
  const axis = svgEl(node, "line");
  axis.setAttribute("x1", String(pad));
  axis.setAttribute("y1", String(height - pad));
  axis.setAttribute("x2", String(width - pad));
  axis.setAttribute("y2", String(height - pad));
  axis.setAttribute("class", "ui-chart-axis");
  svg.append(axis);
  const line = svgEl(node, "polyline");
  line.setAttribute("points", points.map(place).join(" "));
  svg.append(line);
  for (const point of points) {
    const xy = place(point).split(",");
    const dot = svgEl(node, "circle");
    dot.setAttribute("cx", xy[0]);
    dot.setAttribute("cy", xy[1]);
    dot.setAttribute("r", "3.5");
    svg.append(dot);
  }
  container.append(svg);
  container.append(node("p", "横: " + textOf(block.data.x_unit) + " ・ 縦: " + textOf(block.data.y_unit), "caption"));
}
function renderBar(container, node, block) {
  const bars = block.data.bars;
  const known = bars.filter((bar) => bar.value !== null);
  const maximum = known.length ? Math.max(...known.map((bar) => bar.value), 1) : 1;
  const width = 420;
  const height = 170;
  const pad = 18;
  const slot = (width - pad * 2) / bars.length;
  const svg = svgEl(node, "svg", "ui-chart");
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  // CSS cannot read the viewBox, so the ratio travels with the element.
  svg.setAttribute("style",
    "aspect-ratio: " + width + " / " + height + ";");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "カテゴリ別の値");
  const baseline = svgEl(node, "line");
  baseline.setAttribute("x1", String(pad));
  baseline.setAttribute("y1", String(height - pad));
  baseline.setAttribute("x2", String(width - pad));
  baseline.setAttribute("y2", String(height - pad));
  baseline.setAttribute("class", "ui-chart-axis");
  svg.append(baseline);
  bars.forEach((bar, index) => {
    const x = pad + index * slot + slot * 0.15;
    const barWidth = slot * 0.7;
    if (bar.value === null) {
      const placeholder = svgEl(node, "rect");
      placeholder.setAttribute("x", String(x));
      placeholder.setAttribute("y", String(height - pad - 14));
      placeholder.setAttribute("width", String(barWidth));
      placeholder.setAttribute("height", "14");
      placeholder.setAttribute("rx", "4");
      placeholder.setAttribute("class", "bar-neutral");
      placeholder.setAttribute("opacity", "0.5");
      svg.append(placeholder);
      svg.append(svgText(node, "ui-chart-label", x, height - pad + 16, bar.label + " 未取得"));
      return;
    }
    const barHeight = Math.max(3, Math.round((bar.value / maximum) * (height - pad * 2 - 26)));
    const rect = svgEl(node, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(height - pad - barHeight));
    rect.setAttribute("width", String(barWidth));
    rect.setAttribute("height", String(barHeight));
    rect.setAttribute("rx", "4");
    rect.setAttribute("class", "bar-" + (bar.tone || "info"));
    svg.append(rect);
    svg.append(svgText(node, "ui-chart-value", x, height - pad - barHeight - 6, String(bar.value)));
    svg.append(svgText(node, "ui-chart-label", x, height - pad + 16, bar.label));
  });
  container.append(svg);
  if (block.data.unit) container.append(node("p", "単位: " + block.data.unit, "caption"));
  const unknown = bars.length - known.length;
  if (unknown > 0)
    container.append(node("p", "値が未取得の棒が " + unknown + " 件あります。0としては描画しません。", "caption"));
}
function renderApproval(container, node, block) {
  container.append(node("p", "操作: " + block.data.operation +
    (block.data.target ? " ・ 対象: " + block.data.target : "") +
    (block.data.status ? " ・ 状態: " + block.data.status : ""), "ui-approval-facts"));
  if (block.data.reason) container.append(node("p", block.data.reason, "caption"));
  container.append(node("p", "UIだけでは承認できません。実行権限は発行されません。", "detail"));
}
const RENDERERS = {
  text: renderText, heading: renderHeading, caption: renderCaption, code: renderCode,
  callout: renderCallout, "status-badge": renderBadge, "key-value": renderKeyValue,
  "simple-table": renderTable, card: renderContainer, row: renderContainer,
  column: renderContainer, choice: renderChoice, form: renderForm,
  "dev.diff-split": renderDiff, "dev.test-results": renderTestResults,
  "chart.line": renderLine, "chart.bar": renderBar, "agent.approval": renderApproval,
};
export function renderBlock(container, block, node, emit) {
  // The server normalizes before storing. Rendering the same normalization
  // keeps the static demo and the live dashboard comparable.
  const normalized = normalizeBlock(block, 1);
  const checked = validateBlock(normalized);
  let effective = normalized;
  let fallback = false;
  if (!checked.ok) {
    effective = fallbackBlock(normalized, checked.errors.join(","));
    fallback = true;
  }
  const wrapper = node("section", undefined, "ui-block");
  wrapper.setAttribute("data-block-id", String(effective.id));
  wrapper.setAttribute("data-kind", String(effective.kind));
  const header = node("header", undefined, "ui-block-head");
  if (effective.title) header.append(node("h4", effective.title, "ui-block-title"));
  header.append(observationBadge(node, fallback ? effective : normalized));
  wrapper.append(header);
  const renderer = RENDERERS[effective.kind];
  if (renderer) renderer(wrapper, node, effective, emit);
  else if (effective.kind === "button") {
    wrapper.append(node("p", effective.data.label, "ui-button-label"));
  } else {
    effective = fallbackBlock(normalized, "unknown-kind");
    fallback = true;
    wrapper.append(node("p", effective.data.text, "ui-text"));
  }
  if (!fallback) {
    const row = actionRow(node, normalized, emit);
    if (row) wrapper.append(row);
  }
  const line = observationLine(node, fallback ? effective : normalized);
  if (line) wrapper.append(line);
  container.append(wrapper);
  return { fallback, kind: effective.kind, id: effective.id };
}
export function renderEnvelope(container, envelope, node, emit) {
  if (!envelope || typeof envelope !== "object" || envelope.protocol !== "rdsh-ui/1" ||
      !Array.isArray(envelope.blocks) || envelope.blocks.length === 0) {
    container.replaceChildren();
    const single = fallbackBlock(envelope, "bad-envelope");
    const wrapper = node("section", undefined, "ui-block");
    wrapper.append(node("p", single.data.text, "ui-text"));
    container.append(wrapper);
    return [{ fallback: true, kind: "text", id: single.id }];
  }
  container.replaceChildren();
  const results = [];
  for (const block of envelope.blocks.slice(0, 200))
    results.push(renderBlock(container, block, node, emit));
  return results;
}
export function renderSurface(container, surface, node, emit) {
  if (!surface || !Array.isArray(surface.blocks) || surface.blocks.length === 0) {
    if (node._surfaceDraftKey !== null) {
      node._surfaceDraftKey = null;
      node._fields = Object.create(null);
      node._choices = Object.create(null);
    }
    container.replaceChildren(
      node("p", "エージェントから提示されたUIはありません。提示されると、ここに操作できる画面が出ます。", "ui-empty"),
    );
    return [];
  }
  const draftKey = JSON.stringify([surface.surface_id || null, surface.revision ?? null]);
  if (node._surfaceDraftKey !== draftKey) {
    node._surfaceDraftKey = draftKey;
    node._fields = Object.create(null);
    node._choices = Object.create(null);
  }
  const surfaceRoot = node("div", undefined, "ui-surface");
  container.replaceChildren(surfaceRoot);
  return renderEnvelope(surfaceRoot, { protocol: "rdsh-ui/1", blocks: surface.blocks }, node, emit);
}
