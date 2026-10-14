import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// The phone layout is a browser half only: no host state, no network. Run the
// shipped bundle in a VM with a minimal DOM so the media query, the rail
// attribute and the cleanup path are checked without a browser package.
const source = await readFile(new URL('../plugins/rdsh-mobile-ui/client.js', import.meta.url), 'utf8');

function browserHost({ matches = true } = {}) {
  const styles = [];
  const mediaListeners = new Set();
  const root = {
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
  const document = {
    documentElement: root,
    head: { appendChild(node) { styles.push(node); } },
    createElement(tag) {
      return {
        tag,
        attributes: new Map(),
        textContent: '',
        setAttribute(name, value) { this.attributes.set(name, value); },
        remove() { const index = styles.indexOf(this); if (index >= 0) styles.splice(index, 1); },
      };
    },
  };
  const state = { matches };
  const media = {
    get matches() { return state.matches; },
    addEventListener(name, listener) { mediaListeners.add(listener); },
    removeEventListener(name, listener) { mediaListeners.delete(listener); },
  };
  let query;
  const cleanups = [];
  let exported;
  vm.runInNewContext(source, {
    document,
    window: {
      matchMedia(asked) { query = asked; return media; },
      __ModuleLoader__: {
        load(module) {
          exported = module.factory(() => { throw new Error('the mobile UI bundle requires nothing'); });
        },
      },
    },
  });
  exported.apply({ effect(effect, label) { cleanups.push({ label, dispose: effect() }); } });
  return {
    exported,
    root,
    styles,
    cleanups,
    query: () => query,
    fireChange(next) { state.matches = next; for (const listener of mediaListeners) listener(); },
    listeners: () => mediaListeners.size,
  };
}

function rail(host) {
  return host.root.attributes.get('data-rdsh-mobile-rail');
}

test('the bundle declares no host dependency and installs one owned style element', async () => {
  const host = browserHost();
  // The VM realm has its own Array.prototype, so compare by content.
  assert.equal(host.exported.inject.length, 0);
  assert.equal(host.cleanups.length, 1);
  assert.equal(host.styles.length, 1);
  const [style] = host.styles;
  assert.equal(style.tag, 'style');
  assert.equal(style.attributes.get('data-rdsh-mobile-ui'), 'true');
  assert.equal(host.query(), '(max-width: 767px)');
});

test('every phone rule is scoped by the plugin media query and its own attribute', async () => {
  const host = browserHost();
  const css = host.styles[0].textContent;
  assert.ok(css.startsWith('@media (max-width: 767px) {'));
  for (const selector of [
    '.pI_x6G_frame[data-sidebar-collapsed]', // layout frame, DSH 0.2.0-rc.2
    '.pI_x6G_centerCol',
    '.pI_x6G_detailsCol', // 0.1.2-rc.1 name, kept for older releases
    '.pI_x6G_rightbarCol', // 0.2.0-rc.2 name
    '.pI_x6G_sidebarCol',
    '.hHd-Xa_toggle',
    '.hHd-Xa_railMark',
    '.wSkVaW_root',
    '[data-question-key]',
    '[data-plan-review-key]',
  ]) {
    assert.ok(css.includes(selector), `missing selector ${selector}`);
  }
  for (const variable of ['--dsh-chat-user-width', '--dsh-chat-content-width', '--dsh-composer-card-max-width']) {
    assert.ok(css.includes(variable + ': 100% !important'), `missing width variable ${variable}`);
  }
  assert.ok(css.includes('max-width: min(100%, 95vw)'), 'question cards keep the phone ceiling');
  // Upstream Smart-DSH owns [data-smart-rail]; both bundles may be installed at
  // once, so this one must never touch the other plugin's state.
  assert.ok(!css.includes('data-smart-rail'), 'the adapted rules use their own attribute');
});

test('the rail attribute follows the viewport and is removed above the breakpoint', async () => {
  const wide = browserHost({ matches: false });
  assert.equal(rail(wide), undefined, 'a desktop viewport keeps the stock layout');
  wide.fireChange(true);
  assert.equal(rail(wide), 'closed');
  wide.fireChange(false);
  assert.equal(rail(wide), undefined);

  const phone = browserHost();
  assert.equal(rail(phone), 'closed');
  phone.fireChange(false);
  assert.equal(rail(phone), undefined);
  phone.fireChange(true);
  assert.equal(rail(phone), 'closed');
});

test('disposal removes the style, the attribute and the media listener', async () => {
  const host = browserHost();
  assert.equal(host.listeners(), 1);
  host.cleanups[0].dispose();
  assert.equal(host.styles.length, 0);
  assert.equal(rail(host), undefined);
  assert.equal(host.listeners(), 0);
  host.fireChange(false); // a late event after disposal changes nothing
  assert.equal(host.styles.length, 0);
});

test('the package composes as a web client bundle and keeps the upstream credit', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugins/rdsh-mobile-ui/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'rdsh-mobile-ui');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.dsh.client.inject, []);
  const patch = await readFile(new URL('../plugins/rdsh-mobile-ui/cordis.patch.yml', import.meta.url), 'utf8');
  assert.ok(patch.includes('rdsh-mobile-ui'));
  const host = await import('../plugins/rdsh-mobile-ui/index.js');
  assert.equal(typeof host.apply, 'function');
  assert.ok(source.includes('https://github.com/hikarioyama/Smart-DSH'));
  assert.ok(source.includes('MIT'));
});
