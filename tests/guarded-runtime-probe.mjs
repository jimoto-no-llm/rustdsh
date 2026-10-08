// Used in an isolated Node process with the mandatory preload.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(process.env.RDSH_TOOL_RUNTIME, '../../..');
const { Context } = await import(pathToFileURL(path.join(root, 'cordis/lib/index.js')));
const { createScope } = await import(pathToFileURL(path.join(root, 'dsh-scope/lib/index.js')));
const { default: ToolRuntime } = await import(pathToFileURL(process.env.RDSH_TOOL_RUNTIME));
const ctx = new Context();
ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 1; } });
const tools = new ToolRuntime(ctx, { mode: 'ptc' });
assert.equal(tools.defaultMode, 'native');
assert.equal(tools.modeFor(), 'native');
const agent = {};
const scoped = createScope(ctx, agent);
agent.ctx = scoped.ctx;
scoped.ctx.tools.presentAs('ptc');
assert.equal(scoped.ctx.tools.modeFor(), 'native');
assert.equal(scoped.ctx.tools.collapses('rdsh_inspect', undefined, false), false);
assert.ok(tools.guardReason({ name: 'bash' }));
assert.ok(tools.guardReason({ name: 'run_code' }));
assert.equal(tools.guardReason({ name: 'rdsh_inspect' }), undefined);
const result = await tools.get('rdsh_inspect').execute({ command: 'printf DUMMY_GUARDED_RUNTIME' });
assert.equal(result.exitCode, 0, result.stderr);
assert.equal(result.stdout, 'DUMMY_GUARDED_RUNTIME');
const dispatched = await tools.execute({ name: 'rdsh_inspect', arguments: { command: 'printf DUMMY_MODEL_DISPATCH' }, agent, callId: 'dummy-dispatch', signal: new AbortController().signal });
assert.match(JSON.stringify(dispatched), /DUMMY_MODEL_DISPATCH/);
let invoked = false;
let blockedPrePolicy = false;
ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.callId === 'dummy-blocked') blockedPrePolicy = true;
  return next();
});
tools.register({ ...tools.get('rdsh_inspect'), name: 'blocked_probe', async execute() { invoked = true; return {}; } });
const blocked = await tools.execute({ name: 'blocked_probe', arguments: {}, agent, callId: 'dummy-blocked', signal: new AbortController().signal });
assert.equal(invoked, false);
assert.equal(blockedPrePolicy, false, 'a forbidden tool must not reach approval middleware');
assert.match(JSON.stringify(blocked), /RDSH_SECURITY/);
let shadowInvoked = false;
ctx.on('tools/execute', async (exec, next) => {
  if (exec.callId === 'dummy-after-policy') exec.name = 'blocked_probe';
  if (exec.callId === 'dummy-late-shadow') {
    scoped.ctx.tools.register({ ...tools.get('rdsh_inspect'), async execute() { shadowInvoked = true; return { exitCode: 0, stdout: 'DUMMY_SHADOW', stderr: '' }; } });
  }
  return next();
});
for (const callId of ['dummy-after-policy', 'dummy-late-shadow']) {
  const rewritten = await tools.execute({ name: 'rdsh_inspect', arguments: { command: 'printf DUMMY_REWRITTEN' }, agent, callId, signal: new AbortController().signal });
  assert.equal(invoked, false, 'around-dispatch middleware must not switch to a blocked tool');
  assert.equal(shadowInvoked, false, 'a late scoped replacement must not bypass the guard');
  assert.match(JSON.stringify(rewritten), /RDSH_SECURITY/);
}
console.log('guarded runtime dispatched inspection and rejected other tools with kernel isolation');
