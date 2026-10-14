import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { BridgeError, MAX_BYTES, normalizeCatalog, parseReply, subscriptionEnvironment, tokenUsage, validateRequest } from './protocol.mjs';

export function runWorker(job, config = {}, signal, spawnImpl = spawn) {
  validateRequest(job);
  if (signal?.aborted) return Promise.reject(new BridgeError('ABORTED'));
  const request = JSON.stringify(job) + '\n';
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(config.nodeCommand ?? process.execPath,
        [config.workerPath ?? fileURLToPath(new URL('./worker.mjs', import.meta.url))],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: subscriptionEnvironment(process.env) });
    } catch { reject(new BridgeError('MUSE_UNAVAILABLE')); return; }
    let failure, response, exitKind, buffer = '', bytes = 0, killTimer, done = false;
    const decoder = new StringDecoder('utf8');
    const finish = (code, spawnFailed = false) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (spawnFailed || code !== 0 || !response || exitKind !== 'cleanShutdown' || buffer.trim()) reject(new BridgeError('MUSE_UNAVAILABLE'));
      else resolve(response);
    };
    const stop = code => {
      failure ??= new BridgeError(code);
      if (child.stdin.writable) { child.stdin.write('{"type":"cancel"}\n'); child.stdin.end(); }
      killTimer ??= setTimeout(() => {
        child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy();
        finish(null);
      }, config.shutdownGraceMs ?? 15000);
    };
    const abort = () => stop('ABORTED');
    const watchdog = setTimeout(() => stop('MUSE_TIMEOUT'), config.timeoutMs ?? 600000);
    child.on('error', () => finish(null, true));
    child.once('close', code => finish(code));
    child.stdin.on('error', () => stop('MUSE_UNAVAILABLE'));
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { stop('MUSE_PROTOCOL_ERROR'); return; }
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'ready') continue;
          if (event.type === 'models' && job.operation === 'list-models' && !response && !exitKind) response = { catalog: normalizeCatalog(event.catalog) };
          else if (event.type === 'response' && job.operation !== 'list-models' && !response && !exitKind) response = { response: parseReply(event.response, job.tools, true), tokenUsage: tokenUsage(event.tokenUsage) };
          else if (event.type === 'error') { failure ??= new BridgeError(event.code); }
          else if (event.type === 'exit' && !exitKind) exitKind = event.kind;
          else throw new BridgeError('MUSE_PROTOCOL_ERROR');
        } catch { stop('MUSE_PROTOCOL_ERROR'); }
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.write(request);
    if (signal?.aborted) abort();
  });
}
