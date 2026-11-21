import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, definition } from '../index.js';

const content = [{ type: 'text', text: 'CHILD_READ_WRITE_DONE' }];
function fixture({ selection = true, available = true, result, run } = {}) {
  const calls = [], deferred = [];
  let concluded = 0;
  const agent = {};
  const controller = new AbortController();
  const exec = { agent, callId: 'outer', rootCallId: 'root', token: Symbol('parent'), signal: controller.signal,
    deferContext(context) { deferred.push(context); }, concludeTurn() { concluded++; } };
  const tools = {
    schemas(scope) {
      assert.equal(scope, agent);
      return available ? [{ name: 'subagent', parameters: { properties: selection ? { provider: {}, model: {} } : {} } }] : [];
    },
    async execute(input) {
      calls.push(input);
      return run ? run(input) : result ?? { isError: false, value: { kind: 'foreground', runId: 'child', output: [] }, content };
    },
  };
  return { tool: definition(tools), exec, calls, deferred, controller, get concluded() { return concluded; } };
}

test('delegates once through the scoped policy pipeline and waits in foreground', async () => {
  const f = fixture();
  const result = await f.tool.execute({ prompt: 'Read input.txt and write output.txt', provider: 'allowed', model: 'allowed-model' }, f.exec);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.name, 'subagent');
  assert.equal(call.agent, f.exec.agent);
  assert.equal(call.signal, f.exec.signal);
  assert.equal(call.parent, f.exec.token);
  assert.equal(call.rootCallId, 'root');
  assert.match(call.callId, /^outer:model-call:/);
  assert.deepEqual(call.arguments, { description: 'Delegated model workspace task', prompt: 'Read input.txt and write output.txt', run_in_background: false, provider: 'allowed', model: 'allowed-model' });
  assert.deepEqual(result.result, { kind: 'foreground', runId: 'child', output: [] });
  assert.deepEqual(f.tool.output.render({}, result), content);
});

test('omitting a route retains DSH defaults instead of inventing a model', async () => {
  const f = fixture({ selection: false });
  await f.tool.execute({ prompt: 'task' }, f.exec);
  assert.equal(Object.hasOwn(f.calls[0].arguments, 'provider'), false);
  assert.equal(Object.hasOwn(f.calls[0].arguments, 'model'), false);
});

test('validates input and disabled model selection before dispatch', async () => {
  for (const input of [null, [], {}, { prompt: '' }, { prompt: ' ' }, { prompt: 'x'.repeat(16385) },
    { prompt: 'task', provider: 'p' }, { prompt: 'task', model: 'm' }, { prompt: 'task', provider: '', model: 'm' },
    { prompt: 'task', command: 'arbitrary command' }, { prompt: 'task', provider: null, model: null }]) {
    const f = fixture();
    await assert.rejects(f.tool.execute(input, f.exec));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ selection: false });
  await assert.rejects(f.tool.execute({ prompt: 'task', provider: 'p', model: 'm' }, f.exec), { code: 'MODEL_CALL_SELECTION_DISABLED' });
  assert.equal(f.calls.length, 0);
});

test('requires a calling agent and subagent visible in that exact scope', async () => {
  const f = fixture({ available: false });
  await assert.rejects(f.tool.execute({ prompt: 'task' }, f.exec), { code: 'MODEL_CALL_SUBAGENT_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.tool.execute({ prompt: 'task' }, { ...f.exec, agent: undefined }), { code: 'MODEL_CALL_AGENT' });
});

test('inherits host route rejection and preserves failure plus additional contexts', async () => {
  const context = { role: 'user', content: [{ type: 'text', text: 'policy context' }] };
  const f = fixture({ result: { isError: true, error: { message: 'route is not allowed', info: { name: 'RouteError', code: 'ROUTE_DENIED' } }, content: [], additionalContexts: [context] } });
  await assert.rejects(f.tool.execute({ prompt: 'task', provider: 'unlisted', model: 'unlisted' }, f.exec), { name: 'RouteError', code: 'ROUTE_DENIED', message: 'route is not allowed' });
  assert.deepEqual(f.deferred, [context]);
  assert.equal(f.concluded, 0);
});

test('success forwards deferred contexts and authoritative turn conclusion', async () => {
  const contexts = [{ role: 'user', content: [] }, { role: 'user', content: [] }];
  const f = fixture({ result: { isError: false, value: { output: [] }, content, additionalContexts: contexts, concludesTurn: true } });
  await f.tool.execute({ prompt: 'task' }, f.exec);
  assert.deepEqual(f.deferred, contexts);
  assert.equal(f.concluded, 1);
});

test('cancellation before dispatch and after nested completion cannot report success', async () => {
  const f = fixture();
  f.controller.abort(new Error('cancelled before'));
  await assert.rejects(f.tool.execute({ prompt: 'task' }, f.exec), /cancelled before/);
  assert.equal(f.calls.length, 0);
  const g = fixture({ run: async () => { g.controller.abort(new Error('cancelled during')); return { isError: false, value: {}, content, concludesTurn: true }; } });
  await assert.rejects(g.tool.execute({ prompt: 'task' }, g.exec), /cancelled during/);
  assert.equal(g.concluded, 0);
});

test('reentrant alias dispatch is rejected and guard is released after error', async () => {
  let nested = true;
  const f = fixture({ run: async () => {
    if (nested) return f.tool.execute({ prompt: 'reentrant' }, f.exec);
    return { isError: false, value: {}, content };
  } });
  await assert.rejects(f.tool.execute({ prompt: 'outer' }, f.exec), { code: 'MODEL_CALL_REENTRANT' });
  nested = false;
  await f.tool.execute({ prompt: 'new call' }, f.exec);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].callId, f.calls[1].callId);
});

test('registers only model_call and disposes its exact registration', () => {
  const registered = [];
  let disposed = 0;
  const ctx = { tools: { schemas: () => [], execute() {}, register(tool) { registered.push(tool.name); return () => disposed++; } }, effect(callback) { return callback(); } };
  const dispose = apply(ctx);
  assert.deepEqual(registered, ['model_call']);
  dispose();
  assert.equal(disposed, 1);
});
