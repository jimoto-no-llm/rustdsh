import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogService, projectAction } from '../catalog.js';
import { httpActions } from '../http-actions.js';

const codec = schema => ({ mode: 'strict', typeSymbol: 'fixture#Value', create: () => ({ schema }) });
const convert = (value, options) => {
  assert.deepEqual(options, { unrepresentable: 'any', io: 'input' });
  return structuredClone(value.schema);
};
const descriptor = overrides => ({ id: 'fixture#settings/save', service: 'settings', namespace: 'settings', method: 'save',
  invocation: { kind: 'direct' }, parameters: [], result: codec({ type: 'object' }), ...overrides });
const parameter = (name, schema, extra = {}) => ({ name, wire: name, source: 'json', codec: codec(schema), ...extra });

test('required, optional, defaults, lookup identities and context wires use the public descriptor', () => {
  const action = projectAction(descriptor({ invocation: { kind: 'context', context: 'agent', wire: 'agentId', codec: codec({ type: 'string' }) },
    parameters: [parameter('value', { type: 'string' }), parameter('options', { type: 'object', properties: { retries: { type: 'number', default: 3 } } }, { acceptsUndefined: true }),
      parameter('peerId', { type: 'string' }, { source: 'lookup', lookup: 'peer' })] }), convert);
  assert.equal(action.id, 'settings/save');
  assert.deepEqual(action.schema.required, ['value', 'peerId', 'agentId']);
  assert.deepEqual(action.schema.properties.agentId, { type: 'string' });
  assert.deepEqual(action.defaults, { options: { retries: 3 } });
  assert.equal(action.descriptor.parameters[2].source, 'lookup');
  assert.equal(action.descriptor.parameters[1].acceptsUndefined, true);
});

test('stream keeps uplink and cancellation without adding signal to arguments', () => {
  const action = projectAction(descriptor({ mode: 'stream', uplink: { codec: codec({ type: 'string' }) }, cancellation: { parameter: 'signal' },
    scope: { context: 'agent', wire: 'agentId' }, parameters: [parameter('agentId', { type: 'string' }, { source: 'lookup', lookup: 'agent' })] }), convert);
  assert.equal(action.mode, 'stream');
  assert.equal(action.uplink, true);
  assert.deepEqual(action.uplinkSchema, { type: 'string' });
  assert.deepEqual(action.descriptor.cancellation, { parameter: 'signal' });
  assert.equal(Object.hasOwn(action.schema.properties, 'signal'), false);
});

test('embedding codec documents preserves local JSON Schema references', () => {
  const action = projectAction(descriptor({ parameters: [parameter('config', {
    $defs: { Child: { type: 'object', properties: { parent: { $ref: '#' } } } },
    $ref: '#/$defs/Child',
  })] }), convert);
  assert.equal(action.schema.properties.config.$ref, '#/properties/config/$defs/Child');
  assert.equal(action.schema.properties.config.$defs.Child.properties.parent.$ref, '#/properties/config');
  assert.equal(action.descriptor.parameters[0].codec.schema.$ref, '#/$defs/Child');
});

test('codec failures keep the action and expose a value-free warning', () => {
  const warnings = [];
  const bad = { mode: 'strict', typeSymbol: 'fixture#Broken', create() { throw new Error('secret-value-must-not-appear'); } };
  const action = projectAction(descriptor({ parameters: [{ name: 'config', wire: 'config', source: 'json', codec: bad }], result: { mode: 'src-json' } }), convert, warnings);
  assert.deepEqual(action.schema.properties.config, {});
  assert.deepEqual(warnings, [{ id: 'settings/save', wire: 'config', code: 'SCHEMA_PROJECTION_FAILED' }]);
  assert.doesNotMatch(JSON.stringify({ action, warnings }), /secret-value/);
});

test('secret defaults and literal examples are never exported', () => {
  const action = projectAction(descriptor({ parameters: [parameter('config', { type: 'object',
    default: { host: 'example.test', apiKey: 'secret-value', nested: { password: 'secret-value' } },
    properties: { apiKey: { type: 'string', default: 'secret-value', enum: ['secret-value'] },
      auth: { type: 'string', writeOnly: true, default: 'secret-value', examples: ['secret-value'] },
      host: { type: 'string', default: 'example.test' } } }), parameter('token', { type: 'string', default: 'secret-value' })] }), convert);
  assert.doesNotMatch(JSON.stringify(action), /secret-value/);
  assert.equal(action.sensitive, true);
  assert.equal(action.defaults.config.host, 'example.test');
});

test('public subscriptions invalidate cached snapshots and disposal removes the observer', () => {
  let descriptors = [descriptor()], observer, disposed = 0, reads = 0;
  const typert = { local: { list() { reads++; return descriptors; }, subscribe(listener) { observer = listener; return () => disposed++; } },
    listPackages() { return [{ model: { services: [{ key: 'settings', members: [{ name: 'save', summary: 'Save typed settings' }] }] } }]; } };
  const service = createCatalogService(typert, convert, []);
  const first = service.catalog();
  first.actions.length = 0;
  assert.equal(service.catalog().actions.length, 1);
  assert.equal(reads, 1);
  assert.equal(service.catalog().actions[0].description, 'Save typed settings');
  descriptors = [];
  observer({ kind: 'local', key: 'settings/save' });
  assert.equal(service.catalog().actions.length, 0);
  assert.equal(service.catalog().revision, 1);
  service.dispose();
  assert.equal(disposed, 1);
});

test('HTTP manifest only names audited endpoints and marks potential availability, binary and SSE', () => {
  assert.equal(new Set(httpActions.map(action => action.id)).size, httpActions.length);
  for (const action of httpActions) {
    assert.match(action.path, /^\/api\/rdsh-[a-z/-]+$/);
    assert.equal(action.availability, 'manifest');
    assert.equal(action.id, `${action.method} ${action.path}`);
  }
  assert.equal(httpActions.find(action => action.path.endsWith('/events')).streamFormat, 'sse');
  assert.equal(httpActions.find(action => action.path.endsWith('/icon')).responseType, 'binary');
  assert.deepEqual(httpActions.find(action => action.path.endsWith('/execute')).schema.required, ['id', 'confirmed']);
  assert.deepEqual(httpActions.find(action => action.path.endsWith('/action') && action.method === 'GET').query, ['after']);
});
