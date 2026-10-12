import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { runMuse } from '../muse.mjs';
import { runWorker } from '../runner.mjs';
import { MuseSubscriptionAdapter, apply } from '../index.js';
import { BridgeError, parseReply, subscriptionEnvironment, tokenUsage, validateRequest } from '../protocol.mjs';

const tools = [{ name: 'Bash', description: 'Fixture tool', parameters: { type: 'object', properties: { command: { type: 'string' } } } }];
const job = (system = 'text') => ({ model: 'muse-wonder-1.0', system, messages: [{ role: 'user', content: [{ type: 'text', text: '42を返して' }] }], tools });
const config = { workerPath: fileURLToPath(new URL('./helper.mjs', import.meta.url)), timeoutMs: 3000, shutdownGraceMs: 200 };
const activeAuth = JSON.stringify({ providers: { meta: { subs_active: true, mechanism: 'oauth', obtained_via: 'device_code', access_token: 'SECRET-AUTH' } } });

function fakeSdk({ nativeTool = false, hanging = false, schemaChanged = false, usage, fail = false } = {}) {
  const state = { spawned: 0, closed: 0, cancelled: 0, options: undefined, returned: 0 };
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const close = async () => { state.closed++; resolveExit({ kind: 'cleanShutdown' }); };
  const host = { close, initializeResult: {}, child: { exit }, fingerprintWarning: schemaChanged,
    connection: { command: async () => { state.cancelled++; } } };
  let pending;
  const iterator = {
    next: async () => {
      if (hanging) return new Promise(resolve => { pending = resolve; });
      if (iterator.done) return { done: true };
      iterator.done = true;
      return { done: false, value: nativeTool ? { kind: 'toolCall' } : { kind: 'agentMessage', text: '{"text":"42","toolCalls":[]}' } };
    },
    return: async () => { state.returned++; pending?.({ done: true }); return { done: true }; },
  };
  const session = { sessionId: 'fixture', onApproval: callback => { state.approval = callback; },
    sendUserTurn: async input => {
      state.prompt = input.input[0].text;
      if (fail) throw new Error('SECRET-AUTH');
      return { turnId: 'fixture-turn', items: () => iterator, completed: Promise.resolve({ kind: 'completed', params: { terminal: 'completed', usage } }) };
    } };
  return {
    state,
    sdk: {
      spawnMspConnection(options) { state.spawned++; state.options = options; return { close, initialize: async () => host }; },
      readSessionDurability: () => 'ephemeral',
      MuseClient: class { close = close; async startSession(options) { state.sessionOptions = options; return session; } },
    },
  };
}

test('rejects images and unknown model/effort before a model call', () => {
  assert.throws(() => validateRequest({ ...job(), model: 'unknown' }), { code: 'MUSE_UNKNOWN_MODEL' });
  assert.throws(() => validateRequest({ ...job(), reasoningEffort: 'unknown' }), { code: 'MUSE_UNKNOWN_MODEL' });
  assert.throws(() => validateRequest({ ...job(), messages: [{ role: 'user', content: [{ type: 'image' }] }] }), { code: 'MUSE_INPUT_INVALID' });
});

test('JSON tool requests are constrained to the current Harness tool list', () => {
  const parsed = parseReply('```json\n{"text":"調べます","toolCalls":[{"name":"Bash","arguments":{"command":"printf 42"}}]}\n```', tools);
  assert.equal(parsed.toolCalls[0].name, 'Bash');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].arguments), { command: 'printf 42' });
  for (const text of ['not json', '{"text":"","toolCalls":[]}', '{"text":"x","toolCalls":[{"name":"unknown","arguments":{}}]}', '{"text":"x","toolCalls":[{"name":"Bash","arguments":[]}]}']) {
    assert.throws(() => parseReply(text, tools), { code: 'MUSE_PROTOCOL_ERROR' });
  }
});

test('removes both API-key variables with Windows case folding and preserves other environment', () => {
  assert.deepEqual(subscriptionEnvironment({ META_API_KEY: 'secret', Model_Api_Key: 'secret', PATH: 'keep' }), { PATH: 'keep' });
});

