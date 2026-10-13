// rdsh-ui/1 registry: kind allow-list, validators, action handling.
// Composition: card/row/column hold nested blocks, so an agent composes a
// screen from small parts instead of choosing from a fixed gallery.
export const PROTOCOL = "rdsh-ui/1";
export const MAX_BLOCKS = 200;
export const MAX_DEPTH = 3;
export const MAX_ACTIONS = 32;

export const BLOCK_KINDS = [
  "text", "heading", "caption", "code", "callout", "status-badge",
  "key-value", "simple-table", "card", "row", "column",
  "choice", "button", "form", "dev.diff-split", "dev.test-results",
  "chart.line", "chart.bar", "agent.approval",
];
// Kept for callers that asked for the first vertical slice by name.
export const PHASE1_KINDS = BLOCK_KINDS;

export const OBSERVATION_LABELS = Object.freeze({
  measured: "実測",
  agent_reported: "エージェント報告",
  estimated: "推定",
  unavailable: "未取得",
});
export const MISSING_LABEL = "未取得";

// client  : the browser completes it; nothing returns to the session.
// session : the choice returns to the same session. It grants no authority.
// request : recorded as a request only. The agent must run its own gated
//           flow; the UI never executes it.
export const ACTION_HANDLING = Object.freeze({
  copy: "client",
  expand: "client",
  submit_choice: "session",
  submit_form: "session",
  approve: "session",
  reject: "session",
  open_url: "session",
  request_tool: "request",
  request_approval: "request",
  interrupt: "request",
  apply_patch: "request",
  delete: "request",
  publish: "request",
  charge: "request",
});
export const ONE_SHOT_ACTIONS = Object.freeze([
  "submit_choice", "submit_form", "approve", "reject",
]);
const TONES = ["neutral", "info", "ok", "warn", "danger"];
const TEST_STATUS = ["pass", "fail", "hold"];

