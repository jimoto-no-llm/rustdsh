// The adapter against the emulator over real HTTP. The emulator's model is a
// fixed function here; `tools/responses-emulator` can put a real model behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, checkProviders } from '../adapter.mjs';
import { buildInput, splitForCompaction, messageItems, readCompact, readResponse, estimateTokens, REPLAY_KIND } from '../responses.mjs';
import { createEmulator, listen, toChat } from '../../../tools/responses-emulator/server.mjs';

class LlmAdapter {}
let nextId = 0;
const user = text => ({ id: `msg-${++nextId}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
const system = text => ({ role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } });

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
// What DSH stores: the assembled blocks plus the adapter's replay state.
function assistant(chunks, provider = 'native', model = 'm') {
  const finish = chunks.at(-1);
  return { id: `msg-${++nextId}`, role: 'assistant', content: chunks.filter(c => c.type === 'block-end').map(c => c.block),
    source: { kind: 'model', provider, model, replayState: finish.replayState } };
}

async function setup({ compactAtTokens, compactInBackground, chat, warnings = [] } = {}) {
  const calls = [];
  const emulator = createEmulator({ chat: chat ?? (async ({ messages }) => {
    calls.push(messages);
    const last = messages.at(-1).content;
    return { content: last.startsWith('Summarize the conversation above') ? 'SUMMARY: port 8443' : `echo:${last}`,
      toolCalls: [], finish: 'stop', usage: { prompt_tokens: 10, completion_tokens: 2 } };
  }) });
  const port = await listen(emulator.server);
  const sent = [];
  const adapter = createAdapter({ LlmAdapter, headers: () => ({ 'user-agent': 'test-agent' }), key: () => 'synthetic-key',
    fetch: (url, init) => { sent.push({ url, init }); return fetch(url, init); },
    providers: { native: { baseURL: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'NATIVE_KEY',
      models: [{ id: 'm', contextWindow: 65536, maxTokens: 512, ...(compactAtTokens ? { compactAtTokens } : {}),
        ...(compactInBackground ? { compactInBackground } : {}) }] } },
    warn: message => warnings.push(message) });
  return { adapter, emulator, calls, sent, close: () => new Promise(done => emulator.server.close(done)) };
}
const ask = (adapter, messages, extra = {}) => collect(adapter.stream({ provider: 'native', model: 'm', messages, ...extra }));

test('a plain call maps history, the system prompt and attribution, and stores no window', async () => {
  const t = await setup();
  try {
    const chunks = await ask(t.adapter, [system('be brief'), user('hello')], { maxTokens: 99 });
    assert.deepEqual(chunks.map(c => c.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
    assert.equal(chunks[2].block.text, 'echo:hello');
    assert.deepEqual(chunks[3].usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    assert.deepEqual(chunks[4], { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { kind: REPLAY_KIND, version: 1 } } });
    const body = JSON.parse(t.sent[0].init.body);
    assert.deepEqual(body, { model: 'm', store: false, instructions: 'be brief', max_output_tokens: 99,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] });
    assert.equal(t.sent[0].init.headers.authorization, 'Bearer synthetic-key');
    assert.equal(t.sent[0].init.headers['user-agent'], 'test-agent');
    assert.ok(!t.sent[0].init.body.includes('synthetic-key'));
    assert.deepEqual(t.calls[0][0], { role: 'system', content: 'be brief' });
  } finally { await t.close(); }
});

test('reaching the trigger compacts what precedes the pending question, and the window is replayed verbatim', async () => {
  const t = await setup({ compactAtTokens: 120 });
  try {
    // Nothing precedes the first question, so there is nothing to compact yet.
    const history = [system('rules'), user('the port is 8443 ' + 'x'.repeat(800))];
    const first = await ask(t.adapter, history);
    assert.deepEqual(t.emulator.log.map(entry => entry.path), ['/responses']);
    assert.equal(first.at(-1).replayState.response.window, undefined);

    history.push(assistant(first), user('which port?'));
    const second = await ask(t.adapter, history);
    assert.deepEqual(t.emulator.log.map(entry => entry.path), ['/responses', '/responses/compact', '/responses']);
    const window = second.at(-1).replayState.response.window;
    assert.deepEqual([window.covered, window.anchor, window.items.length, window.items[0].type],
      [2, history[3].id, 1, 'compaction']);
    // Compaction took the older turn only; the pending question follows the window verbatim.
    const compactRequest = JSON.parse(t.sent[1].init.body);
    assert.deepEqual(compactRequest.input.map(item => item.role), ['user', 'assistant']);
    assert.equal(compactRequest.instructions, 'rules');
    const afterCompact = JSON.parse(t.sent[2].init.body);
    assert.deepEqual(afterCompact.input, [window.items[0], { role: 'user', content: [{ type: 'input_text', text: 'which port?' }] }]);
    assert.ok(!t.sent[2].init.body.includes('xxxx'));
    // The emulator expanded the handle it issued; the model saw the summary.
    assert.ok(t.calls.at(-1).some(m => m.role === 'system' && m.content.includes('SUMMARY: port 8443')));

    // Next turn, as DSH rebuilds it from the full history: the window comes
    // back unchanged, no new compaction happens, and it stays in force.
    history.push(assistant(second), user('again?'));
    const third = await ask(t.adapter, history);
    assert.equal(t.emulator.log.at(-1).path, '/responses');
    assert.equal(t.emulator.log.at(-1).compactionItems, 1);
    const body = JSON.parse(t.sent.at(-1).init.body);
    assert.deepEqual(body.input[0], window.items[0]);
    assert.deepEqual(body.input.slice(1).map(item => item.role), ['user', 'assistant', 'user']);
    assert.deepEqual(third.at(-1).replayState.response.window, window);

    // Once the part added since has grown, the provider compacts again, window included.
    history.push(assistant(third), user('more ' + 'w'.repeat(400)));
    const fourth = await ask(t.adapter, history);
    assert.equal(t.emulator.log.at(-2).path, '/responses/compact');
    assert.equal(t.emulator.log.at(-2).compactionItems, 1);
    const renewed = fourth.at(-1).replayState.response.window;
    assert.deepEqual([renewed.covered, renewed.anchor], [6, history[7].id]);
    assert.notEqual(renewed.items[0].encrypted_content, window.items[0].encrypted_content);
    assert.ok(t.sent.at(-1).init.body.includes('wwww'));
  } finally { await t.close(); }
});

async function compactedHistory(t) {
  const history = [user('the port is 8443 ' + 'x'.repeat(800))];
  history.push(assistant(await ask(t.adapter, history)), user('which port?'));
  const stored = assistant(await ask(t.adapter, history));
  return { history, stored };
}

test('an altered compaction item is refused by the provider and never repaired by the adapter', async () => {
  const t = await setup({ compactAtTokens: 120 });
  try {
    const { history, stored } = await compactedHistory(t);
    stored.source.replayState.response.window.items[0].encrypted_content += 'tampered';
    const chunks = await ask(t.adapter, [...history, stored, user('again')]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].reason.kind, 'error');
    assert.deepEqual(chunks[0].reason.failure, { message: 'the provider answered HTTP 400', code: 'HTTP_400', status: 400 });
  } finally { await t.close(); }
});

test('a failed compaction sends the input unchanged; a window of another route or a shifted history is not used', async () => {
  let fail = true;
  const t = await setup({ compactAtTokens: 120, chat: async ({ messages }) => {
    if (messages.at(-1).content.startsWith('Summarize the conversation above') && fail) return { content: '', toolCalls: [], usage: {} };
    return { content: 'ok', toolCalls: [], finish: 'stop', usage: {} };
  } });
  try {
    const failed = await compactedHistory(t);
    assert.deepEqual(t.emulator.log.map(entry => entry.path), ['/responses', '/responses']);
    assert.equal(failed.stored.source.replayState.response.window, undefined);
    assert.ok(t.sent.at(-1).init.body.includes('xxxx'));
    fail = false;
    const { history, stored } = await compactedHistory(t);
    const route = { provider: 'native', model: 'm' };
    const next = user('next');
    assert.equal(buildInput([...history, stored, next], route).covered, 2);
    const other = { ...stored, source: { ...stored.source, model: 'other' } };
    assert.equal(buildInput([...history, other, next], route).window, undefined);
    const shifted = buildInput([user('inserted'), ...history, stored, next], route);
    assert.deepEqual([shifted.window, shifted.degraded, shifted.input.length], [undefined, 'window_does_not_match_history', 6]);
    // A pending question with nothing before it leaves nothing to compact,
    // also when DSH put a second user message beside it.
    assert.equal(splitForCompaction(buildInput([user('only')], route)), undefined);
    assert.equal(splitForCompaction(buildInput([user('prompt'), user('runtime context')], route)), undefined);
    // The whole active turn stays out: both opening messages, the tool call and its result.
    const call = { id: 'a-call', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }], source: { kind: 'model', provider: 'native', model: 'm' } };
    const result = { id: 'a-result', role: 'tool', content: [{ type: 'text', text: 'body' }], source: { kind: 'tool', callId: 'c1' } };
    const opening = user('prompt');
    const split = splitForCompaction(buildInput([user('old'), { ...call, id: 'old-reply', content: [{ type: 'text', text: 'old reply' }] },
      opening, user('runtime context'), call, result], route));
    assert.deepEqual([split.covered, split.anchor, split.head.length, split.pending.map(item => item.type ?? item.role)],
      [2, opening.id, 2, ['user', 'user', 'function_call', 'function_call_output']]);
  } finally { await t.close(); }
});

test('auxiliary calls are never compacted, tool calls round-trip, and unsupported content fails closed', async () => {
  const t = await setup({ compactAtTokens: 10, chat: async ({ messages, tools }) => tools.length
    ? { content: '', toolCalls: [{ id: 'call_1', function: { name: 'read', arguments: '{"path":"a"}' } }], finish: 'tool_calls', usage: {} }
    : { content: `seen ${messages.length}`, toolCalls: [], finish: 'length', usage: {} } });
  try {
    const title = await ask(t.adapter, [user('z'.repeat(400))], { purpose: 'session-title' });
    assert.deepEqual(t.emulator.log.map(entry => entry.path), ['/responses']);
    assert.equal(title.at(-1).reason.kind, 'max-tokens');
    const tool = { name: 'read', description: 'read a file', parameters: { type: 'object' } };
    const called = await ask(t.adapter, [user('go')], { purpose: 'session-title', tools: [tool] });
    assert.deepEqual(called.find(c => c.type === 'block-end').block, { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' });
    assert.equal(called.at(-1).reason.kind, 'tool-calls');
    const items = [assistant(called), { role: 'tool', content: [{ type: 'text', text: 'file body' }], source: { kind: 'tool', callId: 'call_1' } }].flatMap(messageItems);
    assert.deepEqual(items, [{ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' }]);
    assert.deepEqual(toChat(items, undefined, new Map()).messages.map(m => m.role), ['assistant', 'tool']);
    const image = await ask(t.adapter, [{ role: 'user', content: [{ type: 'image', attachment: {} }], source: { kind: 'user' } }]);
    assert.equal(image[0].reason.failure.code, 'UNSUPPORTED_CONTENT');
  } finally { await t.close(); }
});

test('settings and provider replies outside the documented shape are refused', () => {
  const ok = { r: { baseURL: 'https://api.example/v1', models: [{ id: 'm', contextWindow: 1000, compactAtTokens: 500 }] } };
  assert.equal(checkProviders(ok), ok);
  assert.throws(() => checkProviders({ r: { ...ok.r, baseURL: 'ftp://x' } }), /http\(s\) URL/);
  assert.throws(() => checkProviders({ r: { ...ok.r, apiKeyEnv: 'sk-live-1' } }), /environment variable/);
  assert.throws(() => checkProviders({ r: { ...ok.r, models: [{ id: 'm', contextWindow: 1000, compactAtTokens: 1000 }] } }), /below contextWindow/);
  assert.throws(() => checkProviders({ 'Bad Name': ok.r }), /invalid provider name/);
  assert.throws(() => readCompact({ output: [] }), /no output/);
  assert.throws(() => readCompact({ output: [{ type: 'message' }] }), /exactly one compaction item/);
  assert.throws(() => readCompact({ output: [{ type: 'compaction', encrypted_content: 'a' }, { type: 'compaction', encrypted_content: 'b' }] }), /exactly one/);
  assert.throws(() => readResponse({}), /no output/);
  assert.deepEqual(readResponse({ output: [], usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 4 } } }).usage,
    { inputTokens: 6, outputTokens: 1, cacheReadTokens: 4 });
  assert.equal(estimateTokens([{ a: 'xxxx' }], 'abcd'), 5);
});

test('background compaction lets the call go out as it is and applies the result on a later call', async () => {
  const t = await setup({ compactAtTokens: 120, compactInBackground: true });
  try {
    const session = { sessionId: 'session-1' };
    const history = [system('rules'), user('the port is 8443 ' + 'x'.repeat(800))];
    history.push(assistant(await ask(t.adapter, history, session)), user('which port?'));
    const second = await ask(t.adapter, history, session);
    // The request was sent uncompacted; no window is stored for this reply.
    assert.ok(t.sent.find(entry => entry.url.endsWith('/responses') && entry.init.body.includes('which port?')).init.body.includes('xxxx'));
    assert.equal(second.at(-1).replayState.response.window, undefined);
    await t.adapter.backgroundIdle();
    assert.equal(t.emulator.log.map(entry => entry.path).filter(path => path === '/responses/compact').length, 1);

    history.push(assistant(second), user('again?'));
    const third = await ask(t.adapter, history, session);
    const body = JSON.parse(t.sent.at(-1).init.body);
    assert.equal(body.input[0].type, 'compaction');
    assert.deepEqual(body.input.slice(1).map(item => item.role), ['user', 'assistant', 'user']);
    assert.ok(!t.sent.at(-1).init.body.includes('xxxx'));
    const window = third.at(-1).replayState.response.window;
    assert.deepEqual([window.covered, window.anchor], [2, history[3].id]);
    // One job, used once: nothing was compacted a second time.
    assert.equal(t.emulator.log.map(entry => entry.path).filter(path => path === '/responses/compact').length, 1);
  } finally { await t.close(); }
});

test('a background result computed from a history that has since changed is dropped, never applied', async () => {
  const warnings = [];
  const t = await setup({ compactAtTokens: 120, compactInBackground: true, warnings });
  try {
    const session = { sessionId: 'session-2' };
    const first = user('the port is 8443 ' + 'x'.repeat(800));
    const history = [first];
    history.push(assistant(await ask(t.adapter, history, session)), user('which port?'));
    const second = await ask(t.adapter, history, session);
    await t.adapter.backgroundIdle();
    // The first message was edited after the job read it.
    const edited = [{ ...first, content: [{ type: 'text', text: 'the port is 9000 ' + 'y'.repeat(800) }] },
      ...history.slice(1), assistant(second), user('again?')];
    const third = await ask(t.adapter, edited, session);
    const body = JSON.parse(t.sent.at(-1).init.body);
    assert.ok(body.input.every(item => item.type !== 'compaction'));
    assert.ok(t.sent.at(-1).init.body.includes('the port is 9000'));
    assert.equal(third.at(-1).replayState.response.window, undefined);
    assert.ok(warnings.some(message => message.includes('background compaction result discarded')));
    // Another session never sees this session's job.
    await t.adapter.backgroundIdle();
    const other = await ask(t.adapter, history, { sessionId: 'session-3' });
    assert.equal(other.at(-1).replayState.response.window, undefined);
  } finally { await t.close(); }
});

test('without a session identity the route compacts in line; background needs a trigger', async () => {
  const t = await setup({ compactAtTokens: 120, compactInBackground: true });
  try {
    const history = [user('the port is 8443 ' + 'x'.repeat(800))];
    history.push(assistant(await ask(t.adapter, history)), user('which port?'));
    const second = await ask(t.adapter, history);
    assert.equal(second.at(-1).replayState.response.window.covered, 2);
    assert.throws(() => checkProviders({ r: { baseURL: 'https://api.example/v1',
      models: [{ id: 'm', compactInBackground: true }] } }), /needs compactAtTokens/);
    assert.throws(() => checkProviders({ r: { baseURL: 'https://api.example/v1',
      models: [{ id: 'm', compactAtTokens: 10, compactInBackground: 'yes' }] } }), /true or false/);
  } finally { await t.close(); }
});
