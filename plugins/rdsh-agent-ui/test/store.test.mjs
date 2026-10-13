import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_BLOCKS, actionsSince, anchorSurface, appendAction, readActions,
  readSurface, surfacePath, validateSurface, writeSurface,
} from '../store.js';

async function home(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdsh-agent-ui-'));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('rdsh-agent-ui-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
const surface = (extra = {}) => ({
  surface_id: 'srf_test',
  revision: 1,
  title: 'テスト結果',
  blocks: [{ id: 'chart', kind: 'chart.bar', data: { bars: [{ label: '成功', value: 2 }] } }],
  ...extra,
});

test('a valid surface round-trips and an absent one is not an error', async (t) => {
  const dir = await home(t);
  assert.deepEqual(await readSurface(dir), { surface: null, error: null });
  const written = await writeSurface(dir, surface(), '2026-10-12T00:00:00.000Z');
  assert.equal(written.ok, true);
  const loaded = await readSurface(dir);
  assert.equal(loaded.error, null);
  assert.equal(loaded.surface.surface_id, 'srf_test');
  assert.equal(loaded.surface.published_at, '2026-10-12T00:00:00.000Z');
  const raw = JSON.parse(await fs.readFile(surfacePath(dir), 'utf8'));
  assert.equal(raw.blocks.length, 1);
});

test('bad surfaces are refused instead of rendered', async (t) => {
  const dir = await home(t);
  for (const [candidate, error] of [
    [{ blocks: [] }, 'surface-needs-blocks'],
    [{ blocks: [{ id: 'a', kind: 'text', data: {} }, { id: 'a', kind: 'text', data: {} }] }, 'duplicate-block-id'],
    [{ blocks: [{ id: 'a', kind: 'diagram.sankey', data: {} }] }, 'unknown-kind:diagram.sankey'],
    [{ blocks: [{ id: 'a', kind: 'text', data: null }] }, 'bad-block-data'],
    [{ blocks: [{ id: '', kind: 'text', data: {} }] }, 'bad-block-id'],
  ]) {
    assert.equal(validateSurface(candidate).error, error);
    assert.equal((await writeSurface(dir, candidate)).ok, false);
  }
  const tooMany = { blocks: Array.from({ length: MAX_BLOCKS + 1 }, (unused, index) => ({ id: 'b' + index, kind: 'text', data: {} })) };
  assert.equal(validateSurface(tooMany).error, 'too-many-blocks');
});

test('a damaged file reports an error instead of throwing', async (t) => {
  const dir = await home(t);
  await fs.mkdir(path.dirname(surfacePath(dir)), { recursive: true });
  await fs.writeFile(surfacePath(dir), '{not json');
  assert.deepEqual(await readSurface(dir), { surface: null, error: 'surface-unreadable' });
  await fs.writeFile(surfacePath(dir), JSON.stringify({ blocks: [{ id: 'a', kind: 'nope', data: {} }] }));
  assert.equal((await readSurface(dir)).error, 'unknown-kind:nope');
});

test('actions append in order, dedupe by request id and cursor', async (t) => {
  const dir = await home(t);
  const first = await appendAction(dir, { request_id: 'r1', action_id: 'next:submit', block_id: 'next', value: { choice_id: 'fix' } });
  assert.equal(first.ok, true);
  assert.equal(first.sequence, 1);
  assert.equal(first.replayed, false);
  const replay = await appendAction(dir, { request_id: 'r1', action_id: 'next:submit', block_id: 'next' });
  assert.equal(replay.replayed, true);
  assert.equal((await readActions(dir)).length, 1);
  await appendAction(dir, { request_id: 'r2', action_id: 'next:submit', block_id: 'next' });
  const actions = await readActions(dir);
  assert.equal(actions.length, 2);
  assert.deepEqual(actionsSince(actions, 1), { actions: [actions[1]], next_cursor: 2 });
  assert.equal(actions[0].submitted_at !== undefined, true);
});

test('malformed actions are refused', async (t) => {
  const dir = await home(t);
  assert.equal((await appendAction(dir, {})).error, 'bad-request-id');
  assert.equal((await appendAction(dir, { request_id: 'r', action_id: '' })).error, 'bad-action-id');
  assert.equal((await appendAction(dir, 'nope')).error, 'action-not-an-object');
  assert.equal((await readActions(dir)).length, 0);
});

test('an append failure preserves the existing action history', async (t) => {
  const dir = await home(t);
  await appendAction(dir, { request_id: 'saved', action_id: 'next:submit' });
  const before = await readActions(dir);
  const append = fs.appendFile;
  fs.appendFile = async () => { throw Object.assign(new Error('fixture IO failure'), { code: 'EIO' }); };
  try {
    await assert.rejects(() => appendAction(dir, { request_id: 'failed', action_id: 'next:submit' }), { code: 'EIO' });
  } finally {
    fs.appendFile = append;
  }
  assert.deepEqual(await readActions(dir), before);
});

test('a surface stays anchored to the first turn that claimed it', async (t) => {
  const dir = await home(t);
  assert.equal((await anchorSurface(dir, { surface_id: 'srf_test', turn: 3 })).error, 'no-surface');
  await writeSurface(dir, surface());
  const anchored = await anchorSurface(dir, { surface_id: 'srf_test', surface_revision: 1, turn: 7 });
  assert.deepEqual({ ok: anchored.ok, turn: anchored.turn, already: anchored.already },
    { ok: true, turn: 7, already: false });
  const later = await anchorSurface(dir, { surface_id: 'srf_test', surface_revision: 1, turn: 9 });
  assert.equal(later.turn, 7);
  assert.equal(later.already, true);
  assert.equal((await readSurface(dir)).surface.turn, 7);
  assert.equal((await anchorSurface(dir, { surface_id: 'srf_other', turn: 4 })).error, 'stale-surface');
  assert.equal((await anchorSurface(dir, { surface_id: 'srf_test', surface_revision: 2, turn: 4 })).error, 'stale-revision');
  assert.equal((await anchorSurface(dir, { surface_id: 'srf_test', turn: -1 })).error, 'bad-anchor');
});
