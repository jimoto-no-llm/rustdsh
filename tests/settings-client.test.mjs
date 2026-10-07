import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Minimal host for the existing plugin boundary; exercise its async loading
// behavior without adding React or browser packages to the shipped component.
async function host(fetch) {
  const state = [];
  let cursor = 0, component;
  const mountedEffects = new Set();
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (value) => {
        state[index] = typeof value === 'function' ? value(state[index]) : value;
      }];
    },
    useCallback: (callback) => callback,
    useEffect(effect) {
      const index = cursor++;
      if (!mountedEffects.has(index)) {
        mountedEffects.add(index);
        effect();
      }
    },
  };
  const source = await readFile(new URL('../plugins/rdsh-settings/client.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    fetch,
    window: { __ModuleLoader__: { load(module) {
      module.factory(() => React).apply({ slots: {
        inject: (_name, install) => install(),
        register: (_options, section) => { component = section; },
      } });
    } } },
  });
  return {
    render() { cursor = 0; return component(); },
    async settle() { await new Promise((resolve) => setImmediate(resolve)); },
  };
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  return node.children.map((child) => find(child, predicate)).find(Boolean);
}

test('failed settings load offers an error and retry instead of permanent loading', async () => {
  let ok = false;
  const fixture = await host(async () => ({
    ok, status: ok ? 200 : 400,
    json: async () => ok ? { ok: true, config: { context: {}, beta: {} } } : { ok: false, error: 'invalid-settings' },
  }));
  fixture.render();
  await fixture.settle();
  const failed = fixture.render();
  assert.ok(find(failed, (node) => node.props.role === 'alert'));
  assert.ok(!JSON.stringify(failed).includes('読み込み中…'));
  const retry = find(failed, (node) => node.tag === 'button' && node.children.includes('再読み込み'));
  assert.ok(retry);
  ok = true;
  await retry.props.onClick();
  const restored = fixture.render();
  assert.ok(find(restored, (node) => node.tag === 'button' && node.children.includes('保存する')));
});

test('a failed refresh discards stale editable settings even if an error response includes config', async () => {
  let ok = true;
  const fixture = await host(async () => ({
    ok, status: ok ? 200 : 403,
    json: async () => ({ config: { context: {}, beta: {} } }),
  }));
  fixture.render();
  await fixture.settle();
  const loaded = fixture.render();
  const retry = find(loaded, (node) => node.tag === 'button' && node.children.includes('再読み込み'));
  assert.ok(retry);
  ok = false;
  await retry.props.onClick();
  const failed = fixture.render();
  assert.ok(find(failed, (node) => node.props.role === 'alert'));
  assert.equal(find(failed, (node) => node.tag === 'button' && node.children.includes('保存する')), undefined);
});

test('clearing the dashboard port saves its default rather than privileged port one', async () => {
  let saved;
  const config = { context: {}, beta: {}, serve: { port: 38080 } };
  const fixture = await host(async (_path, options) => {
    if (options.method === 'POST') saved = JSON.parse(options.body).config;
    return { ok: true, status: 200, json: async () => ({ ok: true, config: saved ?? config }) };
  });
  fixture.render();
  await fixture.settle();
  const loaded = fixture.render();
  const port = find(loaded, (node) => node.tag === 'input' && node.props.value === 38080);
  assert.ok(port);
  port.props.onChange({ target: { value: '' } });
  const updated = fixture.render();
  await find(updated, (node) => node.tag === 'button' && node.children.includes('保存する')).props.onClick();
  assert.equal(saved.serve.port, 38080);
});
