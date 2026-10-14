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

// ---- --tool-choice-default / --rpm (#489) ----

function fakeClock(start = 1_000_000) {
  let now = start, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        timers.delete(next.id); now = Math.max(now, next.t.at); next.t.fn();
      }
      now = target;
    },
  };
}

async function until(cond, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('until: timeout'); await sleep(5); }
}

/** Upstream that records raw request bodies. `sseDelay` > 0 streams a 2-event response with a pause between. */
async function captureUpstream({ sseDelay = 0, now = () => Date.now() } = {}) {
  const st = { seen: [], finished: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      st.seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks), at: now() });
      if (!sseDelay) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); st.finished++; return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      const t = setTimeout(() => { res.end('data: 2\n\n'); st.finished++; }, sseDelay);
      res.on('close', () => clearTimeout(t));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanups.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { st, url: `http://127.0.0.1:${server.address().port}` };
}

/** POST pieces one by one. Without content-length the request is sent chunked. */
function rawPost(url, pieces, headers = {}) {
  return new Promise((resolve, reject) => {
    const list = (Array.isArray(pieces) ? pieces : [pieces]).map((p) => Buffer.from(p));
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    (async () => { for (const p of list) { req.write(p); await sleep(5); } req.end(); })();
  });
}

const JSON_CT = { 'content-type': 'application/json' };
const TOOLS = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }];
const CHAT = '/v1/chat/completions';

async function tcProxy(options = {}, upOptions = {}) {
  const up = await captureUpstream(upOptions);
  const logs = [];
  const p = await startProxyServer(up.url, { toolChoiceDefault: 'auto', log: (l) => logs.push(l), ...options });
  return { up, p, logs };
}

test('(tc-1) defaults tool_choice only for non-empty tools without tool_choice, with a correct content-length', async () => {
  const { up, p, logs } = await tcProxy();
  const original = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'こんにちは' }], tools: TOOLS });
  const r = await rawPost(`${p.url}${CHAT}`, original, { ...JSON_CT, 'content-length': Buffer.byteLength(original) });
  assert.equal(r.status, 200);
  const got = up.st.seen[0];
  assert.deepEqual(JSON.parse(got.body), { ...JSON.parse(original), tool_choice: 'auto' });
  assert.match(got.body.toString(), /"tool_choice":"auto"/);
  assert.equal(Number(got.headers['content-length']), got.body.length);
  assert.equal(got.headers['transfer-encoding'], undefined);
  assert.ok(logs.some((l) => /^tool_choice defaulted id=\d+$/.test(l)));
});

test('(tc-1b) a chunked client request is rewritten with content-length and no transfer-encoding', async () => {
  const { up, p } = await tcProxy({ toolChoiceDefault: 'none' });
  const body = JSON.stringify({ model: 'm', tools: TOOLS });
  await rawPost(`${p.url}/chat/completions`, [body.slice(0, 10), body.slice(10)], JSON_CT);
  const got = up.st.seen[0];
  assert.equal(got.url, '/chat/completions');
  assert.equal(JSON.parse(got.body).tool_choice, 'none');
  assert.equal(Number(got.headers['content-length']), got.body.length);
  assert.equal(got.headers['transfer-encoding'], undefined);
});

test('(tc-2) every other request reaches the upstream byte-identical', async () => {
  const { up, p, logs } = await tcProxy({ maxBodyBytes: 300 });
  const odd = (o) => ` {  "model" : "m" ,\n "tools":${JSON.stringify(o.tools)}${o.extra ?? ''} } `;
  const cases = [
    ['existing tool_choice', CHAT, JSON_CT, odd({ tools: TOOLS, extra: ',"tool_choice":"required"' })],
    ['existing tool_choice null', CHAT, JSON_CT, odd({ tools: TOOLS, extra: ',"tool_choice":null' })],
    ['no tools', CHAT, JSON_CT, '{ "model" : "m", "messages":[] }'],
    ['empty tools', CHAT, JSON_CT, odd({ tools: [] })],
    ['tools not an array', CHAT, JSON_CT, '{"tools":{"a":1}}'],
    ['top-level array', CHAT, JSON_CT, '[{"tools":[1]}]'],
    ['embeddings path', '/v1/embeddings', JSON_CT, odd({ tools: TOOLS })],
    ['non-json content-type', CHAT, { 'content-type': 'text/plain' }, odd({ tools: TOOLS })],
    ['no content-type', CHAT, {}, odd({ tools: TOOLS })],
    ['invalid json', CHAT, JSON_CT, '{"tools":[1,'],
    ['invalid utf-8', CHAT, JSON_CT, Buffer.concat([Buffer.from('{"tools":[1],"x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')])],
    ['utf-8 bom', CHAT, JSON_CT, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"tools":[1]}')])],
    ['oversized (content-length)', CHAT, JSON_CT, odd({ tools: TOOLS }) + ' '.repeat(400)],
  ];
  for (const [name, url, headers, body] of cases) {
    const buf = Buffer.from(body);
    const r = await rawPost(`${p.url}${url}`, buf, { ...headers, 'content-length': buf.length });
    assert.equal(r.status, 200, name);
    assert.ok(up.st.seen.at(-1).body.equals(buf), `${name}: body must be unchanged`);
  }
  // oversized and chunked: the cap is exceeded mid-stream, everything must still arrive in order
  const big = Buffer.from(odd({ tools: TOOLS }) + 'x'.repeat(2000));
  const pieces = []; for (let i = 0; i < big.length; i += 100) pieces.push(big.subarray(i, i + 100));
  await rawPost(`${p.url}${CHAT}`, pieces, JSON_CT);
  assert.ok(up.st.seen.at(-1).body.equals(big), 'oversized chunked body must be unchanged');
  // GET with a JSON content-type
  const g = await fetch(`${p.url}${CHAT}`, { headers: JSON_CT });
  assert.equal(g.status, 200);
  assert.equal(up.st.seen.at(-1).method, 'GET');
  assert.equal(up.st.seen.at(-1).body.length, 0);
  assert.equal(logs.filter((l) => l.includes('defaulted')).length, 0);
});

