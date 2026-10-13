#!/usr/bin/env node
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import net from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 3000,
  max: 1,
  maxQueue: 128,
  waitTimeoutMs: 60_000,
});

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const USAGE = [
  'Usage: node scripts/serial-proxy.mjs --upstream URL [options]',
  '',
  'Options:',
  '  --upstream URL         HTTP(S) provider base URL, such as https://api.example/v1',
  '  --host HOST            Listen host (default: 127.0.0.1)',
  '  --port PORT            Listen port (default: 3000)',
  '  --max COUNT            Maximum active upstream requests (default: 1)',
  '  --max-queue COUNT      Maximum waiting requests (default: 128)',
  '  --wait-timeout-ms MS   Queue wait timeout (default: 60000)',
  '  --allow-remote         Permit a non-loopback listen address',
  '  --help                 Show this help',
].join('\n');

function parseInteger(value, name, minimum, maximum) {
  if (!/^(0|[1-9]\d*)$/.test(String(value))) {
    throw new Error(name + ' must be an integer from ' + minimum + ' to ' + maximum);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(name + ' must be an integer from ' + minimum + ' to ' + maximum);
  }
  return parsed;
}

function isLoopbackHost(host) {
  const value = String(host).trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (value === 'localhost' || value === 'localhost.') return true;

  const family = net.isIP(value);
  if (family === 4) return Number(value.split('.')[0]) === 127;
  if (family === 6) {
    try {
      return new URL('http://[' + value + ']/').hostname.toLowerCase() === '[::1]';
    } catch {
      return false;
    }
  }
  return false;
}

function validateOptions(input) {
  const options = { ...DEFAULTS, ...input };
  if (typeof options.upstreamUrl !== 'string' || !options.upstreamUrl.trim()) {
    throw new Error('an --upstream URL is required');
  }

  let upstream;
  try {
    upstream = new URL(options.upstreamUrl);
  } catch {
    throw new Error('--upstream must be a valid HTTP(S) URL');
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error('--upstream must use HTTP or HTTPS');
  }
  if (upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('--upstream must not contain credentials, a query, or a fragment');
  }

  const host = String(options.host).trim().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('--host must not be empty');
  if (!options.allowRemote && !isLoopbackHost(host)) {
    throw new Error('a non-loopback --host requires --allow-remote');
  }

  return {
    ...options,
    upstreamUrl: upstream.href,
    upstream,
    host,
    port: parseInteger(options.port, '--port', 0, 65_535),
    max: parseInteger(options.max, '--max', 1, 1_024),
    maxQueue: parseInteger(options.maxQueue, '--max-queue', 0, 10_000),
    waitTimeoutMs: parseInteger(options.waitTimeoutMs, '--wait-timeout-ms', 1, 86_400_000),
  };
}

export function parseArgs(args) {
  const options = { ...DEFAULTS, upstreamUrl: null, allowRemote: false };
  const valueOptions = new Map([
    ['--upstream', 'upstreamUrl'],
    ['--host', 'host'],
    ['--port', 'port'],
    ['--max', 'max'],
    ['--max-queue', 'maxQueue'],
    ['--wait-timeout-ms', 'waitTimeoutMs'],
  ]);

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const separator = token.indexOf('=');
    const flag = separator === -1 ? token : token.slice(0, separator);
    const inlineValue = separator === -1 ? null : token.slice(separator + 1);

    if (flag === '--help') {
      if (inlineValue !== null) throw new Error('--help does not take a value');
      return { help: true };
    }
    if (flag === '--allow-remote') {
      if (inlineValue !== null) throw new Error('--allow-remote does not take a value');
      options.allowRemote = true;
      continue;
    }

    const key = valueOptions.get(flag);
    if (!key) throw new Error('unknown option');
    const value = inlineValue === null ? args[++i] : inlineValue;
    if (value === undefined || value.startsWith('--')) {
      throw new Error(flag + ' requires a value');
    }
    options[key] = value;
  }

  return validateOptions(options);
}

