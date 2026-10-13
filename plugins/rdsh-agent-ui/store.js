// Storage for the in-conversation agent UI.
//
// The agent publishes one surface, a human acts on it in the DSH Web chat, and
// the action returns to the same session. This module owns the files and the
// validation; the plugin never executes a model-supplied command.
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_SURFACE_BYTES = 262144;
export const MAX_ACTION_BYTES = 8192;
export const MAX_BLOCKS = 200;
export const MAX_ACTIONS_RETURNED = 100;

// The dashboard renderer owns the full set; this list only has to reject
// obviously wrong data before it reaches the browser.
export const BLOCK_KINDS = [
  'text', 'heading', 'caption', 'code', 'callout', 'status-badge',
  'key-value', 'simple-table', 'card', 'row', 'column',
  'choice', 'button', 'form', 'dev.diff-split', 'dev.test-results',
  'chart.line', 'chart.bar', 'agent.approval',
];

export function agentUiDir(home) {
  return path.join(home, 'agent-ui');
}
export function surfacePath(home) {
  return path.join(agentUiDir(home), 'surface.json');
}
export function actionsPath(home) {
  return path.join(agentUiDir(home), 'actions.jsonl');
}

const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateSurface(value) {
  if (!isObject(value)) return { ok: false, error: 'surface-not-an-object' };
  if (!Array.isArray(value.blocks) || value.blocks.length === 0)
    return { ok: false, error: 'surface-needs-blocks' };
  if (value.blocks.length > MAX_BLOCKS) return { ok: false, error: 'too-many-blocks' };
  const ids = new Set();
  for (const block of value.blocks) {
    if (!isObject(block)) return { ok: false, error: 'block-not-an-object' };
    if (typeof block.id !== 'string' || block.id.length === 0 || block.id.length > 128)
      return { ok: false, error: 'bad-block-id' };
    if (ids.has(block.id)) return { ok: false, error: 'duplicate-block-id' };
    ids.add(block.id);
    if (!BLOCK_KINDS.includes(block.kind)) return { ok: false, error: 'unknown-kind:' + String(block.kind) };
    if (!isObject(block.data)) return { ok: false, error: 'bad-block-data' };
  }
  return { ok: true };
}

export async function readSurface(home) {
  try {
    const raw = await fs.readFile(surfacePath(home), 'utf8');
    if (Buffer.byteLength(raw) > MAX_SURFACE_BYTES)
      return { surface: null, error: 'surface-too-large' };
    const parsed = JSON.parse(raw);
    const checked = validateSurface(parsed);
    if (!checked.ok) return { surface: null, error: checked.error };
    return { surface: parsed, error: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { surface: null, error: null };
    return { surface: null, error: 'surface-unreadable' };
  }
}

export async function writeSurface(home, value, now) {
  const checked = validateSurface(value);
  if (!checked.ok) return { ok: false, error: checked.error };
  const payload = { ...value, published_at: now || new Date().toISOString() };
  const body = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(body) > MAX_SURFACE_BYTES) return { ok: false, error: 'surface-too-large' };
  await fs.mkdir(agentUiDir(home), { recursive: true });
  const target = surfacePath(home);
  const temporary = target + '.tmp';
  await fs.writeFile(temporary, body, { mode: 0o600 });
  await fs.rename(temporary, target);
  return { ok: true, surface: payload };
}

function normaliseAction(input) {
  if (!isObject(input)) return { ok: false, error: 'action-not-an-object' };
  const requestId = input.request_id;
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128)
    return { ok: false, error: 'bad-request-id' };
  const actionId = input.action_id;
  if (typeof actionId !== 'string' || actionId.length === 0 || actionId.length > 128)
    return { ok: false, error: 'bad-action-id' };
  return {
    ok: true,
    action: {
      request_id: requestId,
      surface_id: typeof input.surface_id === 'string' ? input.surface_id.slice(0, 128) : null,
      surface_revision: Number.isSafeInteger(input.surface_revision) ? input.surface_revision : null,
      block_id: typeof input.block_id === 'string' ? input.block_id.slice(0, 128) : null,
      action_id: actionId,
      action_kind: typeof input.action_kind === 'string' ? input.action_kind.slice(0, 64) : null,
      label: typeof input.label === 'string' ? input.label.slice(0, 256) : null,
      value: input.value === undefined ? null : input.value,
      submitted_at: new Date().toISOString(),
    },
  };
}

export async function readActions(home) {
  try {
    const raw = await fs.readFile(actionsPath(home), 'utf8');
    const actions = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        actions.push(JSON.parse(line));
      } catch {
        // A torn last line is expected after a crash; skip it.
      }
    }
    return actions;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function appendAction(home, input) {
  const checked = normaliseAction(input);
  if (!checked.ok) return { ok: false, error: checked.error };
  const action = checked.action;
  const body = JSON.stringify(action);
  if (Buffer.byteLength(body) > MAX_ACTION_BYTES) return { ok: false, error: 'action-too-large' };
  await fs.mkdir(agentUiDir(home), { recursive: true });
  const existing = await readActions(home);
  const replay = existing.find((item) => item.request_id === action.request_id);
  if (replay) return { ok: true, action: replay, sequence: existing.indexOf(replay) + 1, replayed: true };
  const file = actionsPath(home);
  const line = body + '\n';
  try {
    await fs.appendFile(file, line, { mode: 0o600 });
  } catch {
    await fs.writeFile(file, line, { mode: 0o600 });
  }
  return { ok: true, action, sequence: existing.length + 1, replayed: false };
}

// A surface belongs where it was presented. The first turn tail that sees an
// unanchored surface claims it, and older or newer turns stay untouched.
export async function anchorSurface(home, input) {
  const surfaceId = input && typeof input.surface_id === 'string' ? input.surface_id : null;
  const revision = input && Number.isSafeInteger(input.surface_revision) ? input.surface_revision : null;
  const turn = input && Number.isSafeInteger(input.turn) && input.turn >= 0 ? input.turn : null;
  if (surfaceId === null || turn === null) return { ok: false, error: 'bad-anchor' };
  const loaded = await readSurface(home);
  if (!loaded.surface) return { ok: false, error: 'no-surface' };
  const current = loaded.surface;
  if (current.surface_id !== surfaceId) return { ok: false, error: 'stale-surface' };
  if (revision !== null && Number.isSafeInteger(current.revision) && current.revision !== revision)
    return { ok: false, error: 'stale-revision' };
  if (Number.isSafeInteger(current.turn)) return { ok: true, turn: current.turn, already: true };
  const written = await writeSurface(home, Object.assign({}, current, { turn }), current.published_at);
  return { ok: written.ok, turn, already: false, error: written.error || null };
}

export function actionsSince(actions, after) {
  const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
  const slice = actions.slice(cursor, cursor + MAX_ACTIONS_RETURNED);
  return { actions: slice, next_cursor: cursor + slice.length };
}
