#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyDiagnostic, DIAGNOSTIC_CODES, emptyUsage, failure, MAX_BYTES, permittedTools, plain, validateRequest } from './validation.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const literal = value => JSON.stringify(value); // YAML double-quoted scalars, never shell text.

export function parseHeadless(output) {
  let final, outcome, session = false;
  for (const line of output.split('\n').filter(line => line.trim())) {
    let event;
    try { event = JSON.parse(line); } catch { throw failure('MALFORMED_EVENTS'); }
    if (!plain(event) || typeof event.type !== 'string' || event.truncated) throw failure('MALFORMED_EVENTS');
    if (!['session', 'status', 'thinking', 'text', 'tool_call', 'tool_result', 'final', 'error'].includes(event.type)) throw failure('MALFORMED_EVENTS');
    if (final !== undefined) throw failure('MALFORMED_EVENTS');
    if (event.type === 'session') { if (session || typeof event.sessionId !== 'string') throw failure('MALFORMED_EVENTS'); session = true; }
    if (event.type === 'status' && event.phase === 'turn_end') outcome = event.reason?.kind;
    if (event.type === 'final') { if (typeof event.text !== 'string') throw failure('MALFORMED_EVENTS'); final = event.text; }
    if (event.type === 'error') throw failure('HEADLESS_ERROR');
  }
  if (!session || final === undefined || outcome !== 'completed') throw failure('INCOMPLETE_RUN');
  return final;
}

export function captureChild(binary, args, { cwd, env, input, timeoutMs, spawnImpl = spawn }) {
  return new Promise((accept, reject) => {
    let child;
    try { child = spawnImpl(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); }
    catch { reject(failure('SPAWN_FAILED')); return; }
    let output = '', bytes = 0, errorCode, killTimer;
    const decoder = new StringDecoder('utf8');
    const diagnosticDecoder = new StringDecoder('utf8');
    let diagnosticTail = '', diagnosticCode;
    const stop = code => {
      errorCode ||= code;
      try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer ||= setTimeout(() => {
        try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch {}
      }, 1000);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    const abort = () => stop('CANCELLED');
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) stop('OUTPUT_LIMIT'); else output += decoder.write(chunk); });
    // Retain only a bounded matching window in memory. Provider diagnostics
    // never enter telemetry, error messages, stdout, or the response document.
    child.stderr.on('data', chunk => {
      bytes += chunk.length; if (bytes > MAX_BYTES) stop('OUTPUT_LIMIT');
      diagnosticTail = (diagnosticTail + diagnosticDecoder.write(chunk)).slice(-512);
      const code = classifyDiagnostic(diagnosticTail);
      if (code && (!diagnosticCode?.startsWith('HTTP_') || code.startsWith('HTTP_'))) diagnosticCode = code;
    });
    child.on('error', () => { errorCode ||= 'SPAWN_FAILED'; });
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => {
      // The group belongs exclusively to this invocation. Remove descendants
      // even when the leader exits before the escalation timer fires.
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      clearTimeout(timer); clearTimeout(killTimer); process.off('SIGINT', abort); process.off('SIGTERM', abort);
      if (errorCode) reject(failure(errorCode));
      else if (code !== 0 || signal) reject(failure(diagnosticCode || 'CHILD_FAILED'));
      else accept(output + decoder.end());
    });
    child.stdin.end(input);
  });
}

export function validateTelemetry(value, request, { partial = false } = {}) {
  if (!plain(value) || value.version !== 1 || value.provider !== request.provider || value.model !== request.model ||
      !Number.isInteger(value.calls) || value.calls < (partial ? 0 : 1) || value.calls > request.maxSteps ||
      !Number.isInteger(value.inflight) || value.inflight < 0 || value.inflight > value.calls || (!partial && value.inflight !== 0) ||
      (!partial && (value.outcome !== 'completed' || value.failure)) || !Array.isArray(value.trace) || !plain(value.usage)) throw failure('INVALID_TELEMETRY');
  for (const key of Object.keys(emptyUsage())) if (value.usage[key] !== null && (!Number.isSafeInteger(value.usage[key]) || value.usage[key] < 0)) throw failure('INVALID_TELEMETRY');
  for (const event of value.trace) {
    if (!plain(event) || !['action', 'observation', 'answer', 'error'].includes(event.type) || typeof event.text !== 'string' ||
        (event.name !== undefined && typeof event.name !== 'string')) throw failure('INVALID_TELEMETRY');
    if (event.type === 'action' && !permittedTools(request).includes(event.name)) throw failure('TOOL_BOUNDARY_VIOLATION');
  }
  // A killed request may already have spent tokens without a final usage
  // sample. Earlier completed calls are only a lower bound for the run.
  return value.inflight > 0 ? { ...value, usage: emptyUsage() } : value;
}

