// The hide pass leaves every menu alone until the Feedback row is present.
//
// DSH hard-codes Settings / Feedback / Sign in in its account menu, and the
// bundle's patch layer cannot remove that row. The client half hides it once it
// appears; these tests pin the matching rules and the signed-out guard.
import test from 'node:test';
import assert from 'node:assert/strict';

const PLUGIN = new URL('../client.js', import.meta.url);

function fakeRow(label, { icon = true } = {}) {
  const row = {
    textContent: label,
    hidden: false,
    attributes: {},
    dataset: {},
    querySelector: (selector) => (icon && selector === 'svg' ? { found: true } : null),
    setAttribute(name, value) {
      row.attributes[name] = value;
    },
  };
  return row;
}

function fakeMenu(rows, { signedOut }) {
  const anchor = {
    querySelector: (selector) =>
      selector === '[data-signed-out="true"]' && signedOut ? { signedOut: true } : null,
  };
  return {
    parentElement: anchor,
    querySelectorAll: () => rows,
  };
}

// Install the module loader shim, import the plugin, and run apply() once.
async function applyWith(menus) {
  let observer = null;
  globalThis.document = {
    documentElement: {},
    querySelectorAll: () => menus,
  };
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      observer = this;
    }
    observe() {}
    disconnect() {
      observer = null;
    }
  };
  globalThis.window = { __ModuleLoader__: { load: (module) => (globalThis.__plugin = module) } };
  await import(PLUGIN.href + '?v=' + Math.random());
  const plugin = globalThis.__plugin.factory((id) => {
    throw new Error('no host module expected: ' + id);
  });
  const dispose = plugin.apply();
  return { dispose, alive: () => observer !== null };
}

function cleanup() {
  delete globalThis.document;
  delete globalThis.MutationObserver;
  delete globalThis.window;
  delete globalThis.__plugin;
}

test('the feedback row is hidden in the signed-out menu only', async () => {
  const feedback = fakeRow('Feedback');
  const settings = fakeRow('Settings');
  const signIn = fakeRow('Sign in');
  const signedOut = [fakeMenu([settings, feedback, signIn], { signedOut: true })];

  const { dispose, alive } = await applyWith(signedOut);
  assert.equal(feedback.hidden, true);
  assert.equal(feedback.attributes['aria-hidden'], 'true');
  assert.equal(feedback.dataset.rdshNoFeedback, '1');
  assert.equal(settings.hidden, false);
  assert.equal(signIn.hidden, false);
  assert.equal(alive(), true);
  dispose();
  cleanup();
});

test('a signed-in menu and a label-only row are left alone', async () => {
  const signedInFeedback = fakeRow('Feedback');
  const labelOnly = fakeRow('Feedback', { icon: false });
  const menus = [
    fakeMenu([signedInFeedback], { signedOut: false }),
    fakeMenu([labelOnly], { signedOut: true }),
  ];

  const { dispose } = await applyWith(menus);
  assert.equal(signedInFeedback.hidden, false);
  assert.equal(labelOnly.hidden, false);
  dispose();
  cleanup();
});

test('the zh label is hidden too', async () => {
  const zh = fakeRow('意见反馈');
  const { dispose } = await applyWith([fakeMenu([zh], { signedOut: true })]);
  assert.equal(zh.hidden, true);
  dispose();
  cleanup();
});
