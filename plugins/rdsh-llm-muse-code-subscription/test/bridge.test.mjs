import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { runMuse } from '../muse.mjs';
import { runWorker } from '../runner.mjs';
import { MuseSubscriptionAdapter, apply } from '../index.js';
import { BridgeError, normalizeCatalog, parseReply, subscriptionEnvironment, tokenUsage, validateRequest } from '../protocol.mjs';
import { catalog } from './catalog.mjs';

const tools = [{ name: 'Bash', description: 'Fixture tool', parameters: { type: 'object', properties: { command: { type: 'string' } } } }];
const job = (system = 'text') => ({ model: 'muse-wonder-1.0', system, messages: [{ role: 'user', content: [{ type: 'text', text: '42を返して' }] }], tools });
const config = { workerPath: fileURLToPath(new URL('./helper.mjs', import.meta.url)), timeoutMs: 3000, shutdownGraceMs: 200 };
const activeAuth = JSON.stringify({ providers: { meta: { subs_active: true, mechanism: 'oauth', obtained_via: 'device_code', access_token: 'SECRET-AUTH' } } });

function fakeSdk({ nativeTool = false, hanging = false, schemaChanged = false, usage, fail = false, models } = {}) {
  const state = { spawned: 0, closed: 0, cancelled: 0, options: undefined, returned: 0, turns: 0, queries: 0 };
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const close = async () => { state.closed++; resolveExit({ kind: 'cleanShutdown' }); };
  const host = { close, initializeResult: {}, child: { exit }, fingerprintWarning: schemaChanged,
    connection: { command: async () => { state.cancelled++; }, request: async (method, params) => {
      assert.equal(method, 'model/list'); assert.deepEqual(params, {}); state.queries++;
      return models ?? catalog(state.options.args[state.options.args.indexOf('--contributor-mode') + 1]);
    } } };
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
      state.turns++;
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

test('rejects unsupported input and mode before any child is started', () => {
  assert.throws(() => validateRequest({ ...job(), model: '' }), { code: 'MUSE_UNKNOWN_MODEL' });
  assert.throws(() => validateRequest({ ...job(), contributorMode: 'maybe' }), { code: 'MUSE_INPUT_INVALID' });
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
  assert.equal(fixture.state.options.env.HOME, homedir());
  assert.equal(fixture.state.options.env.USERPROFILE, homedir());
  assert.equal(fixture.state.options.env.XDG_CONFIG_HOME, join(homedir(), '.config'));
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
  assert.deepEqual((await adapter.listModels('muse-code')).map(model => model.id), catalog().models.map(model => model.modelId));
  await assert.rejects(adapter.resolveModel('muse-code', 'unknown'));
  const events = [];
  for await (const event of adapter.stream({ ...job('tool'), sessionId: 'fixture' })) events.push(event);
  assert.equal(events.find(event => event.type === 'block-end' && event.block.type === 'tool-call').block.name, 'Bash');
  assert.equal(events.at(-1).reason.kind, 'tool-calls');
  let dispose, unregistered = false;
  apply({ ...ctx, llm: { registerAdapter: (providers, registered) => {
    assert.deepEqual(providers, ['muse-code', 'muse-code-contributor']); assert.ok(registered instanceof MuseSubscriptionAdapter); return () => { unregistered = true; };
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
  const controller = new AbortController(); controller.abort();
  const aborted = adapter.stream({ ...job(), signal: controller.signal });
  assert.equal((await aborted.next()).value.reason.kind, 'aborted');
  await adapter.dispose(); await aborted.return();
});

test('discovers the full CLI catalog without reading credentials or starting a model turn', async () => {
  const fixture = fakeSdk(); const events = [];
  await runMuse({ operation: 'list-models' }, { sdk: fixture.sdk, readAuth: async () => { assert.fail('discovery must not need a login'); }, emit: event => events.push(event) });
  assert.deepEqual(events.find(event => event.type === 'models').catalog.models.map(row => row.modelId), catalog().models.map(row => row.modelId));
  assert.equal(fixture.state.queries, 1); assert.equal(fixture.state.turns, 0); assert.equal(fixture.state.closed, 1);
});

test('future catalog models work without editing a fixed model allowlist', async () => {
  const models = catalog(); models.models.push({ ...models.models[0], modelId: 'muse-future-2.0', displayLabel: 'Future model' });
  const fixture = fakeSdk({ models });
  await runMuse({ ...job(), model: 'muse-future-2.0' }, { sdk: fixture.sdk, readAuth: async () => activeAuth });
  assert.equal(fixture.state.sessionOptions.modelId, 'muse-future-2.0'); assert.equal(fixture.state.turns, 1);
});

test('absent model ids and model-specific unsupported efforts stop before inference', async () => {
  for (const request of [{ ...job(), model: 'muse-not-in-catalog' }, { ...job(), model: 'muse-spark-1.2', reasoningEffort: 'max' }]) {
    const fixture = fakeSdk();
    await assert.rejects(runMuse(request, { sdk: fixture.sdk, readAuth: async () => activeAuth }), { code: 'MUSE_UNKNOWN_MODEL' });
    assert.equal(fixture.state.turns, 0);
  }
});

test('Contributor is an explicit per-request mode using the CLI catalog model id', async () => {
  const fixture = fakeSdk();
  await runMuse({ ...job(), model: 'muse-spark-1.3', contributorMode: 'on' }, { sdk: fixture.sdk, readAuth: async () => activeAuth });
  assert.equal(fixture.state.options.args[fixture.state.options.args.indexOf('--contributor-mode') + 1], 'on');
  assert.equal(fixture.state.sessionOptions.modelId, 'muse-spark-1.3');
  const adapter = new MuseSubscriptionAdapter({ sessions: { get: () => null } }, config);
  for (const [provider, expected] of [[undefined, 'off'], ['muse-code', 'off'], ['muse-code-contributor', 'on']]) {
    const events = [];
    for await (const event of adapter.stream({ ...job('inspect-mode'), provider })) events.push(event);
    assert.equal(events.find(event => event.type === 'text-delta').text, expected);
  }
});

test('guard and CLI auth roots match; unrelated authFile overrides cannot authorize a different account', async () => {
  for (const authFile of [join(homedir(), 'another-account/auth.json'), join(homedir(), 'second-account/auth.json')]) {
    const fixture = fakeSdk();
    await assert.rejects(runMuse({ ...job(), runtime: { authFile } }, { sdk: fixture.sdk, readAuth: async () => { assert.fail('must reject mismatched root before reading'); } }), { code: 'MUSE_AUTH_STORE_MISMATCH' });
    assert.equal(fixture.state.spawned, 0);
  }
  const fixture = fakeSdk(); let inspected;
  await runMuse(job(), { sdk: fixture.sdk, readAuth: async file => { inspected = file; return activeAuth; }, env: { HOME: '/other-account', USERPROFILE: '/other-account', XDG_CONFIG_HOME: '/other-config' } });
  assert.equal(inspected, join(fixture.state.options.env.HOME, '.config/muse/auth.json'));
});

test('catalog capabilities stay unknown when undeclared and reject wrong providers or fake catalogs', () => {
  const empty = { ...catalog(), models: [] };
  assert.deepEqual(normalizeCatalog(empty).models, []);
  const models = catalog(); models.models[0] = { ...models.models[0], contextLimit: null, outputLimit: null, variants: 'unknown' };
  assert.equal(normalizeCatalog(models).models[0].contextLimit, null);
  assert.equal(normalizeCatalog(models).models[0].defaultReasoningEffort, undefined);
  for (const invalid of [{ ...catalog(), providerId: 'fake' }, { ...catalog(), source: 'fakeCatalog' }]) assert.throws(() => normalizeCatalog(invalid), { code: 'MUSE_PROTOCOL_ERROR' });
});

test('picker caches discovery once per mode and uses the CLI context/output/effort metadata', async () => {
  const adapter = new MuseSubscriptionAdapter({ sessions: { get: () => null } }, config);
  const [first, second] = await Promise.all([adapter.listModels('muse-code'), adapter.listModels('muse-code')]);
  assert.equal(first, second);
  assert.equal((await adapter.resolveModel('muse-code', 'muse-spark-1.2')).reasoning.efforts.some(tier => tier.id === 'max'), false);
  assert.equal(first[0].context.contextWindow, 1007997); assert.equal(first[0].defaultMaxTokens, 128000);
  const contributor = await adapter.listModels('muse-code-contributor');
  assert.match(contributor[0].name, /Contributor（学習利用）/);
  assert.equal(contributor.find(model => model.id === 'muse-spark-1.3').reasoning.defaultEffort, 'max');
  await adapter.dispose();
});
