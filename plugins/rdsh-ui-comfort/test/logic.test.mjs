import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// The decisions are pure, but they ship inside the client bundle: the Web
// module loader has no relative require, so the test runs the shipped bytes in
// a VM and reads the same table the browser half uses.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');

function bundle() {
  let definition;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
  });
  const React = {
    createElement: () => null,
    useState: (initial) => [initial, () => {}],
    useCallback: (callback) => callback,
  };
  return definition.factory(() => React);
}

const plugin = bundle();
const { DEFAULTS, normalizeSettings, composerAction, goalAction } = plugin.logic;
const settings = (patch) => normalizeSettings({ ...DEFAULTS, ...patch });

// A stock plain Enter in the composer, with the given overrides.
const composer = (patch) => composerAction({
  key: 'Enter', isComposing: false, keyCode: 13, shiftKey: false, ctrlKey: false,
  metaKey: false, altKey: false, repeat: false, menuOpen: false,
  settings: settings(), now: 10000, lastEnterAt: 0, sameComposer: true,
  ...patch,
});

const goal = (patch) => goalAction({
  key: 'Enter', isComposing: false, keyCode: 13, shiftKey: false, ctrlKey: false,
  metaKey: false, altKey: false, repeat: false, settings: settings(),
  ...patch,
});

test('the bundle composes as a web client half and exposes its decision table', () => {
  assert.equal(plugin.inject.length, 1);
  assert.equal(plugin.inject[0], 'slots');
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof composerAction, 'function');
  assert.equal(typeof goalAction, 'function');
});

test('normalizeSettings keeps the defaults, drops unknown members and clamps the window', () => {
  const fallback = normalizeSettings(undefined);
  assert.equal(fallback.doubleEnter, DEFAULTS.doubleEnter);
  assert.equal(fallback.goalGuard, DEFAULTS.goalGuard);
  assert.equal(fallback.windowMs, DEFAULTS.windowMs);
  assert.equal(normalizeSettings(null).windowMs, DEFAULTS.windowMs);
  assert.equal(normalizeSettings('nope').doubleEnter, true);

  const off = normalizeSettings({ doubleEnter: false, goalGuard: false, windowMs: 9000 });
  assert.equal(off.doubleEnter, false);
  assert.equal(off.goalGuard, false);
  assert.equal(off.windowMs, 5000, 'above the ceiling is clamped');
  assert.equal(normalizeSettings({ windowMs: 10 }).windowMs, 200, 'below the floor is clamped');
  assert.equal(normalizeSettings({ windowMs: 'abc' }).windowMs, DEFAULTS.windowMs);
  assert.equal(normalizeSettings({ windowMs: 1499.6 }).windowMs, 1500);
  // Only a literal false disables a guard; a hand-edited file cannot turn it off
  // with a truthy string.
  assert.equal(normalizeSettings({ doubleEnter: 'no' }).doubleEnter, true);
  assert.equal(normalizeSettings({ goalGuard: 0 }).goalGuard, true);
  assert.equal('evil' in normalizeSettings({ evil: 1 }), false);
});

test('the composer breaks on the first Enter and sends on the second inside the window', () => {
  assert.equal(composer({}).action, 'line-break');
  assert.equal(composer({ lastEnterAt: 9500 }).action, 'send');
  assert.equal(composer({ lastEnterAt: 8500 }).action, 'send', 'the window edge is inclusive');
  assert.equal(composer({ lastEnterAt: 8499 }).action, 'line-break', 'one millisecond too late is a new break');
  assert.equal(composer({ lastEnterAt: 8000 }).action, 'line-break');
  assert.equal(composer({ lastEnterAt: 0 }).action, 'line-break');
  assert.equal(composer({ lastEnterAt: 9500, sameComposer: false }).action, 'line-break', 'another composer starts over');
  assert.equal(composer({ lastEnterAt: 9500, settings: settings({ windowMs: 200 }) }).action, 'line-break');
});

test('the composer leaves every other gesture to the shell', () => {
  for (const patch of [
    { isComposing: true }, { keyCode: 229 }, { shiftKey: true }, { ctrlKey: true },
    { metaKey: true }, { altKey: true }, { repeat: true }, { menuOpen: true },
    { key: 'a', keyCode: 65 }, { settings: settings({ doubleEnter: false }) },
  ]) {
    assert.equal(composer(patch).action, 'ignore', JSON.stringify(patch));
  }
  // An ignored Enter does not arm the window: the next plain Enter is a break.
  assert.equal(composer({ isComposing: true, lastEnterAt: 9500 }).action, 'ignore');
});

test('the goal editor blocks Enter unless Ctrl/Cmd is held', () => {
  assert.equal(goal({}), 'block');
  assert.equal(goal({ shiftKey: true }), 'block');
  assert.equal(goal({ altKey: true }), 'block');
  assert.equal(goal({ isComposing: true }), 'block', 'IME confirmation never commits');
  assert.equal(goal({ keyCode: 229 }), 'block');
  assert.equal(goal({ repeat: true }), 'block');
  assert.equal(goal({ ctrlKey: true }), 'ignore');
  assert.equal(goal({ metaKey: true }), 'ignore');
  assert.equal(goal({ key: 'Escape' }), 'ignore');
  assert.equal(goal({ key: 'a' }), 'ignore');
  assert.equal(goal({ settings: settings({ goalGuard: false }) }), 'ignore');
  assert.equal(goal({ isComposing: true, settings: settings({ goalGuard: false }) }), 'ignore');
});
