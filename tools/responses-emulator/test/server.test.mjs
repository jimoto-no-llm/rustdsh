// The emulator on its own: shapes it accepts, and the one rule it enforces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmulator, listen, toChat } from '../server.mjs';

async function start(chat) {
  const emulator = createEmulator({ chat });
  const port = await listen(emulator.server);
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { emulator, post, close: () => new Promise(done => emulator.server.close(done)) };
}
const user = text => ({ role: 'user', content: [{ type: 'input_text', text }] });

test('a compaction item is accepted only as issued, and expands to the summary it stands for', async () => {
  const seen = [];
  const t = await start(async ({ messages }) => { seen.push(messages);
    return { content: messages.at(-1).content.startsWith('Summarize') ? 'the summary' : 'ok', toolCalls: [], finish: 'stop',
      usage: { prompt_tokens: 7, completion_tokens: 3 } }; });
  try {
    const compacted = await t.post('/responses/compact', { model: 'm', input: [user('long history')] });
    assert.equal(compacted.status, 200);
    assert.equal(compacted.body.object, 'response.compaction');
    assert.deepEqual(compacted.body.usage, { input_tokens: 7, output_tokens: 3, total_tokens: 10 });
    const [item] = compacted.body.output;
    assert.equal(item.type, 'compaction');
    // The handle is opaque: the summary text is not in it.
    assert.ok(!JSON.stringify(compacted.body).includes('the summary'));

    const next = await t.post('/responses', { model: 'm', instructions: 'rules', input: [item, user('continue')] });
    assert.equal(next.status, 200);
    assert.deepEqual(next.body.output, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]);
    assert.deepEqual(seen.at(-1), [{ role: 'system', content: 'rules' },
      { role: 'system', content: 'Summary of the earlier conversation:\nthe summary' }, { role: 'user', content: 'continue' }]);

    const altered = await t.post('/responses', { model: 'm', input: [{ ...item, encrypted_content: `${item.encrypted_content}x` }] });
    assert.deepEqual([altered.status, altered.body.error.code], [400, 'invalid_encrypted_content']);
    // Requests are logged as paths and counts only.
    assert.deepEqual(t.emulator.log.entries, [
      { path: '/responses/compact', items: 1, compactionItems: 0, messages: 1 },
      { path: '/responses', items: 2, compactionItems: 1, messages: 3 }]);
  } finally { await t.close(); }
});

test('requests outside the two endpoints or the documented shape are refused without detail', async () => {
  const t = await start(async () => { throw new Error('secret upstream detail'); });
  try {
    assert.equal((await t.post('/chat/completions', { model: 'm', input: [] })).status, 404);
    assert.deepEqual((await t.post('/responses', '{not json')).body.error.code, 'invalid_request');
    assert.equal((await t.post('/responses', { input: [] })).status, 400);
    assert.equal((await t.post('/responses', { model: 'm', input: 'text' })).status, 400);
    assert.equal((await t.post('/responses', { model: 'm', input: [{ type: 'image' }] })).status, 400);
    const failed = await t.post('/responses', { model: 'm', input: [user('hi')] });
    assert.deepEqual([failed.status, failed.body.error.message], [500, 'internal error']);
  } finally { await t.close(); }
});

test('tool calls and results map to chat messages in order', () => {
  const { messages } = toChat([user('go'),
    { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"a":1}' },
    { type: 'function_call', call_id: 'c2', name: 'list', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'one' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }], undefined, new Map());
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(messages[1].tool_calls.map(call => call.id), ['c1', 'c2']);
  assert.deepEqual(messages[2], { role: 'tool', tool_call_id: 'c1', content: 'one' });
});