test('optional or malformed usage remains unknown', () => {
  for (const value of [null, {}, { inputTokens: -1, outputTokens: 2 }, { inputTokens: 1, outputTokens: NaN }]) assert.equal(tokenUsage(value), undefined);
  assert.deepEqual(tokenUsage({ inputTokens: 2, outputTokens: 3, cacheReadTokens: 1 }), { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1 });
});

test('inactive, API-key and missing logins never launch the SDK host', async () => {
  for (const metadata of [{}, { subs_active: false, mechanism: 'oauth', obtained_via: 'device_code' }, { subs_active: 'false', mechanism: 'oauth', obtained_via: 'device_code' }, { subs_active: true, mechanism: 'api_key', obtained_via: 'manual' }]) {
    const fixture = fakeSdk();
    await assert.rejects(runMuse(job(), { sdk: fixture.sdk, readAuth: async () => JSON.stringify({ providers: { meta: metadata } }) }), { code: 'MUSE_SUBSCRIPTION_LOGIN_REQUIRED' });
    assert.equal(fixture.state.spawned, 0);
  }
  for (const readAuth of [async () => 'null', async () => '{broken', async () => { throw Error('missing file'); }]) {
    const fixture = fakeSdk();
    await assert.rejects(runMuse(job(), { sdk: fixture.sdk, readAuth }), { code: 'MUSE_SUBSCRIPTION_LOGIN_REQUIRED' });
    assert.equal(fixture.state.spawned, 0);
  }
});

test('uses an empty temporary workspace, denies native approvals and confirms SDK shutdown', async () => {
  const fixture = fakeSdk();
  const events = [];
  await runMuse({ ...job(), executionWorkspace: '/project' }, { sdk: fixture.sdk, readAuth: async () => activeAuth,
    env: { META_API_KEY: 'SECRET-ENV', MODEL_API_KEY: 'SECRET-ENV', PATH: 'keep' }, emit: event => events.push(event) });
  assert.equal(fixture.state.closed, 1);
  assert.ok(fixture.state.options.args.includes('--disable-shell'));
  assert.ok(fixture.state.options.args.includes('--disable-write'));
  assert.equal(fixture.state.options.args[fixture.state.options.args.indexOf('--contributor-mode') + 1], 'off');
  assert.equal(fixture.state.sessionOptions.approvalMode, 'denyUnmatched');
  assert.match(fixture.state.prompt, /\/project/);
  assert.notEqual(fixture.state.options.cwd, '/project');
  await assert.rejects(stat(fixture.state.options.cwd), { code: 'ENOENT' });
  assert.deepEqual(await fixture.state.approval({ availableChoices: [{ choiceId: 'approve' }, { choiceId: 'deny' }] }), { choiceId: 'deny' });
  assert.equal(events.at(-1).kind, 'cleanShutdown');
  assert.equal(events.find(event => event.type === 'response').tokenUsage, undefined);
  assert.ok(!JSON.stringify(events).includes('SECRET'));
});

test('native tool activity, schema drift and raw SDK errors are rejected', async () => {
  for (const [options, code] of [[{ nativeTool: true }, 'MUSE_NATIVE_TOOL_USED'], [{ schemaChanged: true }, 'MUSE_SCHEMA_CHANGED'], [{ fail: true }, 'MUSE_UNAVAILABLE']]) {
    const fixture = fakeSdk(options);
    await assert.rejects(runMuse(job(), { sdk: fixture.sdk, readAuth: async () => activeAuth }), error => error.code === code && !error.message.includes('SECRET'));
    assert.equal(fixture.state.closed, 1);
  }
});

test('cancelling a pending SDK iterator closes the owned host and settles without a model terminal', { timeout: 4000 }, async () => {
  const fixture = fakeSdk({ hanging: true });
  const controller = new AbortController();
  const run = runMuse(job(), { sdk: fixture.sdk, signal: controller.signal, readAuth: async () => activeAuth,
    emit: event => { if (event.type === 'ready') setImmediate(() => controller.abort()); } });
  await assert.rejects(run, { code: 'ABORTED' });
  assert.equal(fixture.state.closed, 1);
  assert.equal(fixture.state.cancelled, 1);
  assert.ok(fixture.state.returned >= 1);
});

