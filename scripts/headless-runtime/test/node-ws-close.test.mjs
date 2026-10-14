import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
const runtime = await import('../node-ws-close.mjs').catch(() => null);

class FakePeer {
  constructor({ closeEmits = true } = {}) {
    this.closeEmits = closeEmits;
    this.closeCalls = 0;
    this.terminateCalls = 0;
    this.listeners = new Map();
  }
  addEventListener(name, listener) {
    const group = this.listeners.get(name) || new Set();
    group.add(listener);
    this.listeners.set(name, group);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name) { for (const listener of this.listeners.get(name) || []) listener(); }
  close() { this.closeCalls++; if (this.closeEmits) queueMicrotask(() => this.emit('close')); }
  terminate() { this.terminateCalls++; queueMicrotask(() => this.emit('close')); }
}

test('standard runtime-style peer completes a graceful close without termination', async () => {
  assert.ok(runtime?.closeOwnedWebSocket, 'must provide closeOwnedWebSocket');
  const peer = new FakePeer();
  const result = await runtime.closeOwnedWebSocket(peer, { graceMs: 20, reason: 'headless_dispose' });
  assert.deepEqual(result, { closed: true, forced: false });
  assert.equal(peer.closeCalls, 1);
  assert.equal(peer.terminateCalls, 0);
});

test('opt-in node-ws peer that does not acknowledge close is terminated once and settles under two seconds', async () => {
  const peer = new FakePeer({ closeEmits: false });
  const started = performance.now();
  const result = await runtime.closeOwnedWebSocket(peer, { graceMs: 1, reason: 'headless_dispose' });
  const elapsed = performance.now() - started;
  assert.deepEqual(result, { closed: true, forced: true });
  assert.equal(peer.closeCalls, 1);
  assert.equal(peer.terminateCalls, 1);
  assert.ok(elapsed < 2000, `cleanup settled in ${elapsed}ms`);
});

test('noncached peer is closed directly and never creates a retention timer', async () => {
  const peer = new FakePeer();
  const result = await runtime.closeOwnedWebSocket(peer, { graceMs: 20 });
  assert.deepEqual(result, { closed: true, forced: false });
  assert.equal(peer.closeCalls, 1);
  assert.equal(peer.terminateCalls, 0);
});

test('exact cleanup barriers await cached and noncached owned peers without touching another session', async () => {
  const calls = [];
  const registry = runtime.createExactSessionCloseRegistry(async socket => {
    calls.push(socket.name);
    await new Promise(resolve => setTimeout(resolve, 2));
  });
  const noncached = registry.track('owned', { name: 'noncached' });
  const unrelated = registry.track('other', { name: 'other' });
  const cachedPeer = new FakePeer();
  cachedPeer.name = 'cached';
  const cached = { socket: cachedPeer, idleTimer: undefined };
  await runtime.closeExactSessionSockets({
    sessionId: 'owned',
    cachedEntries: [cached],
    registry,
    options: { graceMs: 1 },
  });
  assert.deepEqual(calls, ['noncached']);
  await registry.close(unrelated);
  assert.deepEqual(calls, ['noncached', 'other']);
});
