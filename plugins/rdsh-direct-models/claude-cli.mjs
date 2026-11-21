// Claude owns its existing login. DSH owns history, tools and approvals.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTurnPrompt, parseTurnResponse, JsonTurnError, assertSupportedGenerationOptions } from './json-turn.mjs';

const LIMIT = 8 * 1024 * 1024;
const ENV_KEYS = ['HOME', 'USERPROFILE', 'PATH', 'PATHEXT', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP',
  'SystemRoot', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'];

export function claudeArguments(model) {
  return ['-p', '--output-format', 'json', '--model', model,
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-session-persistence', '--max-turns', '1',
    '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--system-prompt', 'Return only the response requested by the user. Do not execute tools. DSH manages conversation, tools and approvals.'];
}

export function createClaudeCliRunner({ binary = 'claude', spawnImpl = spawn,
  killImpl = process.kill.bind(process), env = process.env, timeoutMs = 180000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw new Error('Claude CLI: invalid timeout');
  return ({ model, prompt }, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Claude CLI: aborted')); return; }
    if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(model)
      || typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > LIMIT) {
      reject(new Error('Claude CLI: invalid request')); return;
    }
    let root;
    try { root = mkdtempSync(path.join(tmpdir(), 'rdsh-claude-bridge-')); }
    catch { reject(new Error('Claude CLI: temporary workspace could not be created')); return; }
    let child, timer, done = false, failure, size = 0, diagnosticSize = 0;
    const output = [];
    const stop = () => {
      try { if (process.platform !== 'win32' && child?.pid) killImpl(-child.pid, 'SIGKILL'); else child?.kill('SIGKILL'); }
      catch { try { child?.kill('SIGKILL'); } catch {} }
    };
    const abort = () => { failure ??= new Error('Claude CLI: aborted'); stop(); };
    const finish = async (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { await rm(root, { recursive: true, force: true }); }
      catch { reject(new Error('Claude CLI: temporary workspace cleanup failed')); return; }
      error ? reject(error) : resolve(value);
    };
    try {
      child = spawnImpl(binary, claudeArguments(model), {
        stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32', cwd: root,
        env: Object.fromEntries(ENV_KEYS.filter(key => typeof env[key] === 'string').map(key => [key, env[key]])),
      });
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > LIMIT) { failure ??= new Error('Claude CLI: output exceeds limit'); stop(); }
        else output.push(Buffer.from(chunk));
      });
      // Diagnostics may contain auth details. Never log or forward them.
      child.stderr.on('data', chunk => {
        diagnosticSize += chunk.length;
        if (diagnosticSize > LIMIT) { failure ??= new Error('Claude CLI: diagnostics exceed limit'); stop(); }
      });
      child.stdin.on('error', () => {});
      child.on('error', () => { failure ??= new Error('Claude CLI: process could not start'); });
      child.on('close', code => {
        if (failure) { void finish(failure); return; }
        let result;
        try { result = JSON.parse(Buffer.concat(output).toString('utf8')); }
        catch { void finish(new Error('Claude CLI: invalid response')); return; }
        if (code !== 0 || result?.type !== 'result' || result.subtype !== 'success' || result.is_error !== false) {
          void finish(new Error('Claude CLI: request failed (check claude auth status)')); return;
        }
        if (result.num_turns !== 1 || (result.permission_denials !== undefined
          && (!Array.isArray(result.permission_denials) || result.permission_denials.length !== 0))) {
          void finish(new Error('Claude CLI: unexpected tool execution')); return;
        }
        if (typeof result.result !== 'string' || !result.result.trim()) {
          void finish(new Error('Claude CLI: empty response')); return;
        }
        try { void finish(null, { text: unwrapJsonFence(result.result), usage: usageFromCli(result.usage) }); }
        catch { void finish(new Error('Claude CLI: invalid usage')); }
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { failure ??= new Error('Claude CLI: timed out'); stop(); }, timeoutMs);
      timer.unref?.();
      if (signal?.aborted) abort(); else child.stdin.end(prompt);
    } catch {
      if (child) { failure ??= new Error('Claude CLI: process could not start'); stop(); }
      else void finish(new Error('Claude CLI: process could not start'));
    }
  });
}

function unwrapJsonFence(text) {
  const value = text.trim();
  for (const [start, end] of [['```json\n', '\n```'], ['```\n', '\n```'], ['```json\r\n', '\r\n```'], ['```\r\n', '\r\n```']]) {
    if (value.startsWith(start) && value.endsWith(end)) return value.slice(start.length, -end.length);
  }
  return value;
}

function usageFromCli(value) {
  if (!value || value.input_tokens === undefined || value.output_tokens === undefined) return undefined;
  const fields = { inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadTokens: 'cache_read_input_tokens', cacheWriteTokens: 'cache_creation_input_tokens' };
  const usage = {};
  for (const [target, source] of Object.entries(fields)) {
    if (value[source] === undefined) continue;
    if (!Number.isSafeInteger(value[source]) || value[source] < 0) throw new Error('invalid counter');
    usage[target] = value[source];
  }
  return usage;
}

function sumUsage(previous, next) {
  if (!previous || !next) return undefined;
  const result = {};
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (previous[field] !== undefined && next[field] !== undefined) {
      const total = previous[field] + next[field];
      if (!Number.isSafeInteger(total)) throw new Error('Claude CLI: usage exceeds limit');
      result[field] = total;
    }
  }
  return result;
}

export function createClaudeCliBackend({ runner = createClaudeCliRunner(),
  models = async () => ['opus', 'sonnet', 'haiku'].map(id => ({ id, name: id })) } = {}) {
  return {
    async discover({ signal } = {}) { signal?.throwIfAborted(); return models(); },
    async generate(options = {}) {
      options.signal?.throwIfAborted(); assertSupportedGenerationOptions(options);
      let repair, total;
      for (let attempt = 0; attempt < 2; attempt++) {
        options.signal?.throwIfAborted();
        const result = await runner({ model: options.model, prompt: buildTurnPrompt({ ...options, repair }) }, { signal: options.signal });
        total = attempt === 0 ? result.usage : sumUsage(total, result.usage);
        try { return { ...parseTurnResponse(result.text, options.tools ?? []), ...(total ? { usage: total } : {}) }; }
        catch (error) { if (!(error instanceof JsonTurnError) || attempt === 1) throw error; repair = error.message; }
      }
    },
  };
}
