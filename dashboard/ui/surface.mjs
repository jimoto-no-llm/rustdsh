// rdsh-ui/1 server-side protocol: agent presents a surface, a human acts on it,
// and the result returns to the same session. The server owns action ids and
// never executes an operation because a button was pressed.
import { randomUUID } from "node:crypto";
import {
  MAX_BLOCKS, countBlocks, normalizeBlock, validateBlock, collectActions,
  fallbackBlock, actionHandling, ONE_SHOT_ACTIONS,
} from "./registry.mjs";

export const MAX_RECORDED_ACTIONS = 2000;
export const MAX_FORM_FIELDS = 64;
export const MAX_VALUE_LENGTH = 4000;

export class UiError extends Error {
  constructor(code, status) {
    super("ui: " + code);
    this.code = code;
    this.status = status || 400;
  }
}
function fail(code, status) { throw new UiError(code, status); }
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value, keys) {
  return isPlainObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
function optionalKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
}
function boundedText(value, max, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(code);
  return value;
}

export function presentSurface(state, input, now) {
  const at = now || new Date().toISOString();
  if (!optionalKeys(input, ["message_id", "session_id", "surface_id", "blocks", "observation"]))
    fail("ui_invalid_input");
  const messageId = boundedText(input.message_id, 256, "ui_invalid_message_id");
  const sessionId = input.session_id === undefined
    ? null : boundedText(input.session_id, 256, "ui_invalid_session_id");
  if (!Array.isArray(input.blocks) || input.blocks.length === 0) fail("ui_invalid_blocks");
  if (input.blocks.length > MAX_BLOCKS || countBlocks(input.blocks) > MAX_BLOCKS)
    fail("ui_too_many_blocks");
  const blocks = [];
  const fallback = [];
  for (const raw of input.blocks) {
    const candidate = normalizeBlock(raw, 1);
    const checked = validateBlock(candidate);
    if (checked.ok) blocks.push(candidate);
    else {
      const replaced = fallbackBlock(candidate, checked.errors.join(","));
      if (!isPlainObject(candidate) || typeof candidate.id !== "string" ||
          candidate.id.length === 0 || candidate.id.length > 128)
        replaced.id = "fallback_" + randomUUID();
      fallback.push({ id: replaced.id, kind: String(raw && raw.kind), errors: checked.errors });
      blocks.push(replaced);
    }
  }
  const collected = collectActions(blocks);
  if (collected.duplicateBlocks) fail("ui_duplicate_block");
  if (collected.duplicates) fail("ui_duplicate_action");
  const previous = state.ui_surfaces && state.ui_surfaces.current;
  const reuse = previous && (input.surface_id === undefined || input.surface_id === previous.surface_id);
  const current = {
    surface_id: reuse ? previous.surface_id : "srf_" + randomUUID(),
    message_id: messageId,
    session_id: sessionId,
    revision: reuse ? previous.revision + 1 : 1,
    blocks,
    observation: isPlainObject(input.observation) ? input.observation : null,
    presented_at: at,
  };
  state.ui_surfaces = {
    schema: 1,
    current,
    actions: (state.ui_surfaces && Array.isArray(state.ui_surfaces.actions))
      ? state.ui_surfaces.actions : [],
  };
  // A new revision invalidates earlier pending actions: rebinding is explicit.
  state.ui_surfaces.presented_count = ((state.ui_surfaces && state.ui_surfaces.presented_count) || 0) + 1;
  return {
    surface_id: current.surface_id,
    revision: current.revision,
    block_count: blocks.length,
    actions: collected.actions,
    fallback,
  };
}

function findBlock(blocks, blockId) {
  for (const block of blocks) {
    if (block.id === blockId) return block;
    if (isPlainObject(block.data) && Array.isArray(block.data.blocks)) {
      const nested = findBlock(block.data.blocks, blockId);
      if (nested) return nested;
    }
  }
  return null;
}
function validateValue(block, action, value) {
  if (action.kind === "submit_choice") {
    if (!isPlainObject(value)) fail("ui_value_required");
    const choices = (block.data && Array.isArray(block.data.choices)) ? block.data.choices : [];
    if (!choices.some((choice) => choice.id === value.choice_id)) fail("ui_unknown_choice");
    return { choice_id: value.choice_id };
  }
  if (action.kind === "submit_form") {
    if (!isPlainObject(value)) fail("ui_value_required");
    const keys = Object.keys(value);
    if (keys.length > MAX_FORM_FIELDS) fail("ui_value_too_large");
    const out = {};
    for (const key of keys) {
      const field = value[key];
      if (typeof field !== "string" || field.length > MAX_VALUE_LENGTH) fail("ui_invalid_value");
      out[key] = field;
    }
    return out;
  }
  if (value === undefined || value === null) return null;
  fail("ui_value_not_allowed");
}

