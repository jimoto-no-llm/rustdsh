import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevinBackend, parseDevinCredentials, toDevinPrompts } from './devin.mjs';
import { frameJson } from './protocol.mjs';

const credentials = async () => ({ apiKey: 'test-secret' });
function streamResponse(deltas) {
  const end = frameJson({}); end[0] = 2;
  return new Response(Buffer.concat([...deltas.map(frameJson), end]));
}
test('credentials parser selects windsurf key and rejects arbitrary API hosts', () => {
  assert.deepEqual(parseDevinCredentials('windsurf_api_key = "test-secret"\napi_server_url = "https://server.codeium.com/"'), { apiKey: 'test-secret', baseURL: 'https://server.codeium.com' });
  assert.throws(() => parseDevinCredentials('windsurf_api_key = "test-secret"\napi_server_url = "https://evil.example"'), /Unsupported/);
  assert.throws(() => parseDevinCredentials('password = "unrelated"'), /no usable/);
});
test('discovery uses native Connect RPC and filters disabled models', async () => {
  const backend = createDevinBackend({ credentials, fetchImpl: async (url, options) => {
    assert.match(url, /ApiServerService\/GetCliModelConfigs$/);
    assert.equal(JSON.parse(options.body).metadata.apiKey, 'test-secret');
    return Response.json({ clientModelConfigs: [{ modelUid: 'uid1', label: 'Model' }, { modelUid: 'uid2', disabled: true }] });
  } });
  assert.deepEqual(await backend.discover(), [{ id: 'uid1', name: 'Model' }]);
});
test('native generation preserves tool calls and usage without external harness', async () => {
  const backend = createDevinBackend({ credentials, fetchImpl: async (url, options) => {
    assert.match(url, /ApiServerService\/GetChatMessage$/);
    const body = JSON.parse(Buffer.from(options.body).subarray(5).toString());
    assert.equal(body.chatModelUid, 'uid1');
    assert.equal(body.configuration.maxTokens, 128);
    assert.deepEqual(body.tools, [{ name: 'read_file', description: '', jsonSchemaString: '{"type":"object"}' }]);
    assert.equal(body.chatMessagePrompts[0].source, 5);
    assert.equal(body.chatMessagePrompts[1].source, 1);
    return streamResponse([{ deltaText: 'Read ' }, { deltaText: 'it', deltaToolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{"path":' }] }, { deltaToolCalls: [{ id: 'c1', argumentsJson: '"README.md"}' }], usage: { inputTokens: '12', outputTokens: '8' } }]);
  } });
  assert.deepEqual(await backend.generate({ model: 'uid1', system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'Read file' }] }], tools: [{ name: 'read_file', parameters: { type: 'object' } }], maxTokens: 128 }), { text: 'Read it', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"README.md"}' }], usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 } });
});
test('tool history carries native roles and correlation IDs', () => {
  const prompts = toDevinPrompts([{ role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{}' }] }, { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'result' }] }]);
  assert.equal(prompts[0].source, 2);
  assert.deepEqual(prompts[0].toolCalls, [{ id: 'c1', name: 'read_file', argumentsJson: '{}' }]);
  assert.equal(prompts[1].source, 4);
  assert.equal(prompts[1].toolCallId, 'c1');
});
test('unknown tool calls and invalid JSON arguments are rejected', async () => {
  for (const call of [{ id: 'c1', name: 'delete_everything', argumentsJson: '{}' }, { id: 'c1', name: 'read_file', argumentsJson: 'invalid' }]) {
    const backend = createDevinBackend({ credentials, fetchImpl: async () => streamResponse([{ deltaToolCalls: [call] }]) });
    await assert.rejects(backend.generate({ model: 'uid1', tools: [{ name: 'read_file' }] }), /Devin returned/);
  }
});
test('empty, malformed discovery and error responses fail closed', async () => {
  const backend = createDevinBackend({ credentials, fetchImpl: async () => Response.json({}) });
  await assert.rejects(backend.discover(), /Invalid Devin model/);
  for (const delta of [{}, { stopReason: 13 }, { deltaText: 5 }, { deltaToolCalls: [{ name: 'read_file' }] }]) {
    const backend = createDevinBackend({ credentials, fetchImpl: async () => streamResponse([delta]) });
    await assert.rejects(backend.generate({ model: 'uid1' }));
  }
});
