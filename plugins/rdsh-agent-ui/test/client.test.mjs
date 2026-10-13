import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');

function makeReact(states, refs) {
  let stateIndex = 0;
  let refIndex = 0;
  const React = {
    Fragment: Symbol.for('rdsh-agent-ui-fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const index = stateIndex++;
      return [states[index] === undefined ? initial : states[index], () => {}];
    },
    useRef(initial) {
      const index = refIndex++;
      return refs[index] || { current: initial };
    },
    useEffect() {},
    useCallback(callback) { return callback; },
  };
  return React;
}

function mountPanel(surface) {
  let definition;
  vm.runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
  });
  const portalContainer = {};
  const React = makeReact(
    [surface, false, null, false, null, {}, null, 4, 1],
    [{ current: null }, { current: portalContainer }, { current: null }, { current: surface }],
  );
  const plugin = definition.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom')
      return { createPortal: (child, container) => ({ type: 'portal', child, container }) };
    throw new Error('unexpected module: ' + name);
  });

  let registerPanel;
  let Panel;
  plugin.apply({
    sessions: {},
    uiConversation: {},
    slots: {
      inject(_slot, register) { registerPanel = register; },
      register(_metadata, component) { Panel = component; },
    },
  });
  registerPanel();
  return { rendered: Panel({ sessionId: 'session-a', send: async () => true }), React, portalContainer };
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return find(node.child, predicate);
}

test('an anchored portal renders while the inline turn-tail fallback is hidden', () => {
  const surface = { surface_id: 'surface-a', revision: 1, blocks: [] };
  const { rendered, React, portalContainer } = mountPanel(surface);
  const portal = find(rendered, (entry) => entry.type === 'portal');

  assert.equal(rendered.type, React.Fragment);
  assert.ok(portal);
  assert.equal(portal.container, portalContainer);
});
