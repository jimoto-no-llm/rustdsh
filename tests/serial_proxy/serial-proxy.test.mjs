import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createProxy, pipeUpstreamResponse } from '../../scripts/serial-proxy.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/serial-proxy.mjs');
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fakeUpstream({ delay = 150, host = '127.0.0.1' } = {}) {
  const st = { inflight: 0, peak: 0, total: 0, seen: [], finished: 0, receivedBytes: 0 };
  const server = http.createServer((req, res) => {
    st.inflight++; st.total++; st.peak = Math.max(st.peak, st.inflight);
    st.seen.push({ url: req.url, auth: req.headers.authorization });
    req.on('data', (chunk) => { st.receivedBytes += chunk.length; });
    let ended = false;
    const end = () => { if (!ended) { ended = true; st.inflight--; } };
    res.on('close', end);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      const t1 = setTimeout(() => res.write('data: 2\n\n'), delay / 2);
      const t2 = setTimeout(() => { res.end('data: 3\n\n'); st.finished++; }, delay);
      res.on('close', () => { clearTimeout(t1); clearTimeout(t2); });
    });
    req.resume();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  cleanups.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const hostname = host.includes(':') ? `[${host}]` : host;
  return { st, url: `http://${hostname}:${server.address().port}` };
}

async function startProxy(upstream, args = []) {
  const child = spawn(process.execPath, [SCRIPT, '--upstream', upstream, '--port', '0', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let buf = '';
  const url = await new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => { buf += d; const m = buf.match(/listening on (http:\/\/\S+)/); if (m) resolve(m[1]); });
    child.on('exit', (c) => reject(new Error(`exited ${c}: ${buf}`)));
  });
  cleanups.push(() => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill('SIGTERM'); }));
  return { url, child };
}

