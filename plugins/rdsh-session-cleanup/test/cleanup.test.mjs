import assert from 'node:assert/strict';
import test from 'node:test';
const plugin = await import('../cleanup.mjs').catch(() => null);

function context(profile = 'headless') {
  const listeners = new Map();
  const disposers = [];
  return {
    get: name => name === 'profileContext' ? { name: profile } : undefined,
    on(name, listener) {
      const group = listeners.get(name) || new Set();
      group.add(listener); listeners.set(name, group);
      return () => group.delete(listener);
    },
    effect(install) { disposers.push(install()); },
    emit(name, value) { for (const listener of listeners.get(name) || []) listener(value); },
    async dispose() { for (const dispose of disposers.splice(0)) await dispose(); },
    count: () => [...listeners.values()].reduce((total, group) => total + group.size, 0),
  };
}

const agent = id => ({ agent: { id, session: { id } } });

test('terminal disposal awaits one exact owned cleanup despite duplicate events', async () => {
  assert.ok(plugin?.attachSessionCleanup, 'must provide attachSessionCleanup');
  const ctx = context();
  const ids = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  plugin.attachSessionCleanup(ctx, async id => { ids.push(id); await pending; });
  ctx.emit('agent/created', agent('owned'));
  ctx.emit('session/disposed', { id: 'owned' });
  ctx.emit('session/disposed', { id: 'owned' });
  const disposing = ctx.dispose();
  assert.deepEqual(ids, ['owned']);
  finish();
  await disposing;
  assert.equal(ctx.count(), 0);
});

test('profile teardown cleans only remaining owned sessions', async () => {
  assert.ok(plugin?.attachSessionCleanup, 'must provide attachSessionCleanup');
  const ctx = context();
  const ids = [];
  plugin.attachSessionCleanup(ctx, async id => { ids.push(id); });
  ctx.emit('agent/created', agent('first'));
  ctx.emit('agent/created', agent('second'));
  ctx.emit('session/disposed', { id: 'first' });
  ctx.emit('session/disposed', { id: 'unrelated' });
  await ctx.dispose();
  assert.deepEqual(ids, ['first', 'second']);
});

test('non-headless profiles install no listeners or cleanup', async () => {
  assert.ok(plugin?.attachSessionCleanup, 'must provide attachSessionCleanup');
  const ctx = context('desktop');
  const ids = [];
  plugin.attachSessionCleanup(ctx, async id => { ids.push(id); });
  ctx.emit('agent/created', agent('owned'));
  await ctx.dispose();
  assert.deepEqual(ids, []);
  assert.equal(ctx.count(), 0);
});