test('(tc-3) without the option nothing is buffered or rewritten', async () => {
  const up = await captureUpstream();
  const p = await startProxyServer(up.url);
  const body = Buffer.from(JSON.stringify({ model: 'm', tools: TOOLS }));
  await rawPost(`${p.url}${CHAT}`, body, { ...JSON_CT, 'content-length': body.length });
  assert.ok(up.st.seen[0].body.equals(body));
  assert.equal((await (await fetch(`${p.url}/__proxy/status`)).json()).rpm, undefined, 'no rpm fields without --rpm');
});

test('(tc-4) the SSE response is still streamed incrementally after a rewritten request', async () => {
  const { up, p } = await tcProxy({}, { sseDelay: 600 });
  const body = JSON.stringify({ model: 'm', stream: true, tools: TOOLS });
  const r = await fetch(`${p.url}${CHAT}`, { method: 'POST', headers: JSON_CT, body });
  const reader = r.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString(), /data: 1/);
  assert.equal(up.st.finished, 0, 'upstream must still be running');
  assert.match(up.st.seen[0].body.toString(), /"tool_choice":"auto"/);
  while (!(await reader.read()).done);
});

test('(tc-5) the body is read only once a slot is held; a queued client disconnect leaves no trace', async () => {
  const { up, p } = await tcProxy({ max: 1 }, { sseDelay: 500 });
  const body = JSON.stringify({ tools: TOOLS });
  const first = rawPost(`${p.url}${CHAT}`, body, JSON_CT);
  await until(() => up.st.seen.length === 1);
  const req = http.request(`${p.url}${CHAT}`, { method: 'POST', headers: JSON_CT });
  req.on('error', () => {}); req.write(body.slice(0, 5));
  await until(() => p.server.sem.queued === 1);
  req.destroy();
  await until(() => p.server.sem.queued === 0);
  await first;
  assert.equal(up.st.seen.length, 1);
});

test('(tc-6) logs, status and error bodies never contain request bodies or the Authorization value', async () => {
  const clock = fakeClock();
  const { up, p, logs } = await tcProxy({ clock, rpm: 1, queueTimeout: 5 });
  const secret = 'SECRET-PROMPT-TEXT', key = 'sk-very-secret-key';
  const body = JSON.stringify({ messages: [{ role: 'user', content: secret }], tools: TOOLS });
  const headers = { ...JSON_CT, authorization: `Bearer ${key}` };
  await rawPost(`${p.url}${CHAT}`, body, headers);
  const second = rawPost(`${p.url}${CHAT}`, body, headers);
  await until(() => p.server.sem.active === 1);
  await sleep(30);
  const status = await (await fetch(`${p.url}/__proxy/status`)).text();
  clock.advance(5000);
  const err = await second;
  assert.equal(err.status, 503);
  const all = [...logs, status, err.text].join('\n');
  assert.ok(!all.includes(secret) && !all.includes(key), 'no body text or credentials in logs/status/errors');
  assert.equal(up.st.seen[0].headers.authorization, `Bearer ${key}`);
});

