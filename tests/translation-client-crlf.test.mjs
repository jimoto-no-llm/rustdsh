import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const client = await readFile(new URL('../plugins/rdsh-translation/client.js', import.meta.url), 'utf8');

async function offersTranslation(text) {
  const cells = [], cleanups = [];
  let cursor = 0, component;
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat() }),
    useState(initial) { const index = cursor++; if (!(index in cells)) cells[index] = initial; return [cells[index], value => { cells[index] = value; }]; },
    useRef(initial) { const index = cursor++; return cells[index] ||= { current: initial }; },
    useEffect(effect) { const index = cursor++; if (!(index in cells)) { cells[index] = true; cleanups.push(effect()); } },
  };
  const data = { status: 'settled', finalNode: { messageId: 'answer-1', interrupted: false, blocks: [{ kind: 'text', text }] } };
  const ctx = {
    slots: { inject: (_slot, register) => register(), register(_options, view) { component = view; } },
    remote: { commands: { execute: () => assert.fail('visibility checks must not invoke translation') } },
  };
  vm.runInNewContext(client, {
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, kana_threshold: 0.08 }) }),
    window: { __ModuleLoader__: { load(module) {
      module.factory(name => { assert.equal(name, 'react'); return React; }).apply(ctx);
    } } },
  });
  const render = () => {
    cursor = 0;
    return component({ messageId: 'answer-1', useChat: select => select({ nodes: new Map([['answer', { kind: 'assistant-step', data }]]) }) });
  };
  try {
    render();
    await new Promise(resolve => setImmediate(resolve));
    const view = render();
    return Boolean(view?.children.some(node => node?.props?.['data-testid'] === 'rdsh-translate-action'));
  } finally {
    for (const cleanup of cleanups) cleanup?.();
  }
}

for (const [newlineName, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  for (const quote of ['', '> ']) {
    for (const fence of ['```', '~~~']) {
      const code = [`${quote}${fence}js`, `${quote}console.log("English in code");`, `${quote}${fence}`];
      const label = `${newlineName}, ${quote ? 'quoted' : 'plain'}, ${fence}`;
      test(`translation client: closed fence keeps following English and Chinese prose eligible (${label})`, async () => {
        for (const prose of ['The explanation follows the code.', '这是代码之后的说明。']) {
          assert.equal(await offersTranslation([...code, prose].join(newline)), true, prose);
        }
      });
      test(`translation client: consecutive fences keep following prose eligible (${label})`, async () => {
        const nextFence = fence === '```' ? '~~~' : '```';
        const nextCode = [`${quote}${nextFence}python`, `${quote}print("More code")`, `${quote}${nextFence}`];
        for (const prose of ['The explanation follows both snippets.', '这是两个代码块之后的说明。']) {
          assert.equal(await offersTranslation([...code, ...nextCode, prose].join(newline)), true, prose);
        }
      });
      test(`translation client: code-only, unclosed fences and Japanese prose have no action (${label})`, async () => {
        for (const lines of [code, code.slice(0, 2).concat('Still inside the unclosed code block.'), [...code, 'これはコードの後の日本語の説明です。']]) {
          assert.equal(await offersTranslation(lines.join(newline)), false, lines.join(newline));
        }
      });
    }
  }
}
