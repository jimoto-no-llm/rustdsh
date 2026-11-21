import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogCodec, schemaToJSON } from '../schema.js';
import { contribution } from '../index.js';

const catalog = () => ({ version: 1, revision: 0, actions: [{ id: 'fixture/read', schema: {} }], warnings: [], httpAvailability: 'fixture' });

test('strict result codec follows the public parse contract without importing Zod', () => {
  const codec = createCatalogCodec();
  const value = catalog();
  assert.equal(codec.parse(value), value);
  for (const invalid of [null, [], {}, { ...value, extra: true }, { ...value, version: 2 },
    { ...value, revision: -1 }, { ...value, revision: Infinity }, { ...value, actions: ['not an object'] },
    { ...value, warnings: [null] }, { ...value, actions: [{ invalid: undefined }] },
    { ...value, actions: [{ invalid: new Date() }] }, { ...value, actions: [{ invalid() {} }] }])
    assert.throws(() => codec.parse(invalid), /Invalid rdshTuiAdmin catalog result/);
  const circular = catalog();
  circular.actions.push(circular);
  assert.throws(() => codec.parse(circular), /Invalid rdshTuiAdmin catalog result/);
  assert.deepEqual(contribution().invocations[0].result.create().parse(value), value);
});

test('schema projection calls the originating codec instance with its receiver and options', () => {
  const options = { unrepresentable: 'any', io: 'input' };
  const schema = { toJSONSchema(actual) { assert.equal(this, schema); assert.equal(actual, options); return { type: 'string' }; } };
  assert.deepEqual(schemaToJSON(schema, options), { type: 'string' });
  assert.throws(() => schemaToJSON({ parse: value => value }, options), /no public JSON Schema projector/);
  const own = createCatalogCodec();
  const first = schemaToJSON(own, options);
  first.required.length = 0;
  assert.equal(schemaToJSON(own, options).required.length, 5);
});