test('real helper stdio preserves Japanese, tool calls and optional usage', async () => {
  assert.equal((await runWorker(job(), config)).response.text, '日本語で42');
  assert.equal((await runWorker(job('tool'), config)).response.toolCalls[0].name, 'Bash');
  assert.deepEqual((await runWorker(job('usage'), config)).tokenUsage, { inputTokens: 10, outputTokens: 3 });
});

test('helper failure cannot be mistaken for successful completion or leak diagnostics', async () => {
  for (const mode of ['invalid', 'duplicate', 'no-clean-exit', 'secret-error']) {
    await assert.rejects(runWorker(job(mode), config), error => error instanceof BridgeError && !error.message.includes('SECRET'));
  }
  await assert.rejects(runWorker(job(), { ...config, nodeCommand: '/nonexistent/rdsh-fixture-node' }), { code: 'MUSE_UNAVAILABLE' });
});

test('user cancellation, timeout and an unresponsive helper all settle', { timeout: 8000 }, async () => {
  const controller = new AbortController();
  let helper;
  const run = runWorker(job('wait'), config, controller.signal, (...args) => {
    helper = spawn(...args); helper.stdout.once('data', () => controller.abort()); return helper;
  });
  await assert.rejects(run, { code: 'ABORTED' });
  assert.notEqual(helper.exitCode, null);
  await assert.rejects(runWorker(job('wait'), { ...config, timeoutMs: 200 }), { code: 'MUSE_TIMEOUT' });
  await assert.rejects(runWorker(job('wedged'), { ...config, timeoutMs: 200 }), { code: 'MUSE_TIMEOUT' });
});

test('Harness adapter emits the native text/tool vocabulary and provider registration disposes', async () => {
  const ctx = { sessions: { get: () => ({ header: { cwd: '/fixture-project' } }) } };
  const adapter = new MuseSubscriptionAdapter(ctx, config);
  assert.deepEqual((await adapter.listModels('muse-code')).map(model => model.id), ['muse-wonder-1.0', 'muse-wonder-full-1.0']);
  await assert.rejects(adapter.resolveModel('muse-code', 'unknown'));
  const events = [];
  for await (const event of adapter.stream({ ...job('tool'), sessionId: 'fixture' })) events.push(event);
  assert.equal(events.find(event => event.type === 'block-end' && event.block.type === 'tool-call').block.name, 'Bash');
  assert.equal(events.at(-1).reason.kind, 'tool-calls');
  let dispose, unregistered = false;
  apply({ ...ctx, llm: { registerAdapter: (providers, registered) => {
    assert.deepEqual(providers, ['muse-code']); assert.ok(registered instanceof MuseSubscriptionAdapter); return () => { unregistered = true; };
  } }, on: (name, callback) => { assert.equal(name, 'dispose'); dispose = callback; } }, config);
  await dispose(); assert.equal(unregistered, true);
});

test('Harness disposal aborts active inference and emits an aborted finish', { timeout: 5000 }, async () => {
  const adapter = new MuseSubscriptionAdapter({ sessions: { get: () => null } }, config);
  const events = [];
  const run = (async () => { for await (const event of adapter.stream(job('wait'))) events.push(event); })();
  await new Promise(resolve => setTimeout(resolve, 100));
  await adapter.dispose(); await run;
  assert.equal(events.at(-1).reason.kind, 'aborted');
});

test('disposal does not wait for a UI consumer paused at a buffered answer', { timeout: 4000 }, async () => {
  const adapter = new MuseSubscriptionAdapter({ sessions: { get: () => null } }, config);
  const stream = adapter.stream(job());
  assert.equal((await stream.next()).value.type, 'block-start');
  await adapter.dispose();
  await stream.return();
});
