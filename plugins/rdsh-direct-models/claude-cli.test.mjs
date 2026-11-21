import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { claudeArguments, createClaudeCliRunner, createClaudeCliBackend } from './claude-cli.mjs';

const turn = JSON.stringify({ version: 1, text: 'OK', toolCalls: [] });
const reply = (overrides = {}) => ({ type: 'result', subtype: 'success', is_error: false,
  num_turns: 1, permission_denials: [], result: turn,
  usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 5 }, ...overrides });
function fixture(handler) {
  const state = {};
  state.spawnImpl = (file, args, options) => {
    Object.assign(state, { file, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('data', value => { state.input = value.toString(); });
    child.kill = signal => { state.killed = signal; queueMicrotask(() => child.emit('close', 1)); };
    queueMicrotask(() => handler(child));
    return child;
  };
  return state;
}
function success(child, value = reply()) { child.stdout.end(JSON.stringify(value)); child.emit('close', 0); }

test('Claude child is inference-only, keeps its own login, isolates cwd, and cleans up', async () => {
  const state = fixture(child => success(child));
  const result = await createClaudeCliRunner({ ...state, env: { HOME: '/home', PATH: '/bin',
    CLAUDE_CONFIG_DIR: '/own-login', DSH_HOME: '/copied-tokens', NODE_OPTIONS: 'injected-code',
    CLAUDECODE: 'nested', OTHER_TOKEN: 'secret' } })({ model: 'claude-opus-5-5', prompt: 'literal $(unsafe)' });
  assert.equal(state.file, 'claude'); assert.equal(state.options.shell, false);
  assert.deepEqual(state.options.env, { HOME: '/home', PATH: '/bin', CLAUDE_CONFIG_DIR: '/own-login' });
  assert.equal(state.input, 'literal $(unsafe)');
  const args = state.args;
  for (const pair of [['--tools', ''], ['--mcp-config', '{"mcpServers":{}}'], ['--setting-sources', ''],
    ['--settings', '{"disableAllHooks":true}'], ['--max-turns', '1']])
    assert.ok(args.some((value, i) => value === pair[0] && args[i + 1] === pair[1]));
  assert.ok(args.includes('-p')); assert.ok(args.includes('--no-session-persistence'));
  assert.ok(!args.includes('--bare')); assert.ok(!args.some(v => v.includes('skip-permissions')));
  assert.notEqual(state.options.cwd, process.cwd());
  await assert.rejects(access(state.options.cwd), { code: 'ENOENT' });
  assert.equal(result.text, turn);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 10 });
});
test('raw auth and process diagnostics never escape failures', async () => {
  for (const value of [reply({ is_error: true, result: 'PRIVATE-REFRESH-TOKEN' }),
    reply({ permission_denials: [{}] }), reply({ num_turns: 2 })]) {
    const state = fixture(child => { child.stderr.write('PRIVATE-REFRESH-TOKEN'); success(child, value); });
    await assert.rejects(createClaudeCliRunner(state)({ model: 'opus', prompt: 'request' }),
      error => !error.message.includes('PRIVATE-REFRESH-TOKEN'));
    await assert.rejects(access(state.options.cwd), { code: 'ENOENT' });
  }
});
test('invalid model, pre-abort and unsupported controls cannot spawn a CLI', async () => {
  let calls = 0;
  const runner = createClaudeCliRunner({ spawnImpl: () => { calls++; throw Error('must not spawn'); } });
  for (const model of ['-p', '', 'opus\n--tools shell']) await assert.rejects(runner({ model, prompt: 'p' }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runner({ model: 'opus', prompt: 'p' }, { signal: controller.signal }));
  for (const option of [{ temperature: 0 }, { maxTokens: 1 }, { stop: [] }])
    await assert.rejects(createClaudeCliBackend({ runner }).generate({ model: 'opus', ...option }), { code: 'UNSUPPORTED_GENERATION_OPTION' });
  assert.equal(calls, 0);
});
test('abort and timeout wait for child close before removing the isolated workspace', async () => {
  for (const timeout of [false, true]) {
    const controller = new AbortController();
    const state = fixture(() => { if (!timeout) controller.abort(); });
    const keepAlive = setTimeout(() => {}, 100);
    try {
      await assert.rejects(createClaudeCliRunner({ ...state, timeoutMs: 10 })({ model: 'opus', prompt: 'p' }, { signal: controller.signal }), timeout ? /timed out/ : /aborted/);
      assert.equal(state.killed, 'SIGKILL');
      await assert.rejects(access(state.options.cwd), { code: 'ENOENT' });
    } finally { clearTimeout(keepAlive); }
  }
});
test('enclosing JSON fences are accepted, missing counters stay unknown, bad counters fail', async () => {
  const state = fixture(child => success(child, reply({ result: '```json\n' + turn + '\n```', usage: undefined })));
  const result = await createClaudeCliRunner(state)({ model: 'opus', prompt: 'p' });
  assert.equal(result.text, turn); assert.equal(result.usage, undefined);
  for (const usage of [{ input_tokens: -1, output_tokens: 1 }, { input_tokens: 1, output_tokens: '2' }]) {
    const bad = fixture(child => success(child, reply({ usage })));
    await assert.rejects(createClaudeCliRunner(bad)({ model: 'opus', prompt: 'p' }), /invalid usage/);
  }
});
test('JSON repair is bounded and its actual usage is accumulated; no tool executes in CLI', async () => {
  const calls = [], tool = { name: 'web_search', parameters: { type: 'object', required: ['queries'],
    properties: { queries: { type: 'array', items: { type: 'string' } } } } };
  const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
  const backend = createClaudeCliBackend({ runner: async p => {
    calls.push(p);
    return { usage, text: calls.length === 1 ? 'invalid' : JSON.stringify({ version: 1, text: '',
      toolCalls: [{ id: 'call', name: 'web_search', arguments: { queries: ['public query'] } }] }) };
  } });
  const result = await backend.generate({ model: 'opus', messages: [], tools: [tool] });
  assert.equal(calls.length, 2); assert.match(calls[1].prompt, /failed validation/);
  assert.deepEqual(result.toolCalls, [{ id: 'call', name: 'web_search', arguments: '{"queries":["public query"]}' }]);
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 8 });
  let attempts = 0;
  await assert.rejects(createClaudeCliBackend({ runner: async () => { attempts++; return { text: 'invalid' }; } }).generate({ model: 'opus' }));
  assert.equal(attempts, 2);
});
test('CLI aliases and caller supplied installed model catalog are discovery-only', async () => {
  assert.deepEqual((await createClaudeCliBackend().discover()).map(m => m.id), ['opus', 'sonnet', 'haiku']);
  assert.deepEqual(await createClaudeCliBackend({ models: async () => [{ id: 'installed-claude' }] }).discover(), [{ id: 'installed-claude' }]);
  const args = claudeArguments('literal');
  assert.equal(args[args.indexOf('--model') + 1], 'literal');
});
