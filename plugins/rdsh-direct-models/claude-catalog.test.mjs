import test from 'node:test';
import assert from 'node:assert/strict';
import { providerModuleUrl } from './claude-catalog.mjs';

test('provider export targets expand every wildcard', () => {
  const url = providerModuleUrl('/tmp/node_modules/pi-ai/package.json', './providers/*/models/*');
  assert.equal(new URL(url).pathname, '/tmp/node_modules/pi-ai/providers/all/models/all');
});
