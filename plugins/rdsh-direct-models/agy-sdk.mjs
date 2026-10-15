import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { buildTurnPrompt, parseTurnResponse } from './json-turn.mjs';
const SCRIPT = fileURLToPath(new URL('./agy-sdk.py', import.meta.url));
const LIMIT = 8 * 1024 * 1024;
export function createPythonRunner({ python = process.env.RDSH_AGY_PYTHON || fileURLToPath(new URL('./.venv/bin/python', import.meta.url)), timeoutMs = 120000, spawnImpl = spawn } = {}) {
  return (payload, { signal, env } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Antigravity SDK: aborted')); return; }
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input) > LIMIT) { reject(new Error('Antigravity SDK: input exceeds limit')); return; }
    const child = spawnImpl(python, ['-I', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env, ...env } });
    let output = '', size = 0, done = false;
    const decoder = new StringDecoder('utf8');
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => { stop(); finish(new Error('Antigravity SDK: aborted')); };
    const timer = setTimeout(() => { stop(); finish(new Error('Antigravity SDK: timed out')); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => {
      size += data.length;
      if (size > LIMIT) { stop(); finish(new Error('Antigravity SDK: output exceeds limit')); }
      else output += decoder.write(data);
    });
    child.stderr.resume(); // Deliberately discard SDK diagnostics: may include credentials.
    child.on('error', () => finish(new Error('Antigravity SDK: Python runtime could not start')));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (done) return;
      if (code !== 0) { finish(new Error('Antigravity SDK: bridge process failed')); return; }
      output += decoder.end();
      let result;
      try { result = JSON.parse(output); } catch { finish(new Error('Antigravity SDK: invalid bridge response')); return; }
      const errors = new Set(['SDK_NOT_INSTALLED', 'SDK_AUTH_REQUIRED', 'INVALID_REQUEST', 'INVALID_RESPONSE', 'INPUT_LIMIT', 'SDK_REQUEST_FAILED']);
      if (result?.error) {
        const diagnostic = result.error === 'SDK_REQUEST_FAILED' && typeof result.exceptionClass === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(result.exceptionClass) ? ` (${result.exceptionClass}${Number.isInteger(result.httpStatus) && result.httpStatus >= 400 && result.httpStatus <= 599 ? ` HTTP ${result.httpStatus}` : ''})` : '';
        finish(new Error(`Antigravity SDK: ${errors.has(result.error) ? result.error : 'SDK_REQUEST_FAILED'}${diagnostic}`)); return;
      }
      finish(null, result);
    });
    child.stdin.end(input);
  });
}
export function createAgySdkBackend({ runner = createPythonRunner(), keyResolver } = {}) {
  return {
    async discover({ signal } = {}) {
      const result = await runner({ operation: 'discover' }, { signal });
      if (!Array.isArray(result?.models) || !result.models.length || result.models.some(m => typeof m.id !== 'string' || !m.id)) throw new Error('Antigravity SDK: invalid model catalog');
      return result.models;
    },
    async generate(options = {}) {
      const key = keyResolver ? await keyResolver({ signal: options.signal }) : undefined;
      if (key !== undefined && (typeof key !== 'string' || !key)) throw new Error('Antigravity SDK: invalid resolved API key');
      const runOptions = { signal: options.signal, ...(key ? { env: { GEMINI_API_KEY: key, GOOGLE_API_KEY: key } } : {}) };
      let repair;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runner({ operation: 'generate', model: options.model, prompt: buildTurnPrompt({ ...options, repair }) }, runOptions);
        if (typeof result?.text !== 'string') throw new Error('Antigravity SDK: invalid response');
        try { return parseTurnResponse(result.text, options.tools ?? []); }
        catch (error) {
          if (error?.code !== 'INVALID_JSON_TURN' || attempt === 1) throw error;
          repair = error.message;
        }
      }
    },
  };
}
