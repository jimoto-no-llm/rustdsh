import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createSerialProxy, parseArgs } from '../../scripts/serial-proxy.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function fixture(t, handler, options = {}) {
  const upstream = createServer(handler);
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const upstreamPort = upstream.address().port;
  const proxy = createSerialProxy({
    upstreamUrl: 'http://127.0.0.1:' + upstreamPort + '/v1/',
    port: 0,
    ...options,
  });
  await proxy.listen();
  const proxyPort = proxy.address().port;
  t.after(async () => {
    await proxy.close();
    await closeServer(upstream);
  });
  return {
    proxy,
    upstream,
    upstreamUrl: 'http://127.0.0.1:' + upstreamPort,
    url: 'http://127.0.0.1:' + proxyPort,
  };
}

async function readAll(reader) {
  let output = '';
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return output;
    output += decoder.decode(value, { stream: true });
  }
}

async function waitForQueue(url, count) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = await fetch(url + '/__proxy/status').then((response) => response.json());
    if (status.queued === count) return status;
    await delay(5);
  }
  throw new Error('proxy queue did not reach ' + count);
}

test('serializes five concurrent requests and forwards the configured path and authorization', async (t) => {
  let active = 0;
  let maximum = 0;
  let directCount = 0;
  let releaseDirect;
  const directReleased = new Promise((resolve) => { releaseDirect = resolve; });
  let readyDirect;
  const fiveDirectRequests = new Promise((resolve) => { readyDirect = resolve; });
  const seen = [];
  const { url, upstreamUrl } = await fixture(t, async (req, res) => {
    active += 1;
    maximum = Math.max(maximum, active);
    if (req.url.includes('direct=')) {
      directCount += 1;
      if (directCount === 5) readyDirect();
      await directReleased;
    } else {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      await delay(20);
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.url);
    active -= 1;
  }, { max: 1 });

  const directResponses = Promise.all(Array.from({ length: 5 }, (_, index) =>
    fetch(upstreamUrl + '/v1/chat/completions?direct=' + index),
  ));
  let directTimeout;
  try {
    await Promise.race([
      fiveDirectRequests,
      new Promise((_, reject) => {
        directTimeout = setTimeout(() => reject(new Error('direct mock requests did not overlap')), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(directTimeout);
  }
  assert.equal(maximum, 5);
  releaseDirect();
  const directResults = await directResponses;
  assert.ok(directResults.every((response) => response.status === 200));
  await Promise.all(directResults.map((response) => response.text()));
  maximum = 0;

  const responses = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    fetch(url + '/chat/completions?request=' + index, {
      method: 'POST',
      headers: { authorization: 'Bearer DUMMY_PROVIDER_KEY' },
      body: JSON.stringify({ index }),
    }),
  ));

  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200]);
  assert.equal(maximum, 1, 'direct five-request baseline overlaps while the proxy caps five calls at one');
  assert.deepEqual(seen.map((request) => request.url).sort(), [
    '/v1/chat/completions?request=0',
    '/v1/chat/completions?request=1',
    '/v1/chat/completions?request=2',
    '/v1/chat/completions?request=3',
    '/v1/chat/completions?request=4',
  ]);
  assert.ok(seen.every((request) => request.authorization === 'Bearer DUMMY_PROVIDER_KEY'));
  const bodies = await Promise.all(responses.map((response) => response.text()));
  assert.ok(bodies.every((body) => body.startsWith('/v1/')));
});

test('does not duplicate the configured API path when the client base URL includes it', async (t) => {
  let seenPath;
  const { url } = await fixture(t, (req, res) => {
    seenPath = req.url;
    res.end('ok');
  });

  const response = await fetch(url + '/v1/models');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.equal(seenPath, '/v1/models');
});

test('forwards server-sent events before the upstream stream finishes', async (t) => {
  const finished = deferred();
  let upstreamFinished = false;
  const { url } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    res.write('data: first\n\n');
    setTimeout(() => {
      res.write('data: second\n\n');
      res.end();
      upstreamFinished = true;
      finished.resolve();
    }, 150);
  });

  const response = await fetch(url + '/chat/completions');
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
  assert.equal(upstreamFinished, false);
  const remaining = await readAll(reader);
  assert.match(remaining, /data: second/);
  await finished.promise;
});

test('a disconnected active client releases capacity so the next request proceeds', async (t) => {
  const upstreamClosed = deferred();
  const { url } = await fixture(t, (req, res) => {
    if (req.url === '/v1/hold') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('ready');
      res.once('close', () => upstreamClosed.resolve());
      return;
    }
    res.end('next');
  }, { max: 1 });

  const controller = new AbortController();
  const heldResponse = await fetch(url + '/hold', { signal: controller.signal });
  const reader = heldResponse.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'ready');
  controller.abort();
  await assert.rejects(reader.read());
  await upstreamClosed.promise;

  const next = await fetch(url + '/next');
  assert.equal(next.status, 200);
  assert.equal(await next.text(), 'next');
});

