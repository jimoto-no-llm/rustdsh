import test from 'node:test';
import assert from 'node:assert/strict';

let plugin;
let configuredThreshold = 0.08;
let captureEffects = false;
let fetchedThreshold = null;
const effects = [];
const React = {
  createElement(type, props, ...children) { return { type, props: props || {}, children }; },
  useState(initial) {
    if (initial === null) return [captureEffects ? fetchedThreshold : configuredThreshold, (value) => { fetchedThreshold = value; }];
    return [initial, () => {}];
  },
  useEffect(effect) { if (captureEffects) effects.push(effect); },
};
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      plugin = factory((name) => {
        if (name === 'react') return React;
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: () => null };
        throw new Error(`unexpected module ${name}`);
      });
    },
  },
};
await import('../client.js?test=client-action');

const registrations = [];
const slotRegistrations = [];
const eventDefinitions = [];
plugin.apply({
  slots: {
    inject(name, setup) { registrations.push({ name, setup }); },
    register(definition, component) {
      const registration = { definition, component };
      slotRegistrations.push(registration);
      return registration;
    },
  },
  remote: { commands: { execute() {} } },
  uiConversation: { events: { register(definition) { eventDefinitions.push(definition); } } },
  effect(setup) { setup(); },
});
const action = registrations.find((entry) => entry.name === 'conversation.chat.assistant-actions').setup().component;

function renderAction({ status = 'settled', blocks = [{ type: 'text', text: 'A concise English answer.' }], interrupted = false, threshold = 0.08 } = {}) {
  configuredThreshold = threshold;
  const data = { status, finalNode: { messageId: 'message-1', blocks, ...(interrupted ? { interrupted: true } : {}) } };
  return action({
    messageId: 'message-1',
    useChat: (select) => select({ nodes: new Map([['assistant', { kind: 'assistant-step', data }]]) }),
    execute: () => Promise.resolve({ ok: true, value: { result: { kind: 'success' } } }),
  });
}

function hasButton(tree) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return false;
  if (tree.type === 'button' && tree.props['data-testid'] === 'rdsh-translate-action') return true;
  return tree.children?.some(hasButton) === true;
}

test('the Web action appears only for settled non-Japanese final answers', () => {
  assert.equal(hasButton(renderAction()), true);
  assert.equal(hasButton(renderAction({ blocks: [{ type: 'text', text: '今日はいい天気です。' }] })), false);
  assert.equal(hasButton(renderAction({ status: 'running' })), false);
  assert.equal(hasButton(renderAction({ interrupted: true })), false);
  assert.equal(hasButton(renderAction({ blocks: [{ type: 'text', text: 'English' }, { type: 'image' }] })), false);
  assert.equal(hasButton(renderAction({ blocks: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'English' }] })), true);
});

test('the configured kana threshold controls the actual action component', () => {
  const mixed = [{ type: 'text', text: 'A aa あ' }];
  assert.equal(hasButton(renderAction({ blocks: mixed, threshold: 0.2 })), false);
  assert.equal(hasButton(renderAction({ blocks: mixed, threshold: 0.4 })), true);
});

test('the action reads its configured threshold from the config endpoint', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    captureEffects = false;
    fetchedThreshold = null;
  });
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests += 1;
    assert.equal(url, '/api/rdsh-translation/config');
    assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => ({ ok: true, kana_threshold: 0.4 }) };
  };
  captureEffects = true;
  fetchedThreshold = null;
  const mixed = [{ type: 'text', text: 'A aa あ' }];
  assert.equal(hasButton(renderAction({ blocks: mixed, threshold: 0.08 })), false);
  const load = effects.pop();
  const cleanup = load();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(hasButton(renderAction({ blocks: mixed, threshold: 0.08 })), true);
  cleanup();
});

test('the replacement event is projected as one chat node with a collapsed original answer', () => {
  const definition = eventDefinitions.find((entry) => entry.kind === 'rdsh-ja-translation');
  assert.ok(definition);
  const original = {
    type: 'assistant/message',
    seq: 7,
    data: { turn: 2, step: 1, message: { id: 'message-1', content: [{ type: 'text', text: 'Original English answer.' }] } },
  };
  const replacement = {
    type: 'user/message',
    surfaceOp: 'replace',
    seq: 8,
    data: {
      content: [{ type: 'text', text: '回答を用意しました。' }],
      source: {
        rdshTranslation: true,
        originalMessageId: 'message-1',
        originalText: 'Original English answer.',
        originalTurn: 2,
        originalStep: 1,
      },
    },
  };
  assert.deepEqual(definition.match(original), { id: 'message-1', role: 'start' });
  assert.deepEqual(definition.match(replacement), { id: 'message-1', role: 'start' });
  assert.equal(definition.match({ ...replacement, data: { ...replacement.data, source: {} } }), null);

  const originalState = definition.start({}, { event: original });
  const state = definition.update({ state: originalState }, { event: replacement });
  const location = { kind: 'surface', seq: 8 };
  const node = definition.buildViewNode({
    key: 'test-context-key',
    id: 'message-1',
    state,
    matches: [{ event: original }, { event: replacement, location }],
  });
  assert.equal(node.kind, 'rdsh-ja-translation');
  assert.equal(node.anchorSeq, 8);
  assert.equal(node.location, location);
  assert.equal(node.data.translatedText, '回答を用意しました。');
  assert.equal(node.data.originalText, 'Original English answer.');
  assert.equal(node.data.originalAssistantNodeKey, '14:assistant-step2:1');

  registrations.find((entry) => entry.name === 'conversation.chat.node').setup();
  const view = slotRegistrations.find((entry) => entry.definition.key === 'rdsh-ja-translation').component({ node });
  assert.equal(view.type, 'article');
  assert.equal(view.props.className, 'rdsh-ja-translation');
  assert.ok(view.children.some((child) => child?.type === 'details'), 'the source answer stays available in a disclosure');
  assert.ok(view.children.some((child) => child?.type === 'style' && child.children[0].includes('data-chat-node-key="14:assistant-step2:1"')));

  // A reopened session can rebuild the same view from the durable replacement event alone.
  const restoredState = definition.start({}, { event: replacement });
  const restoredNode = definition.buildViewNode({
    key: 'restored-context-key',
    id: 'message-1',
    state: restoredState,
    matches: [{ event: replacement, location }],
  });
  assert.equal(restoredNode.anchorSeq, 8);
  assert.equal(restoredNode.data.translatedText, '回答を用意しました。');
  assert.equal(restoredNode.data.originalText, 'Original English answer.');
});
