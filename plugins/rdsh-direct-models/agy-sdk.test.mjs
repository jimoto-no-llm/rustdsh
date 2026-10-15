import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgySdkBackend, createPythonRunner } from './agy-sdk.mjs';
test('SDK bridge receives projected history and no native tools', async () => {
  let received;
  const backend = createAgySdkBackend({ runner: async payload => {
    received = payload;
    return { text: JSON.stringify({ version: 1, text: '', toolCalls: [{ id: 'one', name: 'read', arguments: { path: 'a' } }] }) };
  } });
  const result = await backend.generate({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect fixture' }] }], tools: [{ name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] });
  assert.equal(received.operation, 'generate');
  assert.equal(received.tools, undefined);
  assert.match(received.prompt, /inspect fixture/);
  assert.match(received.prompt, /read/);
  assert.equal(result.toolCalls[0].name, 'read');
});
test('SDK response cannot request undeclared tools', async () => {
  const backend = createAgySdkBackend({ runner: async () => ({ text: JSON.stringify({ version: 1, text: '', toolCalls: [{ id: 'bad', name: 'shell', arguments: {} }] }) }) });
  await assert.rejects(backend.generate({ messages: [{ role: 'user', content: 'hi' }] }));
});
test('SDK catalog comes from runner, never guesses availability', async () => {
  const backend = createAgySdkBackend({ runner: async () => ({ models: [{ id: 'sdk-default', name: 'SDK default' }] }) });
  assert.deepEqual(await backend.discover(), [{ id: 'sdk-default', name: 'SDK default' }]);
  await assert.rejects(createAgySdkBackend({ runner: async () => ({}) }).discover(), /invalid model catalog/);
});
test('already aborted requests do not spawn Python', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createPythonRunner({ spawnImpl: () => { throw new Error('must not spawn'); } })({}, { signal: controller.signal }), /aborted/);
});
test('resolved key is passed only through child environment', async () => {
  let request, settings;
  const backend = createAgySdkBackend({ keyResolver: async () => 'mock-private-key', runner: async (payload, options) => {
    request = payload; settings = options;
    return { text: '{"version":1,"text":"ok","toolCalls":[]}' };
  } });
  await backend.generate({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(JSON.stringify(request).includes('mock-private-key'), false);
  assert.equal(settings.env.GEMINI_API_KEY, 'mock-private-key');
});
test('repairs invalid JSON once, using fresh history projection', async () => {
  const prompts = [];
  const backend = createAgySdkBackend({ runner: async payload => {
    prompts.push(payload.prompt);
    return { text: prompts.length === 1 ? 'invalid' : '{"version":1,"text":"fixed","toolCalls":[]}' };
  } });
  assert.equal((await backend.generate({ messages: [{ role: 'user', content: 'original history' }] })).text, 'fixed');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /failed validation/);
  assert.match(prompts[1], /original history/);
});
test('transport failure never triggers JSON repair', async () => {
  let attempts = 0;
  const backend = createAgySdkBackend({ runner: async () => { attempts++; throw new Error('SDK_REQUEST_FAILED'); } });
  await assert.rejects(backend.generate({ messages: [{ role: 'user', content: 'hello' }] }), /SDK_REQUEST_FAILED/);
  assert.equal(attempts, 1);
});
