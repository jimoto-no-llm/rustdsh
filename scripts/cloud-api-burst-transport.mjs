import http2 from 'node:http2';
import tls from 'node:tls';
import { createBurstTransport } from './deepinfra-burst-transport.mjs';

export async function prepareDeepInfra(count) {
  const sockets = [];
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(20, count) }, async () => {
    while (next < count) {
      next++;
      const socket = await new Promise((resolve, reject) => {
        const socket = tls.connect({ host: 'api.deepinfra.com', port: 443,
          servername: 'api.deepinfra.com', ALPNProtocols: ['http/1.1'] });
        const timer = setTimeout(() => socket.destroy(new Error('TLS prepare timeout')), 30_000);
        socket.on('error', () => { clearTimeout(timer); reject(new Error('TLS prepare failed')); });
        socket.once('secureConnect', () => {
          clearTimeout(timer);
          socket.setKeepAlive(true, 1000);
          resolve(socket);
        });
      });
      sockets.push(socket);
    }
  }));
  if (results.some((item) => item.status === 'rejected') || sockets.some((socket) => socket.destroyed)) {
    for (const socket of sockets) socket.destroy();
    throw new Error('TLS preparation incomplete; no chat requests sent');
  }
  const transport = createBurstTransport({ concurrency: count, preparedSockets: sockets,
    requestMs: 120_000 });
  return { ...transport, ready: () => sockets.length === count && sockets.every((s) => !s.destroyed),
    connectionCount: sockets.length };
}

export async function prepareOpenRouter(count) {
  const sessions = [];
  const perConnection = 100;
  const results = await Promise.allSettled(Array.from({ length: Math.ceil(count / perConnection) },
    () => new Promise((resolve, reject) => {
      const session = http2.connect('https://openrouter.ai');
      sessions.push(session);
      const timer = setTimeout(() => { session.destroy(); reject(new Error('HTTP2 prepare timeout')); }, 30_000);
      session.on('error', () => { clearTimeout(timer); reject(new Error('HTTP2 prepare failed')); });
      session.once('remoteSettings', (settings) => {
        clearTimeout(timer);
        if (settings.maxConcurrentStreams < perConnection) {
          reject(new Error('HTTP2 stream capacity insufficient')); return;
        }
        resolve(session);
      });
    })));
  if (results.some((item) => item.status === 'rejected')) {
    for (const session of sessions) session.destroy();
    throw new Error('HTTP2 preparation incomplete; no chat requests sent');
  }
  let requests = 0;
  return {
    ready: () => sessions.every((s) => !s.closed && !s.destroyed),
    connectionCount: sessions.length,
    close() { for (const session of sessions) session.destroy(); },
    post({ key, body }) {
      const index = requests++;
      return new Promise((resolve) => {
        const trace = { started: Date.now(), phase: 'prepared', mayHaveSent: false,
          connected: Date.now(), sent: null, headersAt: null, status: null, requestId: null };
        let stream;
        let done = false;
        let responseEnded = false;
        const timer = setTimeout(() => finish({ error: 'REQUEST_TIMEOUT' }), 120_000);
        const finish = (extra) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ...trace, ended: Date.now(), ...extra });
          if (extra.error && stream && !stream.closed && !stream.destroyed) {
            try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch { /* already closed */ }
          }
        };
        const chunks = [];
        let size = 0;
        try {
          const session = sessions[Math.floor(index / perConnection)];
          if (!session || session.closed || session.destroyed) {
            finish({ error: 'PREPARED_CONNECTION_CLOSED' }); return;
          }
          trace.phase = 'awaiting_headers';
          trace.sent = Date.now();
          trace.mayHaveSent = true;
          stream = session.request({ ':method': 'POST', ':path': '/api/v1/chat/completions',
            authorization: `Bearer ${key}`, 'content-type': 'application/json',
            'content-length': Buffer.byteLength(body) });
          stream.on('response', (headers) => {
            trace.headersAt = Date.now();
            trace.status = headers[':status'];
            trace.phase = 'response_body';
            const id = headers['x-request-id'];
            if (typeof id === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(id)) trace.requestId = id;
          });
          stream.on('data', (chunk) => {
            if (done) return;
            size += chunk.length;
            if (size > 256 * 1024) { finish({ error: 'RESPONSE_TOO_LARGE' }); return; }
            chunks.push(chunk);
          });
          stream.on('error', (error) => finish({ error: String(error.code || 'HTTP2_ERROR')
            .replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) }));
          stream.on('end', () => {
            responseEnded = true;
            let result = null;
            try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* uncertain response */ }
            trace.phase = 'complete';
            finish({ result });
          });
          stream.on('close', () => {
            if (!responseEnded) finish({ error: 'HTTP2_STREAM_CLOSED', rstCode: stream.rstCode });
          });
          stream.end(body);
        } catch (error) { finish({ error: String(error.code || 'HTTP2_SETUP_ERROR')
          .replace(/[^A-Za-z0-9_]/g, '').slice(0, 64) }); }
      });
    },
  };
}
