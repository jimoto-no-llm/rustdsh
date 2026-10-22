import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = await readFile(
  fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8');

// The bundle registers itself on the loader facade DSH injects; capture the
// spec so the factory can be exercised without a host.
function load() {
  const specs = [];
  const facade = { load: (spec) => specs.push(spec) };
  new Function('window', 'document', 'MutationObserver', source)(
    { __ModuleLoader__: facade }, undefined, undefined);
  return specs[0];
}

test('the bundle registers itself as a client module', () => {
  const spec = load();
  assert.equal(spec.id, '@local/rdsh-no-feedback-client');
  assert.equal(typeof spec.factory, 'function');
});

test('the factory needs no host module and returns apply()', () => {
  const plugin = load().factory(() => {
    throw new Error('the bundle must not require host modules');
  });
  assert.equal(typeof plugin.apply, 'function');
});

// The trigger carries the signed-out flag itself. querySelector only visits
// descendants, so a descendant lookup finds nothing and the row stays visible;
// this test pins the self-match a real Chromium run verified.
test('the signed-out check matches the trigger itself', () => {
  assert.ok(
    source.includes('anchor.matches(\'[data-signed-out="true"]\')'),
    'the check must be a self-match on the trigger',
  );
  assert.ok(
    !/anchor\.querySelector\('[^']*signed-out[^']*'\)/.test(source),
    'querySelector cannot see the trigger own attribute',
  );
});