async function startProxyServer(upstream, options = {}) {
  const server = createProxy({ upstream, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function postSlow(url, body, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    let timer;
    const req = http.request(url, { method: 'POST', headers: { 'content-length': body.length } }, (res) => {
      if (timer) clearInterval(timer);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (error) => { if (timer) clearInterval(timer); reject(error); });
    let offset = 0;
    timer = setInterval(() => {
      if (offset >= body.length) {
        clearInterval(timer);
        timer = null;
        req.end();
        return;
      }
      const next = body.subarray(offset, Math.min(offset + 64 * 1024, body.length));
      offset += next.length;
      req.write(next);
    }, intervalMs);
  });
}

const get = async (url, init) => { const r = await fetch(url, init); return { status: r.status, text: await r.text(), json: null }; };

test('(a) --max 1 serializes parallel requests', async () => {
  const up = await fakeUpstream();
  const p = await startProxy(up.url);
  const rs = await Promise.all(Array.from({ length: 5 }, () => get(`${p.url}/v1/x`)));
  assert.ok(rs.every((r) => r.status === 200 && r.text.includes('data: 3')));
  assert.equal(up.st.peak, 1);
  assert.equal(up.st.total, 5);
});

test('(b) --max 2 allows 2 concurrent', async () => {
  const up = await fakeUpstream();
  const p = await startProxy(up.url, ['--max', '2']);
  const rs = await Promise.all(Array.from({ length: 5 }, () => get(`${p.url}/x`)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(up.st.peak, 2);
});

test('(c) SSE chunks arrive incrementally', async () => {
  const up = await fakeUpstream({ delay: 600 });
  const p = await startProxy(up.url);
  const r = await fetch(`${p.url}/x`);
  const reader = r.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString(), /data: 1/);
  assert.equal(up.st.finished, 0, 'upstream must still be running');
  while (!(await reader.read()).done);
});

test('(d) client abort in flight releases slot', async () => {
  const up = await fakeUpstream({ delay: 5000 });
  const p = await startProxy(up.url);
  const ac = new AbortController();
  const r1 = await fetch(`${p.url}/a`, { signal: ac.signal });
  await r1.body.getReader().read();
  const ac2 = new AbortController();
  const second = fetch(`${p.url}/b`, { signal: ac2.signal }).catch(() => null);
  await sleep(200);
  assert.equal(up.st.seen.length, 1, 'second must be queued');
  ac.abort();
  const t0 = Date.now();
  while (up.st.seen.length < 2 && Date.now() - t0 < 2000) await sleep(20);
  assert.equal(up.st.seen.length, 2, 'queued request proceeds after abort');
  ac2.abort();
  await second;
});

test('(e) client abort while queued removes it', async () => {
  const up = await fakeUpstream({ delay: 800 });
  const p = await startProxy(up.url);
  const first = get(`${p.url}/a`);
  await sleep(100);
  const ac = new AbortController();
  const q = fetch(`${p.url}/queued`, { signal: ac.signal }).catch(() => 'aborted');
  await sleep(100);
  assert.equal((await (await fetch(`${p.url}/__proxy/status`)).json()).queued, 1);
  ac.abort();
  await q;
  await sleep(100);
  assert.equal((await (await fetch(`${p.url}/__proxy/status`)).json()).queued, 0);
  await first;
  await sleep(100);
  assert.deepEqual(up.st.seen.map((s) => s.url), ['/a']);
});

test('(f) queue overflow -> 429', async () => {
  const up = await fakeUpstream({ delay: 600 });
  const p = await startProxy(up.url, ['--max-queue', '1']);
  const rs = await Promise.all([0, 1, 2].map(async (i) => { await sleep(i * 50); return get(`${p.url}/x`); }));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 429]);
  assert.equal(JSON.parse(rs[2].text).error.type, 'serial_proxy_error');
});

test('(g) queue timeout -> 503', async () => {
  const up = await fakeUpstream({ delay: 2500 });
  const p = await startProxy(up.url, ['--queue-timeout', '0.5']);
  const first = get(`${p.url}/x`);
  await sleep(100);
  const r = await get(`${p.url}/x`);
  assert.equal(r.status, 503);
  assert.equal((await first).status, 200);
});

test('(h) status endpoint', async () => {
  const up = await fakeUpstream({ delay: 500 });
  const p = await startProxy(up.url, ['--max', '1']);
  const first = get(`${p.url}/x`);
  await sleep(100);
  const s = await (await fetch(`${p.url}/__proxy/status`)).json();
  assert.deepEqual(s, { active: 1, queued: 0, max: 1, upstream: up.url });
  await first;
  assert.equal(up.st.total, 1, 'status must not be forwarded');
});

test('(i) Authorization passes unchanged', async () => {
  const up = await fakeUpstream({ delay: 20 });
  const p = await startProxy(up.url);
  await get(`${p.url}/x`, { headers: { authorization: 'Bearer sk-test-123' } });
  assert.equal(up.st.seen[0].auth, 'Bearer sk-test-123');
});

test('(j) path mapping for both baseURL styles', async () => {
  const up = await fakeUpstream({ delay: 20 });
  const p = await startProxy(`${up.url}/v1`);
  await get(`${p.url}/chat/completions?a=1`);
  await get(`${p.url}/v1/chat/completions?a=1`);
  assert.deepEqual(up.st.seen.map((s) => s.url), ['/v1/chat/completions?a=1', '/v1/chat/completions?a=1']);
});

test('refuses non-loopback host without --allow-remote', async () => {
  const child = spawn(process.execPath, [SCRIPT, '--upstream', 'http://127.0.0.1:1', '--host', '0.0.0.0'], { stdio: 'ignore' });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 2);
});

