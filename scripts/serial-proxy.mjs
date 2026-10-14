#!/usr/bin/env node
// Concurrency-limiting reverse proxy (zero dependencies). See docs/SERIAL-PROXY.md.
import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const DEFAULT_REQUEST_BODY_GRACE_MS = 300_000;
const DEFAULT_REQUEST_HEADERS_TIMEOUT_MS = 60_000;
const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection']);
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const RPM_WINDOW_MS = 60_000;
const TOOL_CHOICES = new Set(['none', 'auto', 'required']);
const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function pipeUpstreamResponse(upRes, res) {
  upRes.pipe(res);
}

/** Map a client request path (with query) onto the upstream base path. */
export function mapPath(base, urlPath) {
  const b = base.replace(/\/+$/, '');
  const qi = urlPath.indexOf('?');
  let p = qi < 0 ? urlPath : urlPath.slice(0, qi);
  const q = qi < 0 ? '' : urlPath.slice(qi);
  if (b && (p === b || p.startsWith(b + '/'))) p = p.slice(b.length);
  if (!p.startsWith('/')) p = '/' + p;
  return (b + p).replace(/^$/, '/') + q;
}

export class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.queue = []; }
  get queued() { return this.queue.length; }
  /** Resolves with a release function (idempotent). Returns {promise, cancel}. */
  acquire() {
    let waiter;
    const makeRelease = () => {
      let done = false;
      return () => { if (done) return; done = true; this.active--; this.#drain(); };
    };
    const promise = new Promise((resolve) => {
      waiter = { resolve: () => { this.active++; resolve(makeRelease()); } };
    });
    this.queue.push(waiter);
    this.#drain();
    return { promise, cancel: () => { const i = this.queue.indexOf(waiter); if (i >= 0) { this.queue.splice(i, 1); return true; } return false; } };
  }
  #drain() {
    while (this.active < this.max && this.queue.length) this.queue.shift().resolve();
  }
}

