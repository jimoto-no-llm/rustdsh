import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectModelsAdapter, inject, name, providers, apply } from './index.mjs';

const collect = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result; };
function adapter(generate, discover = async () => [{ id: 'model', name: 'Example' }], provider = 'cursor-sdk') {
  return new DirectModelsAdapter({ backends: { [provider]: { generate, discover } } });
}
test('plugin exports and apply register SDK routes and Devin tool', () => {
  assert.equal(name, 'rdsh-direct-models');
  assert.deepEqual(inject, ['llm', 'tools', 'credentials']);
  assert.deepEqual(providers, ['cursor-sdk','agy-sdk']);
  let removed=0;
  const cleanup=apply({ credentials:{resolve:async()=>undefined},on(){return ()=>removed++;},tools:{register(tool){assert.equal(tool.name,'devin_cli');return ()=>removed++;}},llm:{registerAdapter(routes,instance){assert.deepEqual(routes,providers);assert.ok(instance instanceof DirectModelsAdapter);return ()=>removed++;}} });
  cleanup(); assert.equal(removed,3);
});
test('text generation emits canonical blocks, usage then terminal finish', async () => {
  const chunks = await collect(adapter(async () => ({ text: 'OK', toolCalls: [], usage: { inputTokens: 2, outputTokens: 1 } })).stream({ provider: 'cursor-sdk', model: 'model', messages: [] }));
  assert.deepEqual(chunks, [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'OK' }, { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }, { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'stop' } }]);
});
test('tool calls remain instructions for DSH and finish as tool-calls', async () => {
  const call = { id: 'c1', name: 'read_file', arguments: '{"path":"README.md"}' };
  let received;
  const chunks = await collect(adapter(async options => { received = options; return { text: '', toolCalls: [call] }; }).stream({ provider: 'cursor-sdk', model: 'model', messages: [], tools: [{ name: 'read_file', parameters: { type: 'object' } }] }));
  assert.equal(received.tools[0].name, 'read_file');
  assert.deepEqual(chunks, [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id: 'c1', name: 'read_file', argumentsDelta: call.arguments }, { type: 'block-end', index: 0, block: { type: 'tool-call', ...call } }, { type: 'finish', reason: { kind: 'tool-calls' } }]);
});
test('discovery failures propagate and exact model resolution uses current API', async () => {
  const instance = adapter(async () => {}, async () => { throw new Error('catalog unavailable'); });
  await assert.rejects(instance.listModels('cursor-sdk'), /catalog unavailable/);
  assert.deepEqual(await instance.resolveModel('cursor-sdk', 'exact'), { provider: 'cursor-sdk', id: 'exact', name: 'exact', inputModalities: ['text'] });
  const prepared = await instance.prepareCall('cursor-sdk', 'exact');
  assert.equal(prepared.model.id, 'exact');
  assert.equal(typeof prepared.stream, 'function');
  assert.deepEqual(await adapter(async () => {}).listModels('cursor-sdk'), [{ provider: 'cursor-sdk', id: 'model', name: 'Example', inputModalities: ['text'] }]);
});
test('unknown tools, malformed responses and cancellation fail before any emitted block', async () => {
  for (const result of [{ text: '', toolCalls: [] }, { text: 'hello', toolCalls: [{ id: 'c', name: 'unknown', arguments: '{}' }] }, { text: '', toolCalls: [{ id: 'c', name: 'read_file', arguments: '[]' }] }]) {
    await assert.rejects(collect(adapter(async () => result).stream({ provider: 'cursor-sdk', model: 'model', messages: [], tools: [{ name: 'read_file' }] })));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collect(adapter(async () => { throw new Error('must not execute'); }).stream({ provider: 'cursor-sdk', model: 'model', messages: [], signal: controller.signal })), { name: 'AbortError' });
});
