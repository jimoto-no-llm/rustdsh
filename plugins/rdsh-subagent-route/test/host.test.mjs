import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFromBody } from '../index.js';
import { readRoute, writeRoute } from '../route.js';

test('a body names the three route fields', () => {
  assert.deepEqual(routeFromBody({ provider: 'opencode-go', model: 'm', reasoningEffort: 'high' }), {
    clear: false,
    route: { provider: 'opencode-go', model: 'm', reasoningEffort: 'high' },
  });
});

test('blank fields mean inherit, not an empty string pin', () => {
  assert.deepEqual(routeFromBody({ provider: '  ', model: '', reasoningEffort: '' }), {
    clear: false,
    route: { provider: '', model: '', reasoningEffort: '' },
  });
});

test('an unknown effort is refused', () => {
  assert.throws(() => routeFromBody({ model: 'm', reasoningEffort: 'turbo' }), /RDSH_SUBAGENT_ROUTE_UNKNOWN_EFFORT/);
});

test('unknown keys are refused instead of silently dropped', () => {
  assert.throws(() => routeFromBody({ model: 'm', temperature: 2 }), /RDSH_SUBAGENT_ROUTE_UNKNOWN_FIELD/);
  assert.throws(() => routeFromBody([]), /RDSH_SUBAGENT_ROUTE_INVALID_BODY/);
  assert.throws(() => routeFromBody(null), /RDSH_SUBAGENT_ROUTE_INVALID_BODY/);
});

test('an over-long field is refused', () => {
  assert.throws(() => routeFromBody({ model: 'x'.repeat(129) }), /RDSH_SUBAGENT_ROUTE_FIELD_TOO_LONG/);
});

test('clear is an explicit flag, never an empty body', () => {
  assert.equal(routeFromBody({ clear: true }).clear, true);
  assert.equal(routeFromBody({}).clear, false);
});

test('a saved route round-trips through the patch editor', () => {
  const patch = ['- id: tool-subagent', '  config:', '    provider: spawn', ''].join('\n');
  const { route } = routeFromBody({ provider: 'opencode-go', model: 'm', reasoningEffort: 'medium' });
  const written = writeRoute(patch, route);
  assert.deepEqual(readRoute(written), { provider: 'opencode-go', model: 'm', reasoningEffort: 'medium' });
});