test('(k) IPv6 upstream literals are passed to Node without brackets', async (t) => {
  let up;
  try {
    up = await fakeUpstream({ delay: 20, host: '::1' });
  } catch (error) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EACCES'].includes(error.code)) {
      t.skip(`IPv6 loopback is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const p = await startProxy(up.url);
  const r = await get(`${p.url}/ipv6`);
  assert.equal(r.status, 200);
  assert.deepEqual(up.st.seen.map((item) => item.url), ['/ipv6']);
});

test('(l) response piping pauses the upstream while the destination is backpressured', async () => {
  const totalChunks = 100;
  let produced = 0;
  const source = new Readable({
    highWaterMark: 1,
    read() {
      if (produced === totalChunks) { this.push(null); return; }
      produced++;
      this.push(Buffer.alloc(8));
    },
  });
  let firstWriteResolve;
  const firstWrite = new Promise((resolve) => { firstWriteResolve = resolve; });
  let receivedChunks = 0;
  const sink = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      receivedChunks++;
      if (receivedChunks === 1) firstWriteResolve();
      if (receivedChunks === 1) setTimeout(callback, 50);
      else setImmediate(callback);
    },
  });
  pipeUpstreamResponse(source, sink);
  await firstWrite;
  await sleep(5);
  assert.equal(source.isPaused(), true);
  assert.ok(produced < totalChunks);
  await new Promise((resolve) => sink.once('finish', resolve));
  assert.equal(receivedChunks, totalChunks);
});

test('(m) a large queued POST can finish within queue wait plus body grace', async () => {
  const up = await fakeUpstream({ delay: 800 });
  const p = await startProxyServer(up.url, { queueTimeout: 1.5, requestBodyGraceMs: 1000, requestHeadersTimeoutMs: 100 });
  assert.equal(p.server.requestTimeout, 2600);
  assert.equal(p.server.headersTimeout, 100);
  const first = get(`${p.url}/first`);
  await sleep(100);
  const body = Buffer.alloc(1024 * 1024, 0x61);
  const second = postSlow(`${p.url}/upload`, body);
  const queuedAt = Date.now();
  while (p.server.sem.queued !== 1 && Date.now() - queuedAt < 500) await sleep(10);
  assert.equal(p.server.sem.queued, 1, 'large POST waits behind the active request');
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(up.st.receivedBytes, body.length);
});

test('(n) queued HTTP requests reach the upstream in FIFO order', async (t) => {
  let releaseHold;
  const hold = new Promise((resolve) => { releaseHold = resolve; });
  t.after(() => releaseHold());
  const served = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/v1/hold') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('ready');
      await hold;
      res.end('done');
      return;
    }
    served.push(req.url);
    res.end(req.url);
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const p = await startProxyServer(`http://127.0.0.1:${upstream.address().port}/v1`, { max: 1 });
  const heldResponse = await fetch(`${p.url}/hold`);
  const reader = heldResponse.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'ready');

  const waitForQueued = async (expected) => {
    const deadline = Date.now() + 2000;
    let status;
    do {
      status = await (await fetch(`${p.url}/__proxy/status`)).json();
      if (status.queued === expected) return status;
      await sleep(5);
    } while (Date.now() < deadline);
    assert.equal(status.queued, expected, 'requests must enter the queue before the held response completes');
  };
  const first = get(`${p.url}/first`);
  assert.equal((await waitForQueued(1)).active, 1);
  const second = get(`${p.url}/second`);
  assert.equal((await waitForQueued(2)).active, 1);
  assert.deepEqual(served, [], 'queued requests must not reach the upstream yet');

  releaseHold();
  while (!(await reader.read()).done);
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.deepEqual(responses.map((response) => response.text), ['/v1/first', '/v1/second']);
  assert.deepEqual(served, ['/v1/first', '/v1/second']);
  const status = await (await fetch(`${p.url}/__proxy/status`)).json();
  assert.equal(status.active, 0);
  assert.equal(status.queued, 0);
});

test('(o) five direct HTTP requests overlap while the proxy caps the same upstream at one', async (t) => {
  let active = 0, peak = 0, total = 0, directCount = 0;
  let releaseDirect, markDirectReady;
  const directReleased = new Promise((resolve) => { releaseDirect = resolve; });
  const directReady = new Promise((resolve) => { markDirectReady = resolve; });
  t.after(() => releaseDirect());
  const upstream = http.createServer(async (req, res) => {
    active++;
    total++;
    peak = Math.max(peak, active);
    if (req.url.includes('direct=')) {
      directCount++;
      if (directCount === 5) markDirectReady();
      await directReleased;
    } else {
      await sleep(20);
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.url);
    active--;
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const direct = Promise.all(Array.from({ length: 5 }, (_, index) => get(`${upstreamUrl}/v1/chat/completions?direct=${index}`)));
  let timer;
  try {
    await Promise.race([
      directReady,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('five direct HTTP requests did not overlap')), 2000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(active, 5);
  assert.equal(peak, 5);
  releaseDirect();
  const directResponses = await direct;
  assert.ok(directResponses.every((response) => response.status === 200));
  assert.equal(total, 5);
  assert.equal(active, 0);

  peak = 0;
  total = 0;
  const p = await startProxyServer(`${upstreamUrl}/v1`, { max: 1 });
  const proxiedResponses = await Promise.all(Array.from({ length: 5 }, (_, index) => get(`${p.url}/chat/completions?proxied=${index}`)));
  assert.ok(proxiedResponses.every((response) => response.status === 200));
  assert.deepEqual(proxiedResponses.map((response) => response.text), Array.from({ length: 5 }, (_, index) => `/v1/chat/completions?proxied=${index}`));
  assert.equal(peak, 1);
  assert.equal(total, 5);
  assert.equal(active, 0);
});