export function applyUiAction(state, input, now) {
  const at = now || new Date().toISOString();
  if (!optionalKeys(input, ["surface_id", "surface_revision", "block_id", "action_id", "value", "action_request_id"]))
    fail("ui_invalid_input");
  const requestId = boundedText(input.action_request_id, 128, "ui_invalid_request_id");
  const current = state.ui_surfaces && state.ui_surfaces.current;
  if (!current) fail("ui_no_surface", 409);
  if (input.surface_id !== current.surface_id) fail("ui_surface_mismatch", 409);
  if (!Number.isSafeInteger(input.surface_revision) || input.surface_revision !== current.revision)
    fail("ui_action_stale", 409);
  const block = findBlock(current.blocks, input.block_id);
  const actions = block && Array.isArray(block.actions) ? block.actions : [];
  const action = actions.find((item) => item.id === input.action_id);
  if (!action) fail("ui_action_unknown");
  const recorded = state.ui_surfaces.actions;
  const replay = recorded.find((item) => item.action_request_id === requestId);
  if (replay) return { ...replay, replayed: true };
  const handling = actionHandling(action.kind);
  if (ONE_SHOT_ACTIONS.includes(action.kind) &&
      recorded.some((item) => item.surface_id === current.surface_id &&
        item.surface_revision === current.revision && item.action_id === action.id))
    fail("ui_action_already_submitted", 409);
  const value = validateValue(block, action, input.value);
  const sequence = ((state.feedback && state.feedback.at(-1) && state.feedback.at(-1).sequence) || 0) + 1;
  const record = {
    action_request_id: requestId,
    sequence,
    surface_id: current.surface_id,
    surface_revision: current.revision,
    message_id: current.message_id,
    session_id: current.session_id,
    block_id: block.id,
    action_id: action.id,
    action_kind: action.kind,
    handling,
    label: action.label,
    value,
    submitted_at: at,
    execution_authorized: false,
    followup_required: handling === "request",
  };
  recorded.push(record);
  if (recorded.length > MAX_RECORDED_ACTIONS)
    state.ui_surfaces.actions = recorded.slice(-MAX_RECORDED_ACTIONS);
  state.feedback.push({
    sequence,
    type: "ui_action",
    surface_id: record.surface_id,
    surface_revision: record.surface_revision,
    message_id: record.message_id,
    session_id: record.session_id,
    block_id: record.block_id,
    action_id: record.action_id,
    action_kind: record.action_kind,
    handling: record.handling,
    label: record.label,
    value: record.value,
    submitted_at: record.submitted_at,
    execution_authorized: false,
    followup_required: record.followup_required,
  });
  return {
    ...record,
    accepted: true,
    replayed: false,
    delivered_to_session: true,
    note: handling === "request"
      ? "要求を記録しました。実行は別の認可された経路で行ってください。"
      : "選択を同じセッションへ返しました。実行権限は発行していません。",
  };
}

export function validateUiSurfaces(state) {
  const extension = state.ui_surfaces;
  if (extension === undefined) return;
  if (!isPlainObject(extension) || extension.schema !== 1 ||
      !Array.isArray(extension.actions) || extension.actions.length > MAX_RECORDED_ACTIONS)
    fail("ui_invalid_store");
  const current = extension.current;
  if (current === undefined) return;
  if (!isPlainObject(current) || typeof current.surface_id !== "string" ||
      !Number.isSafeInteger(current.revision) || current.revision < 1 ||
      !Array.isArray(current.blocks) || current.blocks.length === 0 ||
      current.blocks.length > MAX_BLOCKS || countBlocks(current.blocks) > MAX_BLOCKS)
    fail("ui_invalid_store");
  for (const block of current.blocks) {
    const checked = validateBlock(block);
    if (!checked.ok) fail("ui_invalid_store");
  }
  const collected = collectActions(current.blocks);
  if (collected.duplicateBlocks || collected.duplicates) fail("ui_invalid_store");
}

export function publicUiSurfaces(state) {
  const extension = state.ui_surfaces;
  if (!extension || !extension.current) return { schema: 1, current: null, actions: [] };
  const current = extension.current;
  return {
    schema: 1,
    current: {
      surface_id: current.surface_id,
      message_id: current.message_id,
      session_id: current.session_id,
      revision: current.revision,
      presented_at: current.presented_at,
      observation: current.observation || null,
      blocks: current.blocks,
    },
    actions: extension.actions.slice(-20).map((item) => ({
      sequence: item.sequence,
      block_id: item.block_id,
      action_id: item.action_id,
      action_kind: item.action_kind,
      handling: item.handling,
      value: item.value,
      submitted_at: item.submitted_at,
      execution_authorized: false,
    })),
  };
}
