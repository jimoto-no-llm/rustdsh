import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import http from 'node:http';
import test from 'node:test';
import { createBurstTransport, classifyResponse } from './deepinfra-burst-transport.mjs';

async function scenario(t, handler, options = {}) {
  const original = https.request;
  let sends = 0;
  https.request = (_url, _options, callback) => {
    const req = new EventEmitter();
    const socket = new EventEmitter();
    req.destroy = () => {};
    req.end = () => { sends++; handler({ req, socket, callback, sent: true }); };
    queueMicrotask(() => { req.emit('socket', socket); handler({ req, socket, callback, sent: false }); });
    return req;
  };
  const transport = createBurstTransport({ connectMs: 40, requestMs: 150, ...options });
  t.after(() => { transport.close(); https.request = original; });
  const response = await transport.post({ key: 'dummy', body: '{}' });
  return { response, result: classifyResponse(response, 'test/model'), sends };
}

test('TLS connect deadline marks no-send and performs no automatic retry', async (t) => {
  const { result, sends } = await scenario(t, () => {});
  assert.equal(result.outcome, 'notSent');
  assert.equal(result.error, 'CONNECT_TIMEOUT');
  assert.equal(result.mayHaveSent, false);
  assert.equal(sends, 0);
});

test('connection reset before HTTP send is distinct from reset after send', async (t) => {
  await t.test('before', async (t) => {
    const { result, sends } = await scenario(t, ({ req }) => req.emit('error', { code: 'ECONNRESET' }));
    assert.equal(result.outcome, 'notSent');
    assert.equal(sends, 0);
  });
  await t.test('after', async (t) => {
    const { result, sends } = await scenario(t, ({ socket, req, sent }) => {
      if (!sent) socket.emit('secureConnect');
      else req.emit('error', { code: 'ECONNRESET' });
    });
    assert.equal(result.outcome, 'transportUnknown');
    assert.equal(result.phase, 'awaiting_headers');
    assert.equal(sends, 1);
  });
});

test('response deadline differs from TLS deadline', async (t) => {
  const { result, sends } = await scenario(t, ({ socket, sent }) => {
    if (!sent) socket.emit('secureConnect');
  });
  assert.equal(result.error, 'REQUEST_TIMEOUT');
  assert.equal(result.outcome, 'transportUnknown');
  assert.equal(sends, 1);
});

test('incomplete 429 body still preserves confirmed rejection', async (t) => {
  const { result, sends } = await scenario(t, ({ socket, callback, sent }) => {
    if (!sent) { socket.emit('secureConnect'); return; }
    const response = new EventEmitter();
    response.statusCode = 429;
    response.headers = { 'x-request-id': 'local-429' };
    callback(response);
    response.emit('aborted');
  });
  assert.equal(result.outcome, 'rateLimited');
  assert.equal(result.status, 429);
  assert.equal(result.requestId, 'local-429');
  assert.equal(sends, 1);
});

test('oversized response is bounded without logging its content', async (t) => {
  const { result } = await scenario(t, ({ socket, callback, sent }) => {
    if (!sent) { socket.emit('secureConnect'); return; }
    const response = new EventEmitter();
    response.statusCode = 200;
    response.headers = {};
    callback(response);
    response.emit('data', Buffer.from('secret-response-too-long'));
  }, { maxBodyBytes: 4 });
  assert.equal(result.error, 'RESPONSE_TOO_LARGE');
  assert.equal(result.outcome, 'transportUnknown');
  assert.ok(!JSON.stringify(result).includes('secret-response'));
});

test('real loopback socket loss is caught and never retransmitted', async (t) => {
  let received = 0;
  const server = http.createServer((req) => { received++; req.socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const original = https.request;
  // Exercise actual ClientRequest errors locally; TLS ordering is tested above.
  https.request = (_url, options, callback) => {
    const req = http.request(`http://127.0.0.1:${server.address().port}`, { ...options, agent: false }, callback);
    req.on('socket', (socket) => socket.once('connect', () => socket.emit('secureConnect')));
    return req;
  };
  const transport = createBurstTransport({ connectMs: 1000, requestMs: 2000 });
  t.after(async () => {
    transport.close(); https.request = original;
    await new Promise((resolve) => server.close(resolve));
  });
  const result = classifyResponse(await transport.post({ key: 'dummy', body: '{}' }), 'test/model');
  assert.equal(result.outcome, 'transportUnknown');
  assert.equal(result.error, 'ECONNRESET');
  assert.equal(received, 1);
});
