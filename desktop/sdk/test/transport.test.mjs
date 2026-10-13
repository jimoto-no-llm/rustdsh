import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestTimeoutError, TransportClosedError, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client';
import { createHarness } from '../index.js';

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'rdsh-sdk-fault-'));
  const harness = createHarness({ sdkHome: join(root, 'home'), cwd: root,
    dshBin: fileURLToPath(new URL('./fixtures/wire-runtime.mjs', import.meta.url)), provider: 'fixture-provider', model: 'fixture-model',
    env: { RDSH_TEST_MODE: mode || 'normal', RDSH_TEST_MARKER: join(root, 'marker') },
    initializeTimeoutMs: mode === 'initialize-timeout' ? 2000 : 5000, requestTimeoutMs: 5000,
    shutdownTimeoutMs: 100, disposeEofGraceMs: 100, disposeGraceMs: 1000 });
  t.after(async () => { await harness.close(); await rm(root, { recursive: true, force: true }); });
  return harness;
}
const exited = child => assert.ok(child.exitCode !== null || child.signalCode !== null, 'the SDK must confirm exit of its owned child');

test('a failed handshake reaps its process before an explicit retry starts a new one', { timeout: 10000 }, async t => {
  const harness = await fixture(t, 'exit-once'), failedClient = harness.client;
  await assert.rejects(harness.start(), TransportClosedError);
  exited(failedClient.child);
  assert.notEqual(harness.client, failedClient);
  await harness.start(); const child = harness.client.child;
  assert.notEqual(child.pid, failedClient.child.pid);
  assert.equal((await harness.client.request('fixture/echo', { selected: 'fixture' })).selected, 'fixture');
  await harness.close(); exited(child);
});

test('a hung handshake times out and forced disposal leaves no live owned child', { timeout: 10000 }, async t => {
  const harness = await fixture(t, 'initialize-timeout'), client = harness.client;
  await assert.rejects(harness.start(), RequestTimeoutError);
  exited(client.child); await harness.close();
});

test('RPC errors and individual request deadlines do not corrupt later traffic', { timeout: 10000 }, async t => {
  const harness = await fixture(t); await harness.start();
  await assert.rejects(harness.client.request('fixture/error'), error => error instanceof JsonRpcResponseError && error.code === -32602);
  await assert.rejects(harness.client.request('fixture/timeout', {}, 50), RequestTimeoutError);
  assert.deepEqual(await harness.client.request('fixture/echo', { afterTimeout: true }), { afterTimeout: true });
  const child = harness.client.child; await harness.close(); exited(child);
});

test('abrupt runtime exit rejects both a pending request and a notification subscriber', { timeout: 10000 }, async t => {
  const harness = await fixture(t); await harness.start();
  const subscriber = harness.client.subscribe(), notification = assert.rejects(subscriber.next(), TransportClosedError);
  const child = harness.client.child;
  await assert.rejects(harness.client.request('fixture/drop'), TransportClosedError);
  await notification; await harness.close(); exited(child);
});

test('close during a hung request is shared, reaps the child and rejects terminal reuse', { timeout: 10000 }, async t => {
  const harness = await fixture(t, 'ignore-shutdown'); await harness.start();
  const child = harness.client.child;
  const request = assert.rejects(harness.client.request('fixture/hang'), TransportClosedError);
  // Queue order on stdin ensures the hanging request precedes shutdown.
  await new Promise(resolve => setImmediate(resolve));
  const first = harness.close(), second = harness.close(); assert.equal(first, second);
  await first; await request; exited(child);
  await assert.rejects(harness.client.request('fixture/echo'), TransportClosedError);
  await assert.rejects(harness.client.subscribe().next(), TransportClosedError);
});
