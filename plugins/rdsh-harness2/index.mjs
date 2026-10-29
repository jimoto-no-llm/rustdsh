import { readFileSync, writeFileSync, renameSync, openSync, closeSync, fstatSync, lstatSync, realpathSync, constants } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { classifyDiagnostic, emptyUsage, exact, failure, MAX_BYTES, permittedTools, validateRequest } from './validation.mjs';
import { editFixture, runFixtureTests, supportedSandbox } from './coding-tools.mjs';

export const name = 'rdsh-harness2';
export const inject = ['systemPrompt', 'tools', 'llm'];
export const READ_TOOL = 'harness2_read';

// No glob, directory enumeration, symlink following, shell, or credential reads.
export function readFixture(workspace, filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw failure('READ_DENIED');
  const target = resolve(workspace, filePath);
  const rel = relative(workspace, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).some(part => part.startsWith('.'))) throw failure('READ_DENIED');
  let cursor = workspace;
  for (const part of rel.split(sep)) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) throw failure('READ_DENIED'); }
  if (realpathSync(workspace) !== workspace || realpathSync(target) !== target) throw failure('READ_DENIED');
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw failure('READ_DENIED');
    const text = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(text) > 65536 || text.includes('\0')) throw failure('READ_DENIED');
    return text;
  } finally { closeSync(fd); }
}

export function apply(ctx, config = {}) {
  if (!config.requestPath) return;
  exact(config, ['requestPath', 'telemetryPath']);
  if (typeof config.telemetryPath !== 'string' || !config.telemetryPath.startsWith('/') || typeof config.requestPath !== 'string' || !config.requestPath.startsWith('/')) throw failure('INVALID_CONFIG');
  const raw = readFileSync(config.requestPath);
  if (raw.length > MAX_BYTES) throw failure('INVALID_REQUEST');
  const request = validateRequest(JSON.parse(raw));
  if (realpathSync(request.workspace) !== request.workspace) throw failure('INVALID_WORKSPACE');
  if (request.coding && !supportedSandbox().supported) throw failure('SANDBOX_UNAVAILABLE');
  const allowed = new Set(permittedTools(request));
  const deadline = Date.now() + request.timeoutMs;
  const state = { version: 1, provider: request.provider, model: request.model, calls: 0, inflight: 0, usage: emptyUsage(), trace: [], outcome: null, failure: null };
  const persist = () => {
    let json = JSON.stringify(state);
    if (Buffer.byteLength(json) > MAX_BYTES) {
      state.failure = 'TRACE_LIMIT'; state.trace = [{ type: 'error', text: 'TRACE_LIMIT' }]; json = JSON.stringify(state);
    }
    const temp = `${config.telemetryPath}.tmp`;
    writeFileSync(temp, json, { mode: 0o600 }); renameSync(temp, config.telemetryPath);
    if (state.failure) throw failure(state.failure);
  };
  const guardDeadline = () => { if (Date.now() >= deadline) { state.failure = 'TIMEOUT'; persist(); } };
  persist();
  const text = Object.entries(request.harness).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => `## ${path}\n${content}`).join('\n\n');
  ctx.systemPrompt.section({ name: 'rdsh-harness2', order: ctx.systemPrompt.getSectionOrder('HARNESS_SOURCE'), interpolate: false,
    text: request.coding
      ? `This is an isolated coding comparison. Available tools: harness2_read to inspect files, harness2_edit for an exact one-match replacement in declared source files, and harness2_test to run the fixed visible Node tests in an OS sandbox. Editable files: ${request.coding.editableFiles.join(', ')}. Test files are immutable: ${request.coding.testFiles.join(', ')}. Complete the requested code change and run the tests.\n\n${text}`
      : `This is an isolated, read-only harness comparison. Only ${READ_TOOL} is available; use explicit fixture paths supplied in the task. Return the requested answer in your final text.\n\n${text}` });
  ctx.tools.guard(exec => {
    guardDeadline();
    return allowed.has(exec.name) && exec.parent === undefined ? undefined : 'HARNESS2_TOOL_DENIED';
  });
  ctx.tools.register({ name: READ_TOOL, description: 'Read one explicit UTF-8 fixture file within this task workspace. No directories or hidden files.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      guardDeadline(); exec.signal.throwIfAborted(); exact(args, ['path']);
      return readFixture(request.workspace, args.path);
    }
  });
  if (request.coding) {
    const make = (name, description, parameters, execute) => ({ name, description, parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) { guardDeadline(); exec.signal.throwIfAborted(); return execute(args, exec); },
    });
    ctx.tools.register(make('harness2_edit', 'Replace exactly one occurrence in an existing declared source file. Tests and other files cannot be edited.',
      { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'search', 'replace'], additionalProperties: false },
      args => editFixture(request.workspace, request.coding, args)));
    ctx.tools.register(make('harness2_test', 'Run the original visible Node test suite in an OS sandbox. No command arguments are accepted. Reports actual TAP results and failures.',
      { type: 'object', properties: {}, additionalProperties: false },
      (args, exec) => { exact(args, []); return runFixtureTests({ workspace: request.workspace, testFiles: request.coding.testFiles, timeoutMs: request.coding.testTimeoutMs, signal: exec.signal }); }));
  }
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next(); result.tools = result.tools.filter(tool => allowed.has(tool.name)); return result;
  });
  ctx.on('llm/stream', async function* (options, next) {
    guardDeadline();
    if (options.provider !== request.provider || options.model !== request.model) { state.failure = 'ROUTE_MISMATCH'; persist(); }
    if (state.calls >= request.maxSteps) { state.failure = 'STEP_LIMIT'; persist(); }
    state.calls++;
    state.inflight++;
    persist(); let usage;
    try {
      for await (const chunk of next()) { guardDeadline(); if (chunk.type === 'usage') usage = chunk.usage; yield chunk; }
    } finally {
      for (const key of Object.keys(state.usage)) {
        const value = usage?.[key];
        state.usage[key] = Number.isFinite(value) && value >= 0 ? (state.calls === 1 ? value : state.usage[key] === null ? null : state.usage[key] + value) : null;
      }
      state.inflight--;
      persist();
    }
  }, { prepend: true });
  ctx.on('session/event', (_session, event) => {
    const data = event.data;
    if (event.type === 'tool/call') state.trace.push({ type: 'action', name: data.name, text: data.arguments });
    if (event.type === 'tool/result' && event.surfaceOp === 'append') state.trace.push({ type: 'observation', text: data.message.content.filter(b => b.type === 'text').map(b => b.text).join('') });
    if (event.type === 'assistant/message') {
      const text = data.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (text !== '') state.trace.push({ type: 'answer', text });
    }
    if (event.type === 'turn/end') {
      state.outcome = data.reason?.kind ?? 'unknown';
      if (data.reason?.kind === 'error') state.trace.push({ type: 'error', text: classifyDiagnostic(data.reason.error?.code, data.reason.error?.message) || 'NATIVE_TURN_FAILED' });
    }
    persist();
  });
}
