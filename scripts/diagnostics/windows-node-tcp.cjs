// Isolated loopback-only diagnostic for nodejs/node#63620. No DSH or credentials.
'use strict';
const http = require('node:http');
const duration = Number(process.argv[2] || 60000);
const concurrency = 96;
const started = Date.now();
let made = 0, completed = 0, failed = 0, active = 0, stopping = false;
const agent = new http.Agent({ keepAlive: false, maxSockets: concurrency });
const server = http.createServer((req, res) => res.end('ok'));
const hardTimeout = setTimeout(() => {
  console.log(JSON.stringify({ event: 'timeout', made, completed, failed }));
  agent.destroy(); server.closeAllConnections(); server.close(); process.exitCode = 2;
}, duration + 15000);
function finish() {
  if (stopping || Date.now() - started < duration || active) return;
  stopping = true; clearTimeout(hardTimeout); agent.destroy();
  server.close(() => console.log(JSON.stringify({ event: 'complete', node: process.version,
    uv: process.versions.uv, made, completed, failed, elapsedMs: Date.now() - started })));
}
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(JSON.stringify({ event: 'start', node: process.version, uv: process.versions.uv, pid: process.pid }));
  function pump() {
    while (!stopping && active < concurrency && Date.now() - started < duration) {
      active++; made++;
      let settled = false;
      const settle = (ok) => { if (settled) return; settled = true; active--; if(ok)completed++;else failed++; finish(); };
      const request = http.get({ host: '127.0.0.1', port, agent }, (response) => {
        response.resume(); response.on('end', () => settle(true)); response.on('error', () => settle(false));
      });
      request.on('error', () => settle(false));
      request.setTimeout(5000, () => request.destroy());
    }
    if (!stopping && Date.now() - started < duration) setImmediate(pump);
    else finish();
  }
  pump();
});
