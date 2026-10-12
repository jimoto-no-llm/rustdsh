import test from 'node:test';
import assert from 'node:assert/strict';
import { patchSource } from '../security/opencode-session-header.mjs';

const FIXTURE = `function createProvider(input) {\n\treturn {\n\t\tid: input.id,\n\t\tstream: (model, context, options) => input.api.stream(model, context, options),\n\t\tstreamSimple: (model, context, options) => input.api.streamSimple(model, context, options)\n\t};\n}`;

test('custom-route provider builder attaches the OpenCode header by endpoint', () => {
  const patched = patchSource(FIXTURE);
  assert.notEqual(patched, FIXTURE);
  assert.match(patched, /__rdshWithOpenCodeSession\(options, input\.baseUrl\)/g);
  assert.match(patched, /host === "opencode\.ai"/);
});

test('patching is idempotent', () => {
  assert.equal(patchSource(patchSource(FIXTURE)), patchSource(FIXTURE));
});

test('unexpected source shapes are left untouched', () => {
  const other = 'export const x = 1;\n';
  assert.equal(patchSource(other), other);
});