/** Fixed 60-second window limiter. The window opens at the first dispatch and the count is taken at dispatch. FIFO. */
export class RateWindow {
  #start = 0; #count = 0; #waiters = []; #timer = null;
  constructor(limit, clock = realClock) { this.limit = limit; this.clock = clock; }
  #roll() { if (this.#count > 0 && this.clock.now() >= this.#start + RPM_WINDOW_MS) this.#count = 0; }
  snapshot() {
    this.#roll();
    const full = this.#count >= this.limit;
    return { rpm: this.limit, window_count: this.#count, next_slot_in: full ? Math.max(0, Math.ceil((this.#start + RPM_WINDOW_MS - this.clock.now()) / 1000)) : 0 };
  }
  /** Resolves once a dispatch is allowed (and counted). cancel() returns true if it was still waiting. */
  acquire() {
    let waiter;
    const promise = new Promise((resolve) => { waiter = { resolve }; });
    this.#waiters.push(waiter);
    this.#pump();
    return { promise, cancel: () => { const i = this.#waiters.indexOf(waiter); if (i >= 0) { this.#waiters.splice(i, 1); return true; } return false; } };
  }
  #pump() {
    if (this.#timer) { this.clock.clearTimeout(this.#timer); this.#timer = null; }
    while (this.#waiters.length) {
      this.#roll();
      if (this.#count >= this.limit) {
        const wait = Math.max(0, this.#start + RPM_WINDOW_MS - this.clock.now());
        this.#timer = this.clock.setTimeout(() => { this.#timer = null; this.#pump(); }, wait);
        this.#timer?.unref?.();
        return;
      }
      if (this.#count === 0) this.#start = this.clock.now();
      this.#count++;
      this.#waiters.shift().resolve();
    }
  }
}

/**
 * Read at most `cap` bytes of the request body. Bytes beyond the cap are never held:
 * the stream is paused and the overflowing chunk is pushed back so a later pipe() sees it.
 * Resolves {chunks, complete, closed}; `closed` means the client went away mid-body.
 */
function bufferBody(req, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0, settled = false;
    const finish = (r) => {
      if (settled) return; settled = true;
      req.off('data', onData); req.off('end', onEnd); req.off('close', onClose); req.off('error', onClose);
      resolve({ chunks, ...r });
    };
    const onData = (chunk) => {
      if (total + chunk.length > cap) { req.pause(); req.unshift(chunk); finish({ complete: false, closed: false }); return; }
      total += chunk.length; chunks.push(chunk);
    };
    const onEnd = () => finish({ complete: true, closed: false });
    const onClose = () => finish({ complete: false, closed: true });
    req.on('data', onData); req.once('end', onEnd); req.once('close', onClose); req.once('error', onClose);
  });
}

const isJsonContentType = (ct) => /^application\/(?:[\w.+-]*\+)?json\s*(?:;\s*charset\s*=\s*"?utf-?8"?\s*)?$/i.test(String(ct ?? '').trim());

/** Returns the rewritten body Buffer, or null when the body must be forwarded unchanged. */
function defaultToolChoice(buf, value) {
  let obj;
  try { obj = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)); } catch { return null; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!Array.isArray(obj.tools) || obj.tools.length === 0 || Object.hasOwn(obj, 'tool_choice')) return null;
  obj.tool_choice = value;
  return Buffer.from(JSON.stringify(obj));
}

function jsonError(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ error: { message, type: 'serial_proxy_error' } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createProxy({ upstream, max = 1, queueTimeout = 600, maxQueue = 64, log = () => {}, requestBodyGraceMs = DEFAULT_REQUEST_BODY_GRACE_MS, requestHeadersTimeoutMs = DEFAULT_REQUEST_HEADERS_TIMEOUT_MS, toolChoiceDefault = null, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, rpm = null, clock = realClock }) {
  const up = new URL(upstream);
  const lib = up.protocol === 'https:' ? https : http;
  const sem = new Semaphore(max);
  if (!Number.isFinite(queueTimeout) || queueTimeout <= 0) throw new TypeError('queueTimeout must be a positive number');
  if (!Number.isSafeInteger(requestBodyGraceMs) || requestBodyGraceMs < 0) throw new TypeError('requestBodyGraceMs must be a non-negative integer');
  if (!Number.isSafeInteger(requestHeadersTimeoutMs) || requestHeadersTimeoutMs <= 0) throw new TypeError('requestHeadersTimeoutMs must be a positive integer');
  if (toolChoiceDefault !== null && !TOOL_CHOICES.has(toolChoiceDefault)) throw new TypeError('toolChoiceDefault must be none, auto or required');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new TypeError('maxBodyBytes must be a positive integer');
  if (rpm !== null && (!Number.isSafeInteger(rpm) || rpm <= 0)) throw new TypeError('rpm must be a positive integer');
  const limiter = rpm === null ? null : new RateWindow(rpm, clock);
  // With --rpm the request body may stay unread while it waits for a window, so allow one more queue wait.
  const requestTimeout = requestHeadersTimeoutMs + Math.ceil(queueTimeout * 1000) * (limiter ? 2 : 1) + requestBodyGraceMs;
  let nextId = 0;

  const server = http.createServer({ headersTimeout: requestHeadersTimeoutMs, requestTimeout }, (req, res) => {
    const t0 = Date.now();
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/__proxy/status') {
      const body = JSON.stringify({ active: sem.active, queued: sem.queued, max, upstream: up.origin, ...(limiter ? limiter.snapshot() : {}) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    const id = ++nextId;
    let waitMs = 0, status = 0, finished = false;
    const done = (s) => { if (finished) return; finished = true; log(`${req.method} ${path} ${s ?? status} wait=${waitMs}ms dur=${Date.now() - t0 - waitMs}ms id=${id}`); };

    if (sem.queued >= maxQueue && sem.active >= max) {
      jsonError(res, 429, 'serial-proxy queue is full');
      done(429);
      return;
    }
    const slot = sem.acquire();
    let release = null, aborted = false, upReq = null, timer = null, rpmWait = null;
    const cleanup = () => { if (timer) { clock.clearTimeout(timer); timer = null; } if (release) { const r = release; release = null; r(); } };
    const abort = () => {
      if (aborted) return; aborted = true;
      if (!release) { slot.cancel(); }
      if (rpmWait) rpmWait.cancel();
      if (upReq) upReq.destroy();
      cleanup();
      done(status || 499);
    };
    res.on('close', () => { if (!res.writableFinished) abort(); else cleanup(); });
    req.on('error', () => {});

    timer = clock.setTimeout(() => {
      timer = null;
      if (slot.cancel()) { aborted = true; jsonError(res, 503, 'serial-proxy queue timeout'); done(503); }
    }, queueTimeout * 1000);

    slot.promise.then(async (rel) => {
      if (aborted) { rel(); return; }
      release = rel;
      if (timer) { clock.clearTimeout(timer); timer = null; }
      waitMs = Date.now() - t0;
      // Body inspection happens only after a slot is held (like the streaming path, the body is not read while
      // queued, so queued requests never pile up buffers), and before the rpm wait so the counted dispatch is the real one.
      let pre = null;
      if (toolChoiceDefault && req.method === 'POST' && mapPath(up.pathname, req.url).split('?')[0].endsWith('/chat/completions')
        && isJsonContentType(req.headers['content-type']) && !req.headers['content-encoding'] && !(Number(req.headers['content-length']) > maxBodyBytes)) {
        pre = await bufferBody(req, maxBodyBytes);
        if (pre.closed || aborted) return;
      }
      if (limiter) {
        const tw = Date.now();
        rpmWait = limiter.acquire();
        timer = clock.setTimeout(() => {
          timer = null;
          if (rpmWait.cancel()) { aborted = true; jsonError(res, 503, 'serial-proxy queue timeout'); cleanup(); done(503); }
        }, queueTimeout * 1000);
        await rpmWait.promise;
        rpmWait = null;
        if (timer) { clock.clearTimeout(timer); timer = null; }
        waitMs += Date.now() - tw;
        if (aborted) return;
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
      headers.host = up.host;
      let rewritten = null;
      if (pre?.complete) {
        rewritten = defaultToolChoice(Buffer.concat(pre.chunks), toolChoiceDefault);
        if (rewritten) { headers['content-length'] = rewritten.length; log(`tool_choice defaulted id=${id}`); }
      }
      upReq = lib.request({
        protocol: up.protocol, hostname: up.hostname.startsWith('[') && up.hostname.endsWith(']') ? up.hostname.slice(1, -1) : up.hostname, port: up.port || undefined,
        method: req.method, path: mapPath(up.pathname, req.url), headers,
      }, (upRes) => {
        status = upRes.statusCode;
        const rh = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k)) rh[k] = v;
        res.writeHead(upRes.statusCode, upRes.statusMessage, rh);
        res.flushHeaders();
        upRes.on('end', () => { cleanup(); done(); });
        upRes.on('error', () => { res.destroy(); cleanup(); done(502); });
        upRes.on('aborted', () => { res.destroy(); cleanup(); done(502); });
        pipeUpstreamResponse(upRes, res);
      });
      upReq.on('error', (e) => {
        if (aborted) return;
        if (!res.headersSent) jsonError(res, 502, `upstream error: ${e.code || e.message}`); else res.destroy();
        cleanup(); done(502);
      });
      if (pre?.complete) upReq.end(rewritten ?? Buffer.concat(pre.chunks));
      else if (pre) { upReq.write(Buffer.concat(pre.chunks)); req.pipe(upReq); }
      else req.pipe(upReq);
    });
  });
  server.sem = sem;
  return server;
}

function main() {
  const { values: v } = parseArgs({
    options: {
      upstream: { type: 'string' }, port: { type: 'string', default: '18080' }, host: { type: 'string', default: '127.0.0.1' },
      'allow-remote': { type: 'boolean', default: false }, max: { type: 'string', default: '1' },
      'queue-timeout': { type: 'string', default: '600' }, 'max-queue': { type: 'string', default: '64' },
      'tool-choice-default': { type: 'string' }, 'max-body-bytes': { type: 'string', default: String(DEFAULT_MAX_BODY_BYTES) }, rpm: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const die = (m) => { process.stderr.write(`serial-proxy: ${m}\n`); process.exit(2); };
  if (v.help || !v.upstream) die('usage: serial-proxy.mjs --upstream <url> [--port 18080] [--host 127.0.0.1] [--allow-remote] [--max 1] [--queue-timeout 600] [--max-queue 64] [--tool-choice-default none|auto|required] [--max-body-bytes 8388608] [--rpm <n>]');
  let u; try { u = new URL(v.upstream); } catch { die('invalid --upstream'); }
  if (!/^https?:$/.test(u.protocol)) die('--upstream must be http(s)');
  if (!LOOPBACK.has(v.host) && !v['allow-remote']) die('refusing non-loopback --host without --allow-remote');
  const num = (name, min) => { const n = Number(v[name]); if (!Number.isInteger(n) || n < min) die(`invalid --${name}`); return n; };
  const port = num('port', 0), max = num('max', 1), maxQueue = num('max-queue', 0);
  const queueTimeout = Number(v['queue-timeout']);
  if (!(queueTimeout > 0)) die('invalid --queue-timeout');
  const toolChoiceDefault = v['tool-choice-default'] ?? null;
  if (toolChoiceDefault !== null && !TOOL_CHOICES.has(toolChoiceDefault)) die('invalid --tool-choice-default (none, auto or required)');
  const maxBodyBytes = num('max-body-bytes', 1);
  const rpm = v.rpm === undefined ? null : num('rpm', 1);
  const server = createProxy({ upstream: v.upstream, max, queueTimeout, maxQueue, toolChoiceDefault, maxBodyBytes, rpm, log: (l) => process.stderr.write(l + '\n') });
  server.listen(port, v.host, () => {
    const a = server.address();
    const h = a.family === 'IPv6' ? `[${a.address}]` : a.address;
    process.stderr.write(`serial-proxy listening on http://${h}:${a.port} -> ${u.origin}${u.pathname} (max=${max}${rpm ? ` rpm=${rpm}` : ''}${toolChoiceDefault ? ` tool-choice-default=${toolChoiceDefault}` : ''})\n`);
  });
  const stop = () => { server.close(() => process.exit(0)); server.closeAllConnections?.(); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
