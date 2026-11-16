// The other forms the adapter speaks, each against the emulator over HTTP:
// xAI (Responses), Anthropic on demand, Anthropic threshold, and stopping
// right after a compaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, checkProviders, PAUSE_NOTICE } from '../adapter.mjs';
import { merge, messageItems } from '../anthropic.mjs';
import { createEmulator, listen } from '../../../tools/responses-emulator/server.mjs';

class LlmAdapter {}
let nextId = 0;
const user = text => ({ id: `m-${++nextId}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
const system = text => ({ role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } });
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }
const assistant = chunks => ({ id: `m-${++nextId}`, role: 'assistant', content: chunks.filter(c => c.type === 'block-end').map(c => c.block),
  source: { kind: 'model', provider: 'route', model: 'm', replayState: chunks.at(-1).replayState } });
const textOf = chunks => chunks.filter(c => c.type === 'block-end').map(c => c.block.text).join('');

async function setup(route, model, { minTrigger } = {}) {
  const calls = [];
  const emulator = createEmulator({ ...(minTrigger ? { minTrigger } : {}), chat: async ({ messages }) => {
    calls.push(messages);
    const last = messages.at(-1).content ?? '';
    return { content: last.startsWith('Summarize the conversation above') ? 'SUMMARY: port 8443' : `echo:${last}`,
      toolCalls: [], finish: 'stop', usage: { prompt_tokens: 10, completion_tokens: 2 } };
  } });
  const port = await listen(emulator.server);
  const sent = [];
  const adapter = createAdapter({ LlmAdapter, key: () => 'synthetic-key',
    fetch: (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return fetch(url, init); },
    providers: { route: { baseURL: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'ROUTE_KEY', ...route,
      models: [{ id: 'm', contextWindow: 200000, maxTokens: 512, ...model }] } } });
  const ask = (messages, extra = {}) => collect(adapter.stream({ provider: 'route', model: 'm', messages, ...extra }));
  return { ask, emulator, calls, sent, close: () => new Promise(done => emulator.server.close(done)) };
}
const big = 'the port is 8443 ' + 'x'.repeat(800);

test('an xAI route compacts through the same Responses endpoints', async () => {
  const t = await setup({ api: 'xai-responses' }, { compactAtTokens: 120 });
  try {
    const history = [user(big)];
    history.push(assistant(await t.ask(history)), user('which port?'));
    const second = await t.ask(history);
    assert.deepEqual(t.emulator.log.map(entry => entry.path), ['/responses', '/responses/compact', '/responses']);
    assert.equal(second.at(-1).replayState.response.window.items[0].type, 'compaction');
    assert.equal(t.sent[1].init.headers.authorization, 'Bearer synthetic-key');
  } finally { await t.close(); }
});

test('with pauseAfterCompaction the turn stops after compacting and the next message continues from the window', async () => {
  const t = await setup({}, { compactAtTokens: 120, pauseAfterCompaction: true });
  try {
    const history = [user(big)];
    history.push(assistant(await t.ask(history)), user('which port?'));
    const paused = await t.ask(history);
    // Compaction ran; the model was not asked to answer.
    assert.deepEqual(t.emulator.log.map(entry => entry.path), ['/responses', '/responses/compact']);
    assert.equal(textOf(paused), PAUSE_NOTICE);
    assert.deepEqual(paused.at(-1).reason, { kind: 'stop' });
    const window = paused.at(-1).replayState.response.window;
    assert.equal(window.covered, 2);

    history.push(assistant(paused), user('go on'));
    await t.ask(history);
    const body = t.sent.at(-1).body;
    assert.equal(t.emulator.log.at(-1).path, '/responses');
    assert.deepEqual(body.input[0], window.items[0]);
    // The question asked before the pause is still there, verbatim, behind the window.
    assert.deepEqual(body.input.slice(1).map(item => item.content[0].text), ['which port?', PAUSE_NOTICE, 'go on']);
    assert.ok(!t.sent.at(-1).init.body.includes('xxxx'));
  } finally { await t.close(); }
});

test('Anthropic on demand: a signed block comes back, goes first, and carries the beta header from then on', async () => {
  const t = await setup({ api: 'anthropic-messages' }, { compactAtTokens: 120 });
  try {
    const history = [system('rules'), user(big)];
    const first = await t.ask(history);
    assert.deepEqual(t.sent[0].body, { model: 'm', max_tokens: 4096, system: 'rules',
      messages: [{ role: 'user', content: [{ type: 'text', text: big }] }] });
    assert.equal(t.sent[0].init.headers['x-api-key'], 'synthetic-key');
    assert.equal(t.sent[0].init.headers['anthropic-version'], '2023-06-01');
    assert.equal(t.sent[0].init.headers['anthropic-beta'], undefined);
    assert.equal(t.sent[0].init.headers.authorization, undefined);

    history.push(assistant(first), user('which port?'));
    const second = await t.ask(history);
    assert.deepEqual(t.emulator.log.map(entry => entry.form), ['plain', 'on_demand', 'plain']);
    assert.deepEqual(t.sent[1].body.compaction, { type: 'summarize' });
    assert.equal(t.sent[1].init.headers['anthropic-beta'], 'compact-2026-09-04');
    const window = second.at(-1).replayState.response.window;
    const block = window.items[0].content[0];
    assert.deepEqual([window.covered, window.items[0].role, block.type, block.content], [2, 'assistant', 'compaction', 'SUMMARY: port 8443']);
    assert.deepEqual(t.sent[2].body.messages, [{ role: 'assistant', content: [block] },
      { role: 'user', content: [{ type: 'text', text: 'which port?' }] }]);
    assert.equal(t.sent[2].init.headers['anthropic-beta'], 'compact-2026-09-04');

    history.push(assistant(second), user('again?'));
    await t.ask(history);
    // The block and the reply that followed it are one assistant turn on the wire.
    assert.deepEqual(t.sent.at(-1).body.messages.map(m => m.role), ['assistant', 'user', 'assistant', 'user']);
    assert.deepEqual(t.sent.at(-1).body.messages[0].content[0], block);
    assert.equal(t.sent.at(-1).init.headers['anthropic-beta'], 'compact-2026-09-04');
    assert.ok(!t.sent.at(-1).init.body.includes('xxxx'));

    const altered = structuredClone(assistant(second));
    altered.source.replayState.response.window.items[0].content[0].content = 'SUMMARY: port 9000';
    const refused = await t.ask([...history.slice(0, 4), altered, user('again?')]);
    assert.deepEqual(refused[0].reason.failure, { message: 'the provider answered HTTP 400', code: 'HTTP_400', status: 400 });
  } finally { await t.close(); }
});

test('Anthropic threshold: the edit rides on every request and the server compacts in the same response', async () => {
  const t = await setup({ api: 'anthropic-messages' }, { compactAtTokens: 150, compaction: 'threshold' }, { minTrigger: 100 });
  try {
    const history = [user('short question')];
    const first = await t.ask(history);
    assert.deepEqual(t.sent[0].body.context_management, { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 150 } }] });
    assert.equal(t.sent[0].init.headers['anthropic-beta'], 'compact-2026-01-12');
    assert.equal(first.at(-1).replayState.response.window, undefined);

    history.push(assistant(first), user(big));
    const second = await t.ask(history);
    assert.deepEqual(t.emulator.log.map(entry => entry.form), ['plain', 'threshold_compacted']);
    // The adapter never called a compaction endpoint of its own.
    assert.ok(t.sent.every(entry => entry.body.compaction === undefined));
    const window = second.at(-1).replayState.response.window;
    assert.deepEqual([window.covered, window.anchor, window.items[0].content[0].type], [3, undefined, 'compaction']);
    assert.ok(textOf(second).startsWith('echo:'));

    history.push(assistant(second), user('again?'));
    await t.ask(history);
    const messages = t.sent.at(-1).body.messages;
    assert.deepEqual(messages.map(m => m.role), ['assistant', 'user']);
    assert.deepEqual(messages[0].content.map(part => part.type), ['compaction', 'text']);
    // The user turns the server compacted are not sent again.
    assert.deepEqual(messages[1].content, [{ type: 'text', text: 'again?' }]);
    // Auxiliary calls go out without the edit.
    await t.ask([user('title?')], { purpose: 'session-title' });
    assert.equal(t.sent.at(-1).body.context_management, undefined);
  } finally { await t.close(); }
});

test('Anthropic threshold with pause stops on the block; a trigger below the provider minimum is refused by the provider', async () => {
  const t = await setup({ api: 'anthropic-messages' }, { compactAtTokens: 150, compaction: 'threshold', pauseAfterCompaction: true },
    { minTrigger: 100 });
  try {
    const paused = await t.ask([user(big)]);
    assert.equal(t.emulator.log.at(-1).form, 'threshold_paused');
    assert.equal(t.sent[0].body.context_management.edits[0].pause_after_compaction, true);
    assert.equal(textOf(paused), PAUSE_NOTICE);
    assert.equal(paused.at(-1).replayState.response.window.covered, 1);
  } finally { await t.close(); }
  const strict = await setup({ api: 'anthropic-messages' }, { compactAtTokens: 150, compaction: 'threshold' });
  try {
    const refused = await strict.ask([user('hi')]);
    assert.equal(refused[0].reason.failure.code, 'HTTP_400');
  } finally { await strict.close(); }
});

test('Anthropic conversion keeps tool pairs and joins neighbouring turns; settings outside the forms are refused', () => {
  const call = { role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }], source: {} };
  const result = { role: 'tool', content: [{ type: 'text', text: 'body' }], source: { kind: 'tool', callId: 'c1' } };
  assert.deepEqual(merge([user('prompt'), user('runtime context'), call, result].flatMap(messageItems)), [
    { role: 'user', content: [{ type: 'text', text: 'prompt' }, { type: 'text', text: 'runtime context' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'body' }] }]);
  const base = { baseURL: 'https://api.example/v1' };
  const model = extra => [{ id: 'm', compactAtTokens: 1000, ...extra }];
  assert.throws(() => checkProviders({ r: { ...base, api: 'gemini', models: model() } }), /api must be one of/);
  assert.throws(() => checkProviders({ r: { ...base, models: model({ compaction: 'threshold' }) } }), /anthropic-messages routes only/);
  assert.throws(() => checkProviders({ r: { ...base, api: 'anthropic-messages', models: model({ compaction: 'threshold', compactInBackground: true }) } }), /does not apply/);
  assert.throws(() => checkProviders({ r: { ...base, models: model({ compactInBackground: true, pauseAfterCompaction: true }) } }), /cannot both be set/);
  assert.throws(() => checkProviders({ r: { ...base, models: [{ id: 'm', pauseAfterCompaction: true }] } }), /needs compactAtTokens/);
});