test('(rpm-1) --rpm 2 with 5 requests: no 60s window holds more than 2 dispatches', async () => {
  const clock = fakeClock();
  const { up, p } = await tcProxy({ clock, rpm: 2, max: 5, toolChoiceDefault: null }, { now: clock.now });
  const rs = Array.from({ length: 5 }, () => get(`${p.url}/x`));
  await until(() => up.st.seen.length === 2);
  await sleep(50);
  assert.equal(up.st.seen.length, 2, 'the third request waits for the next window');
  const s = await (await fetch(`${p.url}/__proxy/status`)).json();
  assert.equal(s.rpm, 2);
  assert.equal(s.window_count, 2);
  assert.equal(s.next_slot_in, 60);
  clock.advance(30_000);
  assert.equal((await (await fetch(`${p.url}/__proxy/status`)).json()).next_slot_in, 30);
  clock.advance(30_000);
  await until(() => up.st.seen.length === 4);
  await sleep(50);
  assert.equal(up.st.seen.length, 4);
  clock.advance(60_000);
  await until(() => up.st.seen.length === 5);
  const results = await Promise.all(rs);
  assert.ok(results.every((r) => r.status === 200));
  const perWindow = new Map();
  for (const { at } of up.st.seen) { const w = Math.floor((at - up.st.seen[0].at) / 60_000); perWindow.set(w, (perWindow.get(w) ?? 0) + 1); }
  assert.ok([...perWindow.values()].every((n) => n <= 2), JSON.stringify([...perWindow]));
});

test('(rpm-2) a waiting request that disconnects frees its slot and is never dispatched', async () => {
  const clock = fakeClock();
  const { up, p } = await tcProxy({ clock, rpm: 1, max: 5, toolChoiceDefault: null });
  await get(`${p.url}/a`);
  const ac = new AbortController();
  const waiting = fetch(`${p.url}/b`, { signal: ac.signal }).catch(() => 'aborted');
  await until(() => p.server.sem.active === 1);
  ac.abort();
  assert.equal(await waiting, 'aborted');
  await until(() => p.server.sem.active === 0);
  clock.advance(60_000);
  await sleep(50);
  assert.equal(up.st.seen.length, 1, 'the aborted request must not be dispatched');
  assert.equal((await get(`${p.url}/c`)).status, 200);
  assert.deepEqual(up.st.seen.map((s) => s.url), ['/a', '/c']);
});

test('(rpm-3) queue timeout while waiting for the window -> 503, nothing dispatched later', async () => {
  const clock = fakeClock();
  const { up, p } = await tcProxy({ clock, rpm: 1, max: 5, queueTimeout: 20, toolChoiceDefault: null });
  await get(`${p.url}/a`);
  const waiting = get(`${p.url}/b`);
  await until(() => p.server.sem.active === 1);
  clock.advance(20_000);
  const r = await waiting;
  assert.equal(r.status, 503);
  assert.equal(JSON.parse(r.text).error.type, 'serial_proxy_error');
  assert.equal(p.server.sem.active, 0);
  clock.advance(60_000);
  await sleep(50);
  assert.equal(up.st.seen.length, 1);
});

test('(rpm-4) rpm waiters hold FIFO order and combine with --max 1', async () => {
  const clock = fakeClock();
  const { up, p } = await tcProxy({ clock, rpm: 1, max: 1, toolChoiceDefault: null });
  const rs = ['/1', '/2', '/3'].map((u, i) => sleep(i * 20).then(() => get(`${p.url}${u}`)));
  await until(() => up.st.seen.length === 1);
  for (let i = 0; i < 2; i++) { await sleep(60); clock.advance(60_000); }
  await Promise.all(rs);
  assert.deepEqual(up.st.seen.map((s) => s.url), ['/1', '/2', '/3']);
});

test('(cli) bad values are usage errors; the CLI rewrites end to end', async () => {
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--upstream', 'http://127.0.0.1:1', '--port', '0', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, err }));
  });
  for (const args of [['--tool-choice-default', 'any'], ['--tool-choice-default', ''], ['--rpm', '0'], ['--rpm', 'abc'], ['--rpm', '1.5'], ['--rpm=-1'], ['--max-body-bytes', '0'], ['--max-body-bytes', 'x']]) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /serial-proxy: /);
  }
  const up = await captureUpstream();
  const p = await startProxy(up.url, ['--tool-choice-default', 'auto', '--rpm', '6']);
  const body = JSON.stringify({ tools: TOOLS });
  assert.equal((await rawPost(`${p.url}${CHAT}`, body, JSON_CT)).status, 200);
  assert.equal(JSON.parse(up.st.seen[0].body).tool_choice, 'auto');
  const s = await (await fetch(`${p.url}/__proxy/status`)).json();
  assert.equal(s.rpm, 6);
  assert.equal(s.window_count, 1);
});

test('createProxy validates the new options', () => {
  const up = 'http://127.0.0.1:1';
  assert.throws(() => createProxy({ upstream: up, toolChoiceDefault: 'any' }), TypeError);
  assert.throws(() => createProxy({ upstream: up, maxBodyBytes: 0 }), TypeError);
  assert.throws(() => createProxy({ upstream: up, rpm: 0 }), TypeError);
  assert.throws(() => createProxy({ upstream: up, rpm: 1.5 }), TypeError);
});