export async function runRequest(request, { env = process.env, spawnImpl, runtimeParent = dirname(request.workspace) } = {}) {
  validateRequest(request);
  if (!lstatSync(request.workspace).isDirectory() || realpathSync(request.workspace) !== request.workspace) throw failure('INVALID_WORKSPACE');
  const binary = env.RDSH_HARNESS2_BIN || join(homedir(), '.local', 'bin', 'rdsh');
  const dshPackage = env.RDSH_HARNESS2_DSH_PACKAGE || join(homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh');
  const original = join(dshPackage, 'lib', 'bin.js');
  if (!isAbsolute(binary) || !isAbsolute(dshPackage) || !existsSync(original)) throw failure('RUNTIME_UNAVAILABLE');
  const overlay = env.RDSH_HARNESS2_MODEL_PATCH;
  if (overlay && (!isAbsolute(overlay) || !lstatSync(overlay).isFile())) throw failure('INVALID_MODEL_PATCH');
  const runtime = mkdtempSync(join(runtimeParent, '.rdsh-harness2-')); chmodSync(runtime, 0o700);
  const start = performance.now();
  const telemetryPath = join(runtime, 'telemetry.json');
  try {
    const home = join(runtime, 'dsh-home'); mkdirSync(home, { mode: 0o700 });
    const requestPath = join(runtime, 'request.json');
    writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
    const patch = join(runtime, 'cordis.patch.yml');
    // The usual core runtime is preserved. Auxiliary title calls are omitted so
    // maxSteps counts task calls and usage remains comparable across both arms.
    writeFileSync(patch, `- id: agent-default-model\n  config:\n    provider: ${literal(request.provider)}\n    model: ${literal(request.model)}\n- id: tools\n  config:\n    mode: native\n- id: session-title-llm\n  disabled: true\n- insert:\n    - id: rdsh-harness2\n      name: ${literal(join(directory, 'index.mjs'))}\n      config:\n        requestPath: ${literal(requestPath)}\n        telemetryPath: ${literal(telemetryPath)}\n`, { mode: 0o600 });
    const args = ['--profile', 'harness2', '--from-default-profile', 'headless'];
    if (overlay) args.push('--patch', overlay);
    args.push('--patch', patch, '--', '--json', '-');
    const output = await captureChild(binary, args, { cwd: request.workspace,
      env: { ...env, DSH_HOME: home, RDSH_ORIG_BIN: original, DSH_TELEMETRY_DISABLED: '1' }, input: request.prompt, timeoutMs: request.timeoutMs, spawnImpl });
    const text = parseHeadless(output);
    const raw = readFileSync(telemetryPath);
    if (raw.length > MAX_BYTES) throw failure('TRACE_LIMIT');
    const telemetry = validateTelemetry(JSON.parse(raw), request);
    return { version: 1, ok: true, text, usage: telemetry.usage, wallMs: Math.round(performance.now() - start), trace: telemetry.trace, model: request.model, provider: request.provider };
  } catch (error) {
    let telemetry;
    try { const raw = readFileSync(telemetryPath); if (raw.length <= MAX_BYTES) telemetry = validateTelemetry(JSON.parse(raw), request, { partial: true }); } catch {}
    const recorded = telemetry?.trace.findLast(event => event.type === 'error' && DIAGNOSTIC_CODES.includes(event.text))?.text;
    const code = error.code === 'CHILD_FAILED' && recorded ? recorded : safeCode(error);
    error.result = { version: 1, ok: false, text: '', error: { code }, usage: telemetry?.usage || emptyUsage(), wallMs: Math.round(performance.now() - start),
      trace: [...(telemetry?.trace || []), { type: 'error', text: code }], model: request.model, provider: request.provider };
    throw error;
  } finally { rmSync(runtime, { recursive: true, force: true }); }
}

export async function main(args = process.argv.slice(2)) {
  let responsePath, request, start = performance.now();
  try {
    if (args.length !== 4 || args[0] !== '--request' || args[2] !== '--response' || !isAbsolute(args[1]) || !isAbsolute(args[3]) || resolve(args[1]) === resolve(args[3])) throw failure('INVALID_ARGUMENTS');
    if (existsSync(args[3])) throw failure('RESPONSE_EXISTS');
    responsePath = args[3];
    const raw = readFileSync(args[1]); if (raw.length > MAX_BYTES) throw failure('INVALID_REQUEST');
    request = validateRequest(JSON.parse(raw));
    const response = await runRequest(request);
    writeResponse(responsePath, response);
    return 0;
  } catch (error) {
    // Codes are fixed diagnostics; never propagate raw provider or process errors.
    const code = error.result?.error?.code || safeCode(error);
    if (responsePath) writeResponse(responsePath, error.result || { version: 1, ok: false, text: '', error: { code }, usage: emptyUsage(), wallMs: Math.round(performance.now() - start), trace: [{ type: 'error', text: code }], model: request?.model || '', provider: request?.provider || '' });
    process.stderr.write(`rdsh-harness2: ${code}\n`);
    return 1;
  }
}
function writeResponse(path, response) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(response) + '\n', { mode: 0o600, flag: 'wx' });
  try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
}
function safeCode(error) { return typeof error?.code === 'string' && /^[A-Z_]{3,50}$/.test(error.code) ? error.code : 'RUN_FAILED'; }
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
