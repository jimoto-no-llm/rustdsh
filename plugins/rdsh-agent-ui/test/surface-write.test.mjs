import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readSurface, surfacePath, writeSurface } from '../store.js';

async function home(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rdsh-surface-write-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const surface = (id, text) => ({
  surface_id: id,
  blocks: [{ id: 'text', kind: 'text', data: { text } }],
});

test('concurrent publications save complete surfaces', { timeout: 5000 }, async (t) => {
  const dir = await home(t);
  const target = surfacePath(dir);
  const rename = fs.rename;
  let ready = 0;
  const { promise, resolve } = Promise.withResolvers();
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === target) {
      if (++ready === 2) resolve();
      await promise;
    }
    return rename(source, destination);
  });
  const values = [surface('small', 'small'), surface('large', 'x'.repeat(240000))];
  const results = await Promise.allSettled(values.map(value => writeSurface(dir, value)));
  for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message);
  const loaded = await readSurface(dir);
  assert.equal(loaded.error, null);
  const expected = results.find(result => result.value.surface.surface_id === loaded.surface.surface_id);
  assert.deepEqual(loaded.surface, expected?.value.surface);
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['surface.json']);
});

test('the last completed replacement wins even when it was published first', { timeout: 5000 }, async (t) => {
  const dir = await home(t);
  const target = surfacePath(dir);
  const rename = fs.rename;
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === target && JSON.parse(await fs.readFile(source, 'utf8')).surface_id === 'first') {
      arrived.resolve();
      await release.promise;
    }
    return rename(source, destination);
  });
  const first = writeSurface(dir, surface('first', 'finishes last'));
  try {
    await arrived.promise;
    const second = await writeSurface(dir, surface('second', 'finishes first'));
    assert.deepEqual((await readSurface(dir)).surface, second.surface);
    release.resolve();
    const last = await first;
    assert.deepEqual((await readSurface(dir)).surface, last.surface);
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['surface.json']);
  } finally {
    release.resolve();
    await first.catch(() => {});
  }
});

test('a failed replacement preserves the previous surface and removes its temporary file', async (t) => {
  const dir = await home(t);
  const initial = await writeSurface(dir, surface('initial', 'preserve'));
  const failure = Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
  t.mock.method(fs, 'rename', async () => { throw failure; });
  await assert.rejects(writeSurface(dir, surface('replacement', 'new')), error => error === failure);
  assert.deepEqual((await readSurface(dir)).surface, initial.surface);
  assert.deepEqual(await fs.readdir(path.dirname(surfacePath(dir))), ['surface.json']);
});

test('an exclusive creation failure preserves an existing temporary file', async (t) => {
  const dir = await home(t);
  const open = fs.open;
  let collision;
  t.mock.method(fs, 'open', async (...args) => {
    collision = args[0];
    await fs.writeFile(collision, 'preserve existing data', { flag: 'wx' });
    return open(...args);
  });
  await assert.rejects(writeSurface(dir, surface('replacement', 'new')), { code: 'EEXIST' });
  assert.equal(await fs.readFile(collision, 'utf8'), 'preserve existing data');
  assert.deepEqual(await readSurface(dir), { surface: null, error: null });
});