test('a disconnected waiting client is removed from the FIFO queue', async (t) => {
  const release = deferred();
  const { url } = await fixture(t, async (req, res) => {
    if (req.url === '/v1/hold') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('ready');
      await release.promise;
      res.end('done');
      return;
    }
    res.end('ok');
  }, { max: 1 });

  const activeResponse = await fetch(url + '/hold');
  const activeReader = activeResponse.body.getReader();
  await activeReader.read();
  const controller = new AbortController();
  const waitingRequest = fetch(url + '/waiting', { signal: controller.signal });
  await waitForQueue(url, 1);
  controller.abort();
  await assert.rejects(waitingRequest);
  await waitForQueue(url, 0);

  release.resolve();
  await readAll(activeReader);
  const next = await fetch(url + '/next');
  assert.equal(next.status, 200);
  assert.equal(await next.text(), 'ok');
});

test('serves queued requests in FIFO order', async (t) => {
  const release = deferred();
  t.after(() => release.resolve());
  const served = [];
  const { url } = await fixture(t, async (req, res) => {
    if (req.url === '/v1/hold') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('ready');
      await release.promise;
      res.end('done');
      return;
    }
    served.push(req.url);
    res.end(req.url);
  }, { max: 1 });

  const activeResponse = await fetch(url + '/hold');
  const activeReader = activeResponse.body.getReader();
  await activeReader.read();
  const first = fetch(url + '/first');
  await waitForQueue(url, 1);
  const second = fetch(url + '/second');
  await waitForQueue(url, 2);

  release.resolve();
  await readAll(activeReader);
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.deepEqual(served, ['/v1/first', '/v1/second']);
  await Promise.all(responses.map((response) => response.text()));
});

test('returns 429 when the bounded waiting queue is full', async (t) => {
  const release = deferred();
  const { url } = await fixture(t, async (req, res) => {
    if (req.url === '/v1/hold') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('ready');
      await release.promise;
      res.end('done');
      return;
    }
    res.end('ok');
  }, { max: 1, maxQueue: 1 });

  const activeResponse = await fetch(url + '/hold');
  const activeReader = activeResponse.body.getReader();
  await activeReader.read();
  const queued = fetch(url + '/queued');
  await waitForQueue(url, 1);
  const rejected = await fetch(url + '/overflow');
  assert.equal(rejected.status, 429);
  assert.deepEqual(await rejected.json(), { error: 'proxy_queue_full' });

  release.resolve();
  await readAll(activeReader);
  assert.equal((await queued).status, 200);
});

test('returns 503 when a queued request exceeds its wait timeout', async (t) => {
  const release = deferred();
  const { url } = await fixture(t, async (req, res) => {
    if (req.url === '/v1/hold') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('ready');
      await release.promise;
      res.end('done');
      return;
    }
    res.end('ok');
  }, { max: 1, waitTimeoutMs: 30 });

  const activeResponse = await fetch(url + '/hold');
  const activeReader = activeResponse.body.getReader();
  await activeReader.read();
  const timedOut = await fetch(url + '/timed-out');
  assert.equal(timedOut.status, 503);
  assert.deepEqual(await timedOut.json(), { error: 'proxy_queue_timeout' });

  release.resolve();
  await readAll(activeReader);
});

test('exposes current active and queued counts through the status endpoint', async (t) => {
  const release = deferred();
  const { url } = await fixture(t, async (_req, res) => {
    res.writeHead(200);
    res.write('ready');
    await release.promise;
    res.end('done');
  }, { max: 1, maxQueue: 3 });

  const activeResponse = await fetch(url + '/one', {
    headers: { authorization: 'Bearer DUMMY_SECRET' },
  });
  const activeReader = activeResponse.body.getReader();
  await activeReader.read();
  const waiting = fetch(url + '/two', {
    headers: { authorization: 'Bearer DUMMY_SECRET' },
  });
  const status = await waitForQueue(url, 1);
  assert.equal(status.active, 1);
  assert.equal(status.queued, 1);
  assert.equal(status.max, 1);
  assert.equal(status.maxQueue, 3);
  assert.deepEqual(Object.keys(status).sort(), ['active', 'max', 'maxQueue', 'queued']);

  release.resolve();
  await readAll(activeReader);
  assert.equal((await waiting).status, 200);
});

test('requires explicit opt-in to listen on a non-loopback host', () => {
  assert.throws(() => parseArgs([
    '--upstream', 'https://api.example/v1',
    '--host', '0.0.0.0',
  ]), /requires --allow-remote/);
  assert.equal(parseArgs([
    '--upstream', 'https://api.example/v1',
    '--host', '0.0.0.0',
    '--allow-remote',
  ]).allowRemote, true);
  assert.throws(() => parseArgs([
    '--upstream', 'https://user:secret@api.example/v1',
  ]), /must not contain credentials/);
  assert.throws(() => parseArgs([
    '--upstream', 'https://api.example/v1',
    '--max', '0',
  ]), /--max must be an integer/);
});