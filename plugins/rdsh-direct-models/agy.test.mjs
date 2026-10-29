import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgyBackend } from './agy.mjs';
const credentials = async () => ({ api: 'legacy', token: { access_token: 'mock' } });
test('discovers real IDs and wraps native function calls without dropping signatures', async () => {
  const calls = [];
  const backend = createAgyBackend({ credentials, fetchImpl: async (url, init) => {
    calls.push({ url, ...JSON.parse(init.body) });
    if (url.includes('loadCodeAssist')) return Response.json({ cloudaicompanionProject: { id: 'actual-project' } });
    if (url.includes('fetchAvailableModels')) return Response.json({ models: { 'real-model': { displayName: 'Real' } } });
    return new Response('data: ' + JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { file: 'a' } }, thoughtSignature: 'opaque' }] } }], usageMetadata: { totalTokenCount: 4 } } }) + '\n\n');
  } });
  assert.deepEqual(await backend.discover(), [{ id: 'real-model', name: 'Real' }]);
  const result = await backend.generate({ model: 'real-model', messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'read', parameters: { type: 'object' } }] });
  assert.equal(result.toolCalls[0].name, 'read');
  assert.equal(result.replayState.parts[0].thoughtSignature, 'opaque');
  assert.equal(calls.at(-1).project, 'actual-project');
  assert.equal(calls.at(-1).userAgent, 'rdsh');
});
test('rejects foreign hosts before transmitting tokens', async () => {
  let called = false;
  const backend = createAgyBackend({ credentials: async () => ({ access_token: 'mock', baseURL: 'https://example.com' }), fetchImpl: async () => { called = true; } });
  await assert.rejects(backend.discover(), /unsupported service URL/);
  assert.equal(called, false);
});
test('errors expose status without response secrets', async () => {
  const backend = createAgyBackend({ credentials, fetchImpl: async () => new Response('secret', { status: 401 }) });
  await assert.rejects(backend.discover(), { message: 'Antigravity: loadCodeAssist HTTP 401' });
});
test('converts native DSH system arrays and tool roundtrip', async () => {
  let sent;
  const backend = createAgyBackend({ credentials: async () => ({ api: 'legacy', access_token: 'mock', project: 'p' }), fetchImpl: async (_, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ candidates: [{ content: { parts: [{ text: 'done' }] } }] });
  } });
  await backend.generate({ model: 'm', messages: [
    { role: 'system', content: [{ type: 'text', text: 'system instruction' }] },
    { role: 'user', content: [{ type: 'text', text: 'read file' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call1', name: 'read_file', arguments: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'call1', content: [{ type: 'text', text: 'file contents' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call2', name: 'list', arguments: '{}' }] },
    { role: 'tool', source: { callId: 'call2' }, content: [{ type: 'text', text: 'listing' }] },
  ] });
  assert.deepEqual(sent.request.systemInstruction, { parts: [{ text: 'system instruction' }] });
  assert.deepEqual(sent.request.contents[1], { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a' } } }] });
  assert.deepEqual(sent.request.contents[2], { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { result: 'file contents' } } }] });
  assert.equal(sent.request.contents[4].parts[0].functionResponse.name, 'list');
});
test('uses new raw aicode API without legacy project wrapper by default', async () => {
  const calls = [];
  const backend = createAgyBackend({ credentials: async () => ({ access_token: 'mock' }), fetchImpl: async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return url.includes('fetchConfig') ? Response.json({ availableExperiences: [{ name: 'actual-id', model: { modelId: 'base-id', displayName: 'Actual' } }] }) : url.includes('fetchLicenses') ? Response.json({ licenses: [{ userTier: 'paid-tier' }] }) : Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, cachedContentTokenCount: 1 } });
  } });
  assert.deepEqual(await backend.discover(), [{ id: 'actual-id', name: 'Actual' }]);
  const result = await backend.generate({ model: 'actual-id', messages: [{ role: 'user', content: 'hello' }], sessionId: 'session' });
  assert.equal(calls[3].url, 'https://aicode.googleapis.com/v1alpha:streamGenerateContent?alt=sse');
  assert.equal(calls[3].body.project, undefined);
  assert.equal(calls[3].body.request, undefined);
  assert.deepEqual(calls[3].body.aicode, { experience: 'actual-id' });
  assert.equal(calls[3].body.sessionId, 'session');
  assert.deepEqual(calls[3].body.entitlement, { userTier: 'paid-tier' });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[2].method, 'GET');
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 });
});
test('rejects undeclared generated tool and nonobject tool arguments', async () => {
  for (const call of [{ name: 'unknown', args: {} }, { name: 'allowed', args: 'bad' }]) {
    const backend = createAgyBackend({ credentials: async () => ({ api: 'legacy', access_token: 'mock', project: 'p' }), fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ functionCall: call }] } }] }) });
    await assert.rejects(backend.generate({ model: 'm', tools: [{ name: 'allowed' }] }), /undeclared tool|invalid tool arguments/);
  }
});
test('discovery failure is explicit, never an empty successful catalog', async () => {
  const backend = createAgyBackend({ credentials: async () => ({ access_token: 'mock' }), fetchImpl: async () => Response.json({}) });
  await assert.rejects(backend.discover(), /no valid catalog/);
});
test('raw API uses full JSON Schema, account entitlement object, and GET discovery', async () => {
  const methods=[];let body;
  const schema={type:'object',properties:{args:{type:'array',items:{type:'object',additionalProperties:true}}}};
  const b=createAgyBackend({credentials:async()=>({access_token:'mock-access'}),fetchImpl:async(url,init)=>{
    methods.push([url,init.method,init.body]);
    if(url.includes('fetchConfig'))return Response.json({availableExperiences:[{name:'advertised',model:{modelId:'actual-base',displayName:'Actual'}}]});
    if(url.includes('fetchLicenses'))return Response.json({licenses:[{userTier:'real-account-tier'}]});
    body=JSON.parse(init.body);return Response.json({candidates:[{content:{parts:[{text:'ok'}]}}]});
  }});
  await b.generate({model:'advertised',messages:[{role:'user',content:'hello'}],tools:[{name:'test',parameters:schema}]});
  assert.equal(methods[0][1],'GET');assert.equal(methods[0][2],undefined);
  assert.equal(methods[1][1],'GET');assert.deepEqual(body.entitlement,{userTier:'real-account-tier'});
  assert.equal(body.model,undefined);assert.deepEqual(body.tools[0].functionDeclarations[0].parametersJsonSchema,schema);
});
test('missing license stops before generation and error diagnostics redact credentials', async()=>{
  let generated=false;
  const b=createAgyBackend({credentials:async()=>({access_token:'mock-sensitive-token'}),fetchImpl:async(url)=>{
    if(url.includes('fetchConfig'))return Response.json({availableExperiences:[{name:'m',model:{modelId:'actual-base'}}]});
    if(url.includes('fetchLicenses'))return Response.json({licenses:[]});
    generated=true;
  }});
  await assert.rejects(b.generate({model:'m'}),/no active license/);assert.equal(generated,false);
  const denied=createAgyBackend({credentials:async()=>({access_token:'mock-sensitive-token'}),fetchImpl:async()=>Response.json({error:{message:'denied mock-sensitive-token'}},{status:403})});
  await assert.rejects(denied.discover(),e=>e.message.includes('403')&&!e.message.includes('mock-sensitive-token'));
});