function requestPath(reqUrl, upstreamBase) {
  if (typeof reqUrl !== 'string' || !reqUrl.startsWith('/') || reqUrl.startsWith('//')) {
    throw new Error('invalid request target');
  }
  let incoming;
  try {
    incoming = new URL(reqUrl, 'http://rdsh-proxy.invalid');
  } catch {
    throw new Error('invalid request target');
  }

  const target = new URL(upstreamBase.origin);
  const prefix = upstreamBase.pathname.replace(/\/+$/, '');
  const alreadyPrefixed = prefix && (incoming.pathname === prefix || incoming.pathname.startsWith(prefix + '/'));
  target.pathname = alreadyPrefixed
    ? incoming.pathname
    : prefix + (incoming.pathname.startsWith('/') ? incoming.pathname : '/' + incoming.pathname);
  target.search = incoming.search;
  return target;
}

function forwardedHeaders(headers) {
  const excluded = new Set(HOP_BY_HOP_HEADERS);
  for (const token of String(headers.connection || '').split(',')) {
    const name = token.trim().toLowerCase();
    if (name) excluded.add(name);
  }

  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'host' || excluded.has(lower) || value === undefined) continue;
    result[lower] = value;
  }
  return result;
}

function writeJson(response, statusCode, payload) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload));
  const headers = {
    'cache-control': 'no-store',
    'content-length': body.length,
    'content-type': 'application/json; charset=utf-8',
  };
  if (statusCode === 429 || statusCode === 503) headers['retry-after'] = '1';
  response.writeHead(statusCode, headers);
  response.end(body);
}

function isStatusRequest(reqUrl) {
  try {
    return new URL(reqUrl, 'http://rdsh-proxy.invalid').pathname === '/__proxy/status';
  } catch {
    return false;
  }
}

