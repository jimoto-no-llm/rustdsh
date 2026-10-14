import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const candidate = process.env.RDSH_CANDIDATE;

async function rawWebSocketServer() {
  const sockets = new Set();
  const server = createTcpServer(socket => {
    sockets.add(socket);
    socket.once('data', request => {
      const key = /sec-websocket-key: (.+)\r/i.exec(request.toString())?.[1]?.trim();
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, sockets, url: `ws://127.0.0.1:${server.address().port}` };
}

async function waitFor(predicate, timeoutMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, 'peer did not close before timeout');
}

test('actual patched acquire keeps cached busy, keep-false, and abort sockets behind the exact-session barrier', { skip: !candidate }, async () => {
  const require = createRequire(import.meta.url);
  const { WebSocketServer } = require(path.join(candidate, 'node_modules/ws'));
  const peers = new Set();
  const server = new WebSocketServer({ port: 0 });
  server.on('connection', peer => peers.add(peer));
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}`;
  try {
    const sdk = await import(`${pathToFileURL(path.join(candidate, 'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js')).href}?acquire=${Date.now()}`);
    const acquire = sdk.__rdshAcquireWebSocketForTest;
    const resources = await import(pathToFileURL(path.join(candidate, 'node_modules/@earendil-works/pi-ai/dist/session-resources.js')).href);
    assert.equal(typeof acquire, 'function');
    const headers = new Headers();
    const first = await acquire(url, headers, 'cache-id', 'account', undefined, 500, undefined, 'node-ws', 'owned-session');
    const busyExtra = await acquire(url, headers, 'cache-id', 'account', undefined, 500, undefined, 'node-ws', 'owned-session');
    assert.equal(first.reused, false);
    assert.equal(busyExtra.reused, false);
    const other = await acquire(url, headers, 'other-cache', 'other-account', undefined, 500, undefined, 'node-ws', 'other-session');
    first.release({ keep: false });
    busyExtra.release({ keep: false });
    resources.cleanupSessionResources('owned-session');
    await resources.cleanupSessionResourcesAsync('owned-session');
    await waitFor(() => first.socket.readyState === 3 && busyExtra.socket.readyState === 3);
    assert.equal(other.socket.readyState, 1, 'owned cleanup leaves another session socket open');

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      acquire(url, headers, 'abort-cache', 'abort-account', controller.signal, 500, undefined, 'node-ws', 'owned-session'),
      /aborted/i,
    );
    await sdk.closeOpenAICodexWebSocketSessions('owned-session');

    const rejected = createServer((request, response) => {
      response.writeHead(403);
      response.end();
    });
    await new Promise(resolve => rejected.listen(0, '127.0.0.1', resolve));
    const rejectedUrl = `ws://127.0.0.1:${rejected.address().port}`;
    await assert.rejects(
      acquire(rejectedUrl, headers, 'error-cache', 'error-account', undefined, 500, undefined, 'node-ws', 'owned-session'),
      /unexpected server response|WebSocket/i,
    );
    await sdk.closeOpenAICodexWebSocketSessions('owned-session');
    await new Promise(resolve => rejected.close(resolve));

    await sdk.closeOpenAICodexWebSocketSessions('other-session');
    await waitFor(() => other.socket.readyState === 3);
  } finally {
    for (const peer of peers) peer.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});


test('actual standard WebSocket non-ACK stays silent and legacy sync-only cleanup has no unhandled rejection', { skip: !candidate }, async () => {
  const raw = await rawWebSocketServer();
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const sdk = await import(`${pathToFileURL(path.join(candidate, 'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js')).href}?standard=${Date.now()}`);
    const resources = await import(pathToFileURL(path.join(candidate, 'node_modules/@earendil-works/pi-ai/dist/session-resources.js')).href);
    const acquire = sdk.__rdshAcquireWebSocketForTest;
    const standard = await acquire(raw.url, new Headers(), 'standard-session', 'account', undefined, 500, undefined, 'runtime', 'standard-session');
    assert.equal(typeof standard.socket.terminate, 'undefined');
    const started = performance.now();
    await sdk.closeOpenAICodexWebSocketSessions('standard-session');
    assert.ok(performance.now() - started < 100, 'standard close must not await a non-ACK peer');

    const nodeWs = await acquire(raw.url, new Headers(), 'sync-session', 'account', undefined, 500, undefined, 'node-ws', 'sync-session');
    // Make the tracked close reject after its grace period.  The legacy API
    // invokes this disposer synchronously and discards its return value.
    nodeWs.socket.terminate = undefined;
    resources.cleanupSessionResources('sync-session');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(unhandled.length, 0, 'legacy sync cleanup must observe rejections');
    await sdk.closeOpenAICodexWebSocketSessions('sync-session');
    nodeWs.release({ keep: false });
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    for (const socket of raw.sockets) socket.destroy();
    await new Promise(resolve => raw.server.close(resolve));
  }
});
