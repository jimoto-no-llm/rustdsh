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

// A live run of the shipped UI rejected the original id: the module system
// keys the registered factory by the Loader entry name, so a scoped id loaded
// without registering and the whole application batch failed with it.
test('the bundle registers under the Loader entry name', () => {
  const spec = load();
  assert.equal(spec.id, 'rdsh-no-feedback-client');
  assert.equal(typeof spec.factory, 'function');
});

test('the factory needs no host module and returns apply()', () => {
  const plugin = load().factory(() => {
    throw new Error('the bundle must not require host modules');
  });
  assert.equal(typeof plugin.apply, 'function');
});

// The menu is portalled out of the trigger, so the signed-out flag is not an
// ancestor; the shipped component marks the menu itself instead.
test('the signed-out menu is recognised by its CSS-module class', () => {
  assert.ok(
    source.includes('signedOutMenu'),
    'the guard must key on the signedOutMenu class tail',
  );
  assert.ok(
    !source.includes('data-signed-out'),
    'the trigger is not an ancestor of the portalled menu',
  );
});