export function createSerialProxy(inputOptions) {
  const options = validateOptions(inputOptions);
  const queue = [];
  const activeRequests = new Set();
  let active = 0;
  let closing = false;

  const server = createServer((req, res) => {
    if (isStatusRequest(req.url) && req.method === 'GET') {
      req.resume();
      const body = Buffer.from(JSON.stringify({
        active,
        queued: queue.length,
        max: options.max,
        maxQueue: options.maxQueue,
      }));
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': body.length,
        'content-type': 'application/json; charset=utf-8',
      });
      res.end(body);
      return;
    }

    if (closing) {
      req.resume();
      writeJson(res, 503, { error: 'proxy_shutting_down' });
      return;
    }

    let target;
    try {
      target = requestPath(req.url, options.upstream);
    } catch {
      req.resume();
      writeJson(res, 400, { error: 'invalid_request_target' });
      return;
    }

    const entry = {
      req,
      res,
      target,
      finished: false,
      started: false,
      timer: null,
      onCancel: null,
    };

    if (active < options.max && queue.length === 0) {
      start(entry);
      return;
    }
    if (queue.length >= options.maxQueue) {
      req.resume();
      writeJson(res, 429, { error: 'proxy_queue_full' });
      return;
    }

    req.pause();
    queue.push(entry);
    entry.onCancel = () => {
      if (entry.started || entry.finished) return;
      const index = queue.indexOf(entry);
      if (index < 0) return;
      queue.splice(index, 1);
      finishQueuedEntry(entry);
      pump();
    };
    req.once('aborted', entry.onCancel);
    res.once('close', entry.onCancel);
    entry.timer = setTimeout(() => {
      const index = queue.indexOf(entry);
      if (index < 0 || entry.started || entry.finished) return;
      queue.splice(index, 1);
      finishQueuedEntry(entry);
      req.resume();
      writeJson(res, 503, { error: 'proxy_queue_timeout' });
      pump();
    }, options.waitTimeoutMs);
    entry.timer.unref?.();
  });

  function removeQueueListeners(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.onCancel) {
      entry.req.removeListener('aborted', entry.onCancel);
      entry.res.removeListener('close', entry.onCancel);
    }
  }

  function finishQueuedEntry(entry) {
    if (entry.finished) return;
    entry.finished = true;
    removeQueueListeners(entry);
  }

  function pump() {
    while (!closing && active < options.max && queue.length > 0) {
      const entry = queue.shift();
      if (entry.finished) continue;
      finishQueuedEntry(entry);
      if (entry.req.aborted || entry.res.destroyed || entry.res.writableEnded) continue;
      start(entry);
    }
  }

  function start(entry) {
    entry.started = true;
    entry.finished = true;
    removeQueueListeners(entry);
    if (entry.req.aborted || entry.res.destroyed || entry.res.writableEnded) {
      pump();
      return;
    }

    active += 1;
    let released = false;
    let upstreamReq;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
      if (upstreamReq) activeRequests.delete(upstreamReq);
      pump();
    };

    const onClientClose = () => {
      if (entry.res.writableEnded || released) return;
      if (upstreamReq) upstreamReq.destroy();
      release();
    };
    const onClientAbort = () => {
      if (upstreamReq) upstreamReq.destroy();
      release();
    };
    entry.res.once('close', onClientClose);
    entry.req.once('aborted', onClientAbort);

    const makeRequest = entry.target.protocol === 'https:' ? httpsRequest : httpRequest;
    upstreamReq = makeRequest(entry.target, {
      method: entry.req.method,
      headers: forwardedHeaders(entry.req.headers),
    });
    activeRequests.add(upstreamReq);

    upstreamReq.once('response', (upstreamRes) => {
      upstreamRes.once('error', () => {
        if (!entry.res.headersSent) writeJson(entry.res, 502, { error: 'upstream_response_failed' });
        else if (!entry.res.writableEnded) entry.res.destroy();
        release();
      });
      upstreamRes.once('end', release);
      upstreamRes.once('close', () => {
        if (!upstreamRes.complete) {
          if (!entry.res.headersSent) writeJson(entry.res, 502, { error: 'upstream_response_incomplete' });
          else if (!entry.res.writableEnded) entry.res.destroy();
          release();
        }
      });

      entry.res.writeHead(upstreamRes.statusCode || 502, forwardedHeaders(upstreamRes.headers));
      if (String(upstreamRes.headers['content-type'] || '').toLowerCase().includes('text/event-stream')) {
        entry.res.flushHeaders();
      }
      upstreamRes.pipe(entry.res);
    });

    upstreamReq.once('error', () => {
      if (!released) {
        if (!entry.res.headersSent) writeJson(entry.res, 502, { error: 'upstream_unavailable' });
        else if (!entry.res.writableEnded) entry.res.destroy();
        release();
      }
    });

    entry.req.pipe(upstreamReq);
  }

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    server,
    listen() {
      return new Promise((resolveListen, rejectListen) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          rejectListen(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolveListen(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port, options.host);
      });
    },
    close() {
      if (closing) return Promise.resolve();
      closing = true;
      while (queue.length > 0) {
        const entry = queue.shift();
        finishQueuedEntry(entry);
        entry.req.resume();
        writeJson(entry.res, 503, { error: 'proxy_shutting_down' });
      }
      for (const request of activeRequests) request.destroy();
      if (!server.listening) return Promise.resolve();
      const closePromise = new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      return closePromise;
    },
    address() {
      return server.address();
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      process.stdout.write(USAGE + '\n');
      return;
    }

    const proxy = createSerialProxy(options);
    const address = await proxy.listen();
    const printableHost = address.family === 'IPv6' ? '[' + address.address + ']' : address.address;
    process.stdout.write(
      'Serial proxy listening at http://' + printableHost + ':' + address.port +
      ' (max=' + options.max + ', queue=' + options.maxQueue + ').\n',
    );

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await proxy.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    process.stderr.write('serial-proxy: ' + error.message + '\n' + USAGE + '\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}