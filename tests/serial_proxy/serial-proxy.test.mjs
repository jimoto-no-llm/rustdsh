import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/serial-proxy.mjs');
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fakeUpstream({ delay = 150 } = {}) {
  const st = { inflight: 0, peak: 0, total: 0, seen: [], finished: 0 };
  const server = http.createServer((req, res) => {
    st.inflight++; st.total++; st.peak = Math.max(st.peak, st.inflight);
    st.seen.push({ url: req.url, auth: req.headers.authorization });
    let ended = false;
    const end = () => { if (!ended) { ended = true; st.inflight--; } };
    res.on('close', end);
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: 1\n\n');
    const t1 = setTimeout(() => res.write('data: 2\n\n'), delay / 2);
    const t2 = setTimeout(() => { res.end('data: 3\n\n'); st.finished++; }, delay);
    res.on('close', () => { clearTimeout(t1); clearTimeout(t2); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { st, url: `http://127.0.0.1:${server.address().port}` };
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