export function observationLabel(observation) {
  const label = observation ? OBSERVATION_LABELS[observation.kind] : undefined;
  return label === undefined ? MISSING_LABEL : label;
}
export function isKnownKind(kind) {
  return typeof kind === "string" && BLOCK_KINDS.includes(kind);
}
export function actionHandling(kind) {
  return typeof kind === "string" ? ACTION_HANDLING[kind] || null : null;
}
export function isClientAction(action) {
  return actionHandling(action && action.kind) === "client";
}
export function isSessionAction(action) {
  return actionHandling(action && action.kind) === "session";
}
export function isWiredActionKind(kind) {
  return actionHandling(kind) !== null;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function optionalString(data, name, errors, max) {
  const value = data[name];
  if (value === undefined) return;
  if (typeof value !== "string" || (max && value.length > max))
    errors.push("data." + name + " は文字列である必要があります");
}
function optionalTone(data, name, errors) {
  const value = data[name];
  if (value === undefined) return;
  if (!TONES.includes(value))
    errors.push("data." + name + " は " + TONES.join("/") + " のいずれかです");
}
function requiredString(data, name, errors) {
  if (!isNonEmptyString(data[name]))
    errors.push("data." + name + "（空でない文字列）が必要です");
}
function cells(value) {
  return value === null || value === undefined || typeof value === "string";
}

export const DATA_VALIDATORS = {
  text(data) { const e = []; requiredString(data, "text", e); return e; },
  heading(data) { const e = []; requiredString(data, "text", e); return e; },
  caption(data) { const e = []; requiredString(data, "text", e); return e; },
  code(data) {
    const e = [];
    requiredString(data, "code", e);
    optionalString(data, "language", e, 40);
    return e;
  },
  callout(data) {
    const e = [];
    requiredString(data, "text", e);
    optionalTone(data, "tone", e);
    return e;
  },
  "status-badge"(data) {
    const e = [];
    requiredString(data, "label", e);
    optionalTone(data, "tone", e);
    return e;
  },
  "key-value"(data) {
    const e = [];
    if (!Array.isArray(data.items) || data.items.length === 0) {
      e.push("data.items は1件以上の配列である必要があります");
      return e;
    }
    for (const item of data.items) {
      if (!isPlainObject(item) || !isNonEmptyString(item.label) || !cells(item.value)) {
        e.push("data.items の各要素は {label, value}（value は文字列か null）です");
        break;
      }
    }
    return e;
  },
  "simple-table"(data) {
    const e = [];
    if (!Array.isArray(data.columns) || data.columns.length === 0 ||
        !data.columns.every((c) => typeof c === "string"))
      e.push("data.columns は文字列の配列である必要があります");
    if (!Array.isArray(data.rows)) e.push("data.rows は配列である必要があります");
    else {
      for (const row of data.rows) {
        if (!Array.isArray(row) || !row.every(cells)) {
          e.push("data.rows のセルは文字列か null のみです（数値は0埋めせず未取得にします）");
          break;
        }
      }
    }
    return e;
  },
  card(data) { return containerErrors(data); },
  row(data) { return containerErrors(data); },
  column(data) { return containerErrors(data); },
  choice(data) {
    const e = [];
    requiredString(data, "prompt", e);
    if (!Array.isArray(data.choices) || data.choices.length === 0 ||
        data.choices.length > 8)
      e.push("data.choices は1〜8件の配列である必要があります");
    else {
      const seen = new Set();
      for (const choice of data.choices) {
        if (!isPlainObject(choice) || !isNonEmptyString(choice.id) ||
            !isNonEmptyString(choice.label)) {
          e.push("data.choices の各要素は {id, label}（文字列）が必要です");
          break;
        }
        if (seen.has(choice.id)) { e.push("data.choices の id が重複しています"); break; }
        seen.add(choice.id);
        if (choice.detail !== undefined && typeof choice.detail !== "string") {
          e.push("data.choices の detail は文字列です");
          break;
        }
      }
    }
    optionalString(data, "submit_label", e, 120);
    return e;
  },
  button(data) {
    const e = [];
    requiredString(data, "label", e);
    if (data.action !== undefined && !isPlainObject(data.action))
      e.push("data.action はオブジェクトである必要があります");
    return e;
  },
  form(data) {
    const e = [];
    if (!Array.isArray(data.fields) || data.fields.length === 0 ||
        data.fields.length > 24) {
      e.push("data.fields は1〜24件の配列である必要があります");
      return e;
    }
    for (const field of data.fields) {
      if (!isPlainObject(field) || !isNonEmptyString(field.id) ||
          !isNonEmptyString(field.label)) {
        e.push("data.fields の各要素は {id, label}（文字列）が必要です");
        break;
      }
      if (field.type !== undefined && !["text", "number", "textarea"].includes(field.type)) {
        e.push("data.fields の type は text/number/textarea のいずれかです");
        break;
      }
    }
    optionalString(data, "submit_label", e, 120);
    return e;
  },
  "dev.diff-split"(data) {
    const e = [];
    for (const name of ["before", "after"])
      if (typeof data[name] !== "string") e.push("data." + name + "（文字列）が必要です");
    optionalString(data, "path", e, 400);
    return e;
  },
  "dev.test-results"(data) {
    const e = [];
    if (!Array.isArray(data.cases) || data.cases.length === 0) {
      e.push("data.cases は1件以上の配列である必要があります");
      return e;
    }
    for (const item of data.cases) {
      if (!isPlainObject(item) || !isNonEmptyString(item.name) ||
          !TEST_STATUS.includes(item.status)) {
        e.push("data.cases の各要素は {name, status=" + TEST_STATUS.join("/") + "} です");
        break;
      }
    }
    optionalString(data, "suite", e, 200);
    return e;
  },
  "chart.line"(data) {
    const e = [];
    if (!Array.isArray(data.points) || data.points.length === 0)
      e.push("data.points は1件以上の配列である必要があります");
    else {
      for (const point of data.points) {
        if (!Array.isArray(point) || point.length !== 2 ||
            !point.every((v) => typeof v === "number" && Number.isFinite(v))) {
          e.push("data.points は [x, y]（有限数値）の配列である必要があります");
          break;
        }
      }
    }
    optionalString(data, "x_unit", e, 40);
    optionalString(data, "y_unit", e, 40);
    return e;
  },
  "chart.bar"(data) {
    const e = [];
    if (!Array.isArray(data.bars) || data.bars.length === 0 ||
        data.bars.length > 24) {
      e.push("data.bars は1〜24件の配列である必要があります");
      return e;
    }
    for (const bar of data.bars) {
      if (!isPlainObject(bar) || !isNonEmptyString(bar.label) ||
          (bar.value !== null && (typeof bar.value !== "number" || !Number.isFinite(bar.value) || bar.value < 0))) {
        e.push("data.bars の各要素は {label, value}（value は非負数値か null=未取得）です");
        break;
      }
      if (bar.tone !== undefined && !TONES.includes(bar.tone)) {
        e.push("data.bars の tone が不正です");
        break;
      }
    }
    optionalString(data, "unit", e, 40);
    return e;
  },
  "agent.approval"(data) {
    const e = [];
    requiredString(data, "operation", e);
    for (const name of ["target", "status", "reason"])
      optionalString(data, name, e, 400);
    return e;
  },
};
function containerErrors(data) {
  const e = [];
  if (!Array.isArray(data.blocks)) {
    e.push("data.blocks（入れ子のブロック配列）が必要です");
    return e;
  }
  if (data.blocks.length === 0) e.push("data.blocks は1件以上必要です");
  optionalString(data, "title", e, 200);
  return e;
}

export function defaultActions(block) {
  if (!isPlainObject(block)) return null;
  const id = isNonEmptyString(block.id) ? block.id : "block";
  const data = isPlainObject(block.data) ? block.data : {};
  if (block.kind === "choice")
    return [{ id: id + ":submit", kind: "submit_choice",
      label: isNonEmptyString(data.submit_label) ? data.submit_label : "選択を送信" }];
  if (block.kind === "form")
    return [{ id: id + ":submit", kind: "submit_form",
      label: isNonEmptyString(data.submit_label) ? data.submit_label : "送信" }];
  if (block.kind === "agent.approval")
    return [{ id: id + ":approve", kind: "approve", label: "承認する" },
      { id: id + ":reject", kind: "reject", label: "差し戻す" }];
  return null;
}
export function normalizeBlock(block, depth) {
  if (!isPlainObject(block)) return block;
  const level = depth === undefined ? 1 : depth;
  const next = { ...block };
  const data = isPlainObject(block.data) ? { ...block.data } : block.data;
  next.data = data;
  if (level <= MAX_DEPTH && isPlainObject(data) && Array.isArray(data.blocks))
    next.data = { ...data, blocks: data.blocks.map((child) => normalizeBlock(child, level + 1)) };
  if (isPlainObject(next.data) && next.data.action !== undefined &&
      Array.isArray(next.actions) === false && isPlainObject(next.data.action)) {
    next.actions = [{ ...next.data.action }];
  }
  if (!Array.isArray(next.actions) || next.actions.length === 0) {
    const injected = defaultActions(next);
    if (injected) next.actions = injected;
  }
  if (Array.isArray(next.actions))
    next.actions = next.actions.map((action) =>
      isPlainObject(action) ? { id: action.id, kind: action.kind, label: action.label } : action);
  return next;
}
function walk(blocks, depth, visit) {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!isPlainObject(block)) continue;
    visit(block, depth);
    if (depth < MAX_DEPTH && isPlainObject(block.data) && Array.isArray(block.data.blocks))
      walk(block.data.blocks, depth + 1, visit);
  }
}
export function countBlocks(blocks) {
  let total = 0;
  walk(blocks, 1, () => { total += 1; });
  return total;
}
export function collectActions(blocks) {
  const actions = [];
  const seen = new Set();
  let duplicates = false;
  walk(blocks, 1, (block) => {
    if (!Array.isArray(block.actions)) return;
    for (const action of block.actions) {
      if (!isPlainObject(action) || !isNonEmptyString(action.id)) continue;
      if (seen.has(action.id)) { duplicates = true; continue; }
      seen.add(action.id);
      actions.push({
        block_id: block.id, action_id: action.id, kind: action.kind,
        label: action.label, handling: actionHandling(action.kind),
      });
    }
  });
  return { actions, duplicates };
}
export function validateObservation(observation) {
  if (observation === undefined) return { ok: true, errors: [] };
  if (!isPlainObject(observation))
    return { ok: false, errors: ["observation はオブジェクトである必要があります"] };
  if (!Object.hasOwn(OBSERVATION_LABELS, observation.kind))
    return { ok: false, errors: ["observation.kind が未知です: " + String(observation.kind)] };
  const errors = [];
  for (const name of ["source", "observed_at", "reference"])
    if (observation[name] !== undefined && typeof observation[name] !== "string")
      errors.push("observation." + name + " は文字列である必要があります");
  return { ok: errors.length === 0, errors };
}
export function validateAction(action) {
  if (!isPlainObject(action))
    return { ok: false, errors: ["action はオブジェクトである必要があります"], handling: null };
  const errors = [];
  if (!isNonEmptyString(action.id) || action.id.length > 128)
    errors.push("action.id は1〜128文字の文字列が必要です");
  if (!isNonEmptyString(action.label) || action.label.length > 256)
    errors.push("action.label は1〜256文字の文字列が必要です");
  const handling = actionHandling(action.kind);
  if (handling === null) errors.push("action.kind が未知です: " + String(action.kind));
  return { ok: errors.length === 0, errors, handling };
}
export function validateBlock(block, depth) {
  const level = depth === undefined ? 1 : depth;
  if (!isPlainObject(block))
    return { ok: false, errors: ["block はオブジェクトである必要があります"], fallback: true };
  const errors = [];
  if (!isNonEmptyString(block.id) || block.id.length > 128)
    errors.push("block.id は1〜128文字の文字列が必要です");
  if (typeof block.kind !== "string")
    errors.push("block.kind は文字列である必要があります");
  else if (!isKnownKind(block.kind))
    return { ok: false, errors: ["未知の kind です: " + block.kind], fallback: true };
  if (!isPlainObject(block.data))
    errors.push("block.data はオブジェクトである必要があります");
  else if (isKnownKind(block.kind))
    for (const error of DATA_VALIDATORS[block.kind](block.data)) errors.push(error);
  if (block.title !== undefined && typeof block.title !== "string")
    errors.push("block.title は文字列である必要があります");
  if (isPlainObject(block.data) && Array.isArray(block.data.blocks)) {
    if (level >= MAX_DEPTH) errors.push("入れ子は" + MAX_DEPTH + "段までです");
    for (const child of block.data.blocks) {
      const checked = validateBlock(child, level + 1);
      for (const error of checked.errors) errors.push("入れ子: " + error);
    }
  }
  for (const error of validateObservation(block.observation).errors) errors.push(error);
  if (block.actions !== undefined) {
    if (!Array.isArray(block.actions)) errors.push("block.actions は配列である必要があります");
    else if (block.actions.length > MAX_ACTIONS)
      errors.push("block.actions は" + MAX_ACTIONS + "件までです");
    else
      for (const action of block.actions)
        for (const error of validateAction(action).errors) errors.push(error);
  }
  return { ok: errors.length === 0, errors, fallback: errors.length > 0 };
}
function safeStringify(value) {
  try {
    return JSON.stringify(value === undefined ? null : value, null, 2).slice(0, 4000);
  } catch { return "(表示できない値)"; }
}
export function fallbackBlock(block, reason) {
  const src = isPlainObject(block) ? block : {};
  const out = {
    id: isNonEmptyString(src.id) ? src.id : "fallback",
    kind: "text",
    data: { text: "未対応のUIブロックを文字表示します（" + reason + "）。コードとしては実行しません。\n" + safeStringify(block) },
    _fallback: { from: String(src.kind), reason },
  };
  if (typeof src.title === "string") out.title = src.title;
  if (isPlainObject(src.observation)) out.observation = src.observation;
  return out;
}
export function validateEnvelope(envelope) {
  const errors = [];
  if (!isPlainObject(envelope)) return { ok: false, errors: ["not-an-object"] };
  if (envelope.protocol !== PROTOCOL) errors.push("bad-protocol");
  if (!Array.isArray(envelope.blocks)) errors.push("bad-blocks");
  else {
    if (countBlocks(envelope.blocks) > MAX_BLOCKS) errors.push("too-many-blocks");
    envelope.blocks.forEach((block, index) => {
      const result = validateBlock(block);
      if (!result.ok) errors.push("block-" + index + ":" + result.errors.join(","));
    });
  }
  return { ok: errors.length === 0, errors };
}
