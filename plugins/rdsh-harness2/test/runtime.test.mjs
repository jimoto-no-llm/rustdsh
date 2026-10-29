import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { apply, readFixture, READ_TOOL } from '../index.mjs';
import { captureChild, parseHeadless, runRequest, validateTelemetry } from '../runner.mjs';
import { classifyDiagnostic, emptyUsage, validateRequest } from '../validation.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rdsh-harness2-test-')));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = { version: 1, role: 'solver', workspace, prompt: 'Read input.txt and answer.', harness: {}, provider: 'fixture', model: 'fixture-model', timeoutMs: 3000, maxSteps: 3 };
  return { root, workspace, request };
}
const events = [{ type: 'session', sessionId: 'fixture' }, { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }, { type: 'final', text: 'OK' }];
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
test('request schema rejects unknown fields, executable paths, NUL, and oversized guidance', t => {
  const { request } = fixture(t);
  assert.equal(validateRequest(request), request);
  for (const mutation of [{ bad: true }, { harness: { '../secret': 'bad' } }, { harness: { 'skills/Bad/SKILL.md': 'bad' } }, { harness: { 'systemprompt.md': '\0' } }, { harness: { 'systemprompt.md': 'a'.repeat(48001) } }, { maxSteps: 33 }])
    assert.throws(() => validateRequest({ ...request, ...mutation }));
});
test('fixture reader denies outside files, hidden files, directories, and symlinks', t => {
  const { root, workspace } = fixture(t);
  writeFileSync(join(workspace, 'input.txt'), 'readable'); writeFileSync(join(root, 'outside'), 'private'); writeFileSync(join(workspace, '.env'), 'private');
  symlinkSync(join(root, 'outside'), join(workspace, 'link'));
  assert.equal(readFixture(workspace, 'input.txt'), 'readable');
  for (const path of ['../outside', '.env', '.', 'link']) assert.throws(() => readFixture(workspace, path));
});
test('plugin inert with empty config; configured plugin restricts schema and guard', async t => {
  apply({}, {});
  const { root, workspace, request } = fixture(t);
  request.harness = { 'systemprompt.md': 'Literal {{not_a_variable}}', 'skills/example/SKILL.md': 'Use fixture evidence.' };
  writeFileSync(join(workspace, 'input.txt'), 'evidence');
  const requestPath = join(root, 'request.json'), telemetryPath = join(root, 'telemetry.json'); writeFileSync(requestPath, JSON.stringify(request));
  const listeners = {}, sections = []; let guard, definition;
  const ctx = { systemPrompt: { getSectionOrder: () => 123, section: section => sections.push(section) },
    tools: { guard: fn => { guard = fn; }, register: tool => { definition = tool; } }, on: (name, fn) => { listeners[name] = fn; } };
  apply(ctx, { requestPath, telemetryPath });
  assert.equal(sections[0].interpolate, false); assert.match(sections[0].text, /Literal \{\{not_a_variable\}\}/);
  assert.equal(guard({ name: READ_TOOL }), undefined); assert.equal(guard({ name: 'bash' }), 'HARNESS2_TOOL_DENIED'); assert.equal(guard({ name: READ_TOOL, parent: Symbol() }), 'HARNESS2_TOOL_DENIED');
  const assembly = { tools: [{ name: 'bash' }, { name: READ_TOOL }] };
  assert.deepEqual((await listeners['system-prompt/assemble'](assembly, {}, async () => assembly)).tools, [{ name: READ_TOOL }]);
  assert.equal(await definition.execute({ path: 'input.txt' }, { signal: new AbortController().signal }), 'evidence');
  const stream = listeners['llm/stream'];
  const chunks = [{ type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 } }];
  for await (const chunk of stream({ provider: 'fixture', model: 'fixture-model' }, async function* () { yield* chunks; })) assert.equal(chunk, chunks[0]);
  listeners['session/event']({}, { type: 'tool/call', data: { name: READ_TOOL, arguments: '{"path":"input.txt"}' } });
  listeners['session/event']({}, { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: READ_TOOL }] } } });
  listeners['session/event']({}, { type: 'tool/result', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'evidence' }] } } });
  listeners['session/event']({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  const telemetry = validateTelemetry(JSON.parse(readFileSync(telemetryPath)), request);
  assert.equal(telemetry.usage.inputTokens, 10); assert.equal(telemetry.usage.cacheWriteTokens, null); assert.equal(telemetry.trace.length, 2); assert.equal(telemetry.trace[0].type, 'action'); assert.equal(telemetry.trace[1].text, 'evidence');
  const pending = stream({ provider: 'fixture', model: 'fixture-model' }, async function* () { yield { type: 'text-delta', text: 'pending' }; });
  await pending.next();
  const activeState = JSON.parse(readFileSync(telemetryPath)); assert.equal(activeState.inflight, 1); assert.equal(activeState.calls, 2);
  assert.equal(activeState.usage.inputTokens, 10, 'persisted completed usage is only a lower bound while another call is active');
  assert.deepEqual(validateTelemetry(activeState, request, {partial:true}).usage, emptyUsage());
  await pending.return();
  await assert.rejects(async () => { for await (const _ of stream({ provider: 'wrong', model: 'fixture-model' }, async function* () {})) {} }, /ROUTE_MISMATCH/);
});
test('headless parser requires a completed turn, exactly one terminal final, and untruncated JSON', () => {
  assert.equal(parseHeadless(jsonl(events)), 'OK');
  for (const data of ['bad', jsonl(events.slice(0, 2)), jsonl([...events, events.at(-1)]), jsonl(events.map(row => row.type === 'status' ? { ...row, reason: { kind: 'error' } } : row)), jsonl([{ ...events[0], truncated: true }, ...events.slice(1)])]) assert.throws(() => parseHeadless(data));
});
test('turn error diagnostics emit only fixed labels and never error messages', t => {
  const { root, request } = fixture(t);
  const requestPath = join(root, 'request.json'), telemetryPath = join(root, 'telemetry.json'); writeFileSync(requestPath, JSON.stringify(request));
  const listeners = {};
  apply({systemPrompt:{getSectionOrder:()=>0,section(){}},tools:{guard(){},register(){}},on:(name,fn)=>{listeners[name]=fn;}}, {requestPath,telemetryPath});
  const cases = [
    ['UNKNOWN','SDK_AUTH_REQUIRED secret-sentinel','SDK_AUTH_REQUIRED'],
    ['INVALID_JSON_TURN','secret-sentinel','INVALID_JSON_TURN'],
    ['UNKNOWN','Antigravity SDK: SDK_REQUEST_FAILED (ClientError HTTP 429) secret-sentinel','HTTP_429'],
    ['UNKNOWN','HTTP 503 secret-sentinel','HTTP_5XX'],
    ['UNLISTED_SECRET_CODE','secret-sentinel','NATIVE_TURN_FAILED']
  ];
  for (const [code,message,expected] of cases) {
    listeners['session/event']({}, {type:'turn/end',data:{reason:{kind:'error',error:{code,message}}}});
    const state = JSON.parse(readFileSync(telemetryPath)); assert.equal(state.trace.at(-1).text, expected); assert.equal(JSON.stringify(state).includes('secret-sentinel'), false);
  }
  assert.equal(classifyDiagnostic('some unrecognized secret text'), undefined);
});
test('child nonzero after final, timeout, malformed output, and output cap fail closed', async () => {
  const options = { cwd: process.cwd(), env: process.env, input: '', timeoutMs: 1000 };
  await assert.rejects(captureChild(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(jsonl(events))});process.exitCode=1`], options), /CHILD_FAILED/);
  await assert.rejects(captureChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, timeoutMs: 100 }), /TIMEOUT/);
  await assert.rejects(captureChild(process.execPath, ['-e', 'process.stdout.write("x".repeat(3000000))'], options), /OUTPUT_LIMIT/);
  assert.throws(() => parseHeadless('not-json\n'), /MALFORMED_EVENTS/);
});
test('stderr classifies split known diagnostics and HTTP status without retaining raw errors', async () => {
  const options = {cwd:process.cwd(),env:process.env,input:'',timeoutMs:1000};
  await assert.rejects(captureChild(process.execPath, ['-e', 'process.stderr.write("SDK_AUTH_");setTimeout(()=>{process.stderr.write("REQUIRED secret-sentinel");process.exitCode=1},10)'], options), error => {
    assert.equal(error.code, 'SDK_AUTH_REQUIRED'); assert.equal(error.message, 'SDK_AUTH_REQUIRED'); return true;
  });
  await assert.rejects(captureChild(process.execPath, ['-e', 'process.stderr.write("SDK_REQUEST_FAILED (HTTP 400) secret-sentinel");process.exitCode=1'], options), {code:'HTTP_400'});
  await assert.rejects(captureChild(process.execPath, ['-e', 'process.stderr.write("UNLISTED_SECRET_CODE secret-sentinel");process.exitCode=1'], options), {code:'CHILD_FAILED'});
});
test('runner invokes native rdsh route, validates telemetry, and removes isolated home', async t => {
  const { root, request } = fixture(t);
  let seen;
  const spawnImpl = (binary, args, options) => {
    seen = { binary, args, options };
    const patch = args[args.lastIndexOf('--patch') + 1];
    const text = readFileSync(patch, 'utf8'); const telemetry = JSON.parse(text.match(/telemetryPath: (".*")/)[1]);
    assert.match(text, /- id: tools\n  config:\n    mode: native\n/);
    const script = `require('node:fs').writeFileSync(${JSON.stringify(telemetry)},${JSON.stringify(JSON.stringify({version:1,provider:request.provider,model:request.model,calls:1,inflight:0,usage:emptyUsage(),trace:[],outcome:'completed',failure:null}))});process.stdout.write(${JSON.stringify(jsonl(events))});process.stdin.resume();`;
    return spawn(process.execPath, ['-e', script], options);
  };
  const result = await runRequest(request, { env:{...process.env,DSH_TOOLS_MODE:'ptc'}, spawnImpl });
  assert.equal(result.ok, true); assert.equal(result.text, 'OK');
  assert.match(seen.binary, /rdsh$/); assert.deepEqual(seen.args.slice(0, 4), ['--profile', 'harness2', '--from-default-profile', 'headless']);
  assert.deepEqual(seen.args.slice(-3), ['--', '--json', '-']); assert.ok(!seen.args.includes('--no-slim'));
  assert.notEqual(seen.options.env.DSH_HOME, process.env.DSH_HOME); assert.match(seen.options.env.RDSH_ORIG_BIN, /dsh\/lib\/bin.js$/);
  assert.deepEqual(readdirSync(root), ['workspace']);
});
test('failed child preserves observed usage and trace while reporting no successful answer', async t => {
  const { request } = fixture(t);
  const spawnImpl = (_binary, args, options) => {
    const patch = readFileSync(args[args.lastIndexOf('--patch') + 1], 'utf8');
    const telemetry = JSON.parse(patch.match(/telemetryPath: (".*")/)[1]);
    const state = {version:1,provider:request.provider,model:request.model,calls:1,inflight:0,usage:{...emptyUsage(),inputTokens:12,outputTokens:3},trace:[{type:'answer',text:'partial'}],outcome:'error',failure:null};
    return spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(telemetry)},${JSON.stringify(JSON.stringify(state))});process.stdout.write(${JSON.stringify(jsonl(events))});process.stdin.resume();process.exitCode=1;`], options);
  };
  await assert.rejects(runRequest(request, { spawnImpl }), error => {
    assert.equal(error.result.ok, false); assert.equal(error.result.text, ''); assert.equal(error.result.usage.inputTokens, 12); assert.equal(error.result.trace.at(-1).type, 'error'); return true;
  });
});
test('killing an active second call never reports completed first-call usage as the run total', async t => {
  const { request } = fixture(t); request.timeoutMs = 150;
  const spawnImpl = (_binary, args, options) => {
    const patch = readFileSync(args[args.lastIndexOf('--patch') + 1], 'utf8');
    const telemetry = JSON.parse(patch.match(/telemetryPath: (".*")/)[1]);
    const state = {version:1,provider:request.provider,model:request.model,calls:2,inflight:1,usage:{inputTokens:12,outputTokens:3,cacheReadTokens:0,cacheWriteTokens:0},trace:[{type:'answer',text:'first call'}],outcome:null,failure:null};
    return spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(telemetry)},${JSON.stringify(JSON.stringify(state))});setInterval(()=>{},1000);`], options);
  };
  await assert.rejects(runRequest(request, { spawnImpl }), error => {
    assert.equal(error.code, 'TIMEOUT'); assert.deepEqual(error.result.usage, emptyUsage()); assert.equal(error.result.trace[0].text, 'first call'); return true;
  });
});
test('installed Cordis ToolRuntime enforces guard and real prompt assembly', async t => {
  const installation = process.env.RDSH_HARNESS2_DSH_PACKAGE || join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh');
  const modules = process.env.RDSH_PUBLIC_DSH_MODULES || join(installation, 'node_modules');
  const modulePath = name => join(modules, '@deepseek-ai', name, 'lib/index.js');
  if (!['cordis','dsh-system-prompt','dsh-tools'].every(name => existsSync(modulePath(name)))) { t.skip('DSH public modules unavailable; set RDSH_PUBLIC_DSH_MODULES or RDSH_HARNESS2_DSH_PACKAGE'); return; }
  const [{ Context }, { SystemPrompt }, { ToolRuntime }] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools'].map(name => import(pathToFileURL(modulePath(name)).href)));
  const { root, workspace, request } = fixture(t);
  const ctx = new Context(); new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false }); const tools = new ToolRuntime(ctx, {});
  t.after(() => ctx.fiber.dispose());
  writeFileSync(join(workspace, 'input.txt'), 'runtime evidence'); symlinkSync(root, join(workspace, 'outside'));
  const requestPath = join(root, 'request.json'), telemetryPath = join(root, 'telemetry.json'); writeFileSync(requestPath, JSON.stringify(request));
  let shellCalls = 0;
  tools.register({name:'bash',description:'Forbidden test shell',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},async execute(){shellCalls++;return 'bad';}});
  apply(ctx, { requestPath, telemetryPath });
  const assembly = await ctx.systemPrompt.assemble(); assert.deepEqual(assembly.tools.map(tool => tool.name), [READ_TOOL]);
  const call = (name, args) => tools.execute({name,arguments:args,callId:'fixture-call',signal:new AbortController().signal});
  const read = await call(READ_TOOL, {path:'input.txt'}); assert.equal(read.isError, false); assert.equal(read.content[0].text, 'runtime evidence');
  assert.equal((await call('bash', {})).isError, true); assert.equal(shellCalls, 0);
  assert.equal((await call('unknown', {})).isError, true);
  assert.equal((await call(READ_TOOL, {path:'outside/request.json'})).isError, true);
});
