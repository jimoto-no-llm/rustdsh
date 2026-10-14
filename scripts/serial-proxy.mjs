#!/usr/bin/env node
// Concurrency-limiting reverse proxy (zero dependencies). See docs/SERIAL-PROXY.md.
import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const DEFAULT_REQUEST_BODY_GRACE_MS = 300_000;
const DEFAULT_REQUEST_HEADERS_TIMEOUT_MS = 60_000;
const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection']);
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

function jsonError(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ error: { message, type: 'serial_proxy_error' } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createProxy({ upstream, max = 1, queueTimeout = 600, maxQueue = 64, log = () => {}, requestBodyGraceMs = DEFAULT_REQUEST_BODY_GRACE_MS, requestHeadersTimeoutMs = DEFAULT_REQUEST_HEADERS_TIMEOUT_MS }) {
  const up = new URL(upstream);
  const lib = up.protocol === 'https:' ? https : http;
  const sem = new Semaphore(max);
  if (!Number.isFinite(queueTimeout) || queueTimeout <= 0) throw new TypeError('queueTimeout must be a positive number');
  if (!Number.isSafeInteger(requestBodyGraceMs) || requestBodyGraceMs < 0) throw new TypeError('requestBodyGraceMs must be a non-negative integer');
  if (!Number.isSafeInteger(requestHeadersTimeoutMs) || requestHeadersTimeoutMs <= 0) throw new TypeError('requestHeadersTimeoutMs must be a positive integer');
  const requestTimeout = requestHeadersTimeoutMs + Math.ceil(queueTimeout * 1000) + requestBodyGraceMs;

  const server = http.createServer({ headersTimeout: requestHeadersTimeoutMs, requestTimeout }, (req, res) => {
    const t0 = Date.now();
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/__proxy/status') {
      const body = JSON.stringify({ active: sem.active, queued: sem.queued, max, upstream: up.origin });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    let waitMs = 0, status = 0, finished = false;
    const done = (s) => { if (finished) return; finished = true; log(`${req.method} ${path} ${s ?? status} wait=${waitMs}ms dur=${Date.now() - t0 - waitMs}ms`); };

    if (sem.queued >= maxQueue && sem.active >= max) {
      jsonError(res, 429, 'serial-proxy queue is full');
      done(429);
      return;
    }
    const slot = sem.acquire();
    let release = null, aborted = false, upReq = null, timer = null;
    const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } if (release) { const r = release; release = null; r(); } };
    const abort = () => {
      if (aborted) return; aborted = true;
      if (!release) { slot.cancel(); }
      if (upReq) upReq.destroy();
      cleanup();
      done(status || 499);
    };
    res.on('close', () => { if (!res.writableFinished) abort(); else cleanup(); });
    req.on('error', () => {});

    timer = setTimeout(() => {
      timer = null;
      if (slot.cancel()) { aborted = true; jsonError(res, 503, 'serial-proxy queue timeout'); done(503); }
    }, queueTimeout * 1000);

    slot.promise.then((rel) => {
      if (aborted) { rel(); return; }
      release = rel;
      if (timer) { clearTimeout(timer); timer = null; }
      waitMs = Date.now() - t0;
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
      headers.host = up.host;
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
      req.pipe(upReq);
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
      'queue-timeout': { type: 'string', default: '600' }, 'max-queue': { type: 'string', default: '64' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const die = (m) => { process.stderr.write(`serial-proxy: ${m}\n`); process.exit(2); };
  if (v.help || !v.upstream) die('usage: serial-proxy.mjs --upstream <url> [--port 18080] [--host 127.0.0.1] [--allow-remote] [--max 1] [--queue-timeout 600] [--max-queue 64]');
  let u; try { u = new URL(v.upstream); } catch { die('invalid --upstream'); }
  if (!/^https?:$/.test(u.protocol)) die('--upstream must be http(s)');
  if (!LOOPBACK.has(v.host) && !v['allow-remote']) die('refusing non-loopback --host without --allow-remote');
  const num = (name, min) => { const n = Number(v[name]); if (!Number.isInteger(n) || n < min) die(`invalid --${name}`); return n; };
  const port = num('port', 0), max = num('max', 1), maxQueue = num('max-queue', 0);
  const queueTimeout = Number(v['queue-timeout']);
  if (!(queueTimeout > 0)) die('invalid --queue-timeout');
  const server = createProxy({ upstream: v.upstream, max, queueTimeout, maxQueue, log: (l) => process.stderr.write(l + '\n') });
  server.listen(port, v.host, () => {
    const a = server.address();
    const h = a.family === 'IPv6' ? `[${a.address}]` : a.address;
    process.stderr.write(`serial-proxy listening on http://${h}:${a.port} -> ${u.origin}${u.pathname} (max=${max})\n`);
  });
  const stop = () => { server.close(() => process.exit(0)); server.closeAllConnections?.(); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
