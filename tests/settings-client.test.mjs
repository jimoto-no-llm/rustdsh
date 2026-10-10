import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Minimal host for the existing plugin boundary; exercise its async loading
// behavior without adding React or browser packages to the shipped component.
async function host(fetch, { confirm = () => true } = {}) {
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
    TextEncoder, URL,
    setInterval: () => 1, clearInterval: () => {},
    window: { confirm, __ModuleLoader__: { load(module) {
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

function field(ui, label, tag = 'textarea') {
  const row = find(ui, node => node.tag === 'label' &&
    node.children.some(child => child === label || child?.children?.includes(label)));
  assert.ok(row, label);
  return find(row, node => node.tag === tag);
}

test('multiline drafts keep newlines while typing and save every list as an array', async () => {
  let saved;
  const config = { context: {}, guard: {}, discord: {}, sessions: { stale_secs: 120 } };
  const fixture = await host(async (route, options) => {
    if (route === '/api/rdsh-discord') return { ok: true, json: async () => ({ ok: true, state: 'disabled' }) };
    if (options.method === 'POST') saved = JSON.parse(options.body).config;
    return { ok: true, json: async () => ({ ok: true, config: saved ?? config }) };
  });
  fixture.render(); await fixture.settle();
  const labels = ['作業中ファイル (1行1件)', '未解決タスク (1行1件)', '決定事項 (1行1件)', '制約 (1行1件)', '拒否する入力パターン（1行1件）'];
  for (const label of labels) {
    field(fixture.render(), label).props.onChange({ target: { value: 'first\n' } });
    assert.equal(field(fixture.render(), label).props.value, 'first\n', 'Enter must remain editable');
    field(fixture.render(), label).props.onChange({ target: { value: ' first \n\n second😀\n' } });
  }
  let ui = fixture.render();
  assert.match(JSON.stringify(ui), /未保存の変更があります/);
  await find(ui, node => node.tag === 'button' && node.children.includes('保存する')).props.onClick();
  for (const key of ['working_files', 'open_tasks', 'decisions', 'constraints'])
    assert.deepEqual(saved.context[key], ['first', 'second😀']);
  assert.deepEqual(saved.guard.deny, ['first', 'second😀']);
  assert.equal(saved.sessions.stale_secs, 120);
  ui = fixture.render();
  assert.equal(field(ui, labels[1]).props.value, 'first\nsecond😀');
});

test('cancelled reload and failed save preserve drafts; Discord-only save keeps them dirty', async () => {
  let posts = 0, loads = 0, rejectSave = false, confirmations = 0;
  let stored = { context: { goal: 'stored' }, discord: { enabled: false, details: 'before' } };
  const fixture = await host(async (route, options) => {
    if (route === '/api/rdsh-discord') return { ok: true, json: async () => ({ ok: true, state: 'disabled' }) };
    if (options.method === 'POST') {
      posts++;
      if (rejectSave) return { ok: false, json: async () => ({ error: 'save-failed' }) };
      stored = { ...stored, ...JSON.parse(options.body).config };
    } else loads++;
    return { ok: true, json: async () => ({ ok: true, config: stored }) };
  }, { confirm: () => { confirmations++; return false; } });
  fixture.render(); await fixture.settle();
  field(fixture.render(), 'ゴール', 'input').props.onChange({ target: { value: 'unsaved goal' } });
  field(fixture.render(), '未解決タスク (1行1件)').props.onChange({ target: { value: 'draft one\ndraft two\n' } });
  field(fixture.render(), '表示文', 'input').props.onChange({ target: { value: 'changed presence' } });
  let ui = fixture.render();
  await find(ui, node => node.tag === 'button' && node.children.includes('Discord設定を保存')).props.onClick();
  assert.equal(posts, 1);
  assert.equal(stored.context.goal, 'stored');
  assert.equal(stored.context.open_tasks, undefined);
  assert.equal(field(fixture.render(), '未解決タスク (1行1件)').props.value, 'draft one\ndraft two\n');
  ui = fixture.render();
  assert.match(JSON.stringify(ui), /未保存の変更があります/);
  await find(ui, node => node.tag === 'button' && node.children.includes('再読み込み')).props.onClick();
  assert.equal(confirmations, 1);
  assert.equal(loads, 1);
  assert.equal(field(fixture.render(), 'ゴール', 'input').props.value, 'unsaved goal');
  rejectSave = true;
  await find(fixture.render(), node => node.tag === 'button' && node.children.includes('保存する')).props.onClick();
  assert.equal(field(fixture.render(), 'ゴール', 'input').props.value, 'unsaved goal');
  assert.match(JSON.stringify(fixture.render()), /入力内容は残っています/);
});

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

test('Discord controls save changes without status polling overwriting edits', async () => {
  let saved;
  const config = { context: {}, beta: {}, discord: { enabled: false, application_id: '', details: 'dshで作業中', show_agent_status: true, show_elapsed: true } };
  const fixture = await host(async (path, options) => {
    if (path === '/api/rdsh-discord') return { ok: true, json: async () => ({ ok: true, state: 'disabled' }) };
    if (options.method === 'POST') saved = JSON.parse(options.body).config;
    return { ok: true, json: async () => ({ ok: true, config: saved ?? config }) };
  });
  fixture.render(); await fixture.settle();
  let ui = fixture.render();
  const enable = find(ui, node => node.tag === 'label' && node.children.includes('Discordに作業状態を表示する'));
  find(enable, node => node.tag === 'input').props.onChange({ target: { checked: true } });
  find(ui, node => node.tag === 'input' && node.props.placeholder === 'Discord Application ID').props.onChange({ target: { value: '123456789012345678' } });
  const agent = find(ui, node => node.tag === 'label' && node.children.includes('agentの稼働状態・稼働数を表示する'));
  find(agent, node => node.tag === 'input').props.onChange({ target: { checked: false } });
  ui = fixture.render();
  await find(ui, node => node.tag === 'button' && node.children.includes('保存する')).props.onClick();
  assert.deepEqual(saved.discord, { enabled: true, application_id: '123456789012345678', details: 'dshで作業中', show_agent_status: false, show_elapsed: true });
});

test('Discord preview and partial save preserve drafts in other sections', async () => {
  let submitted;
  const config = { context: { goal: 'Saved goal' }, beta: {}, discord: { enabled: false, details: 'dshで作業中' } };
  const fixture = await host(async (path, options) => {
    if (path === '/api/rdsh-discord') return { ok: true, json: async () => ({ ok: true, state: 'disabled', running_agents: 2 }) };
    if (options.method === 'POST') {
      submitted = JSON.parse(options.body).config;
      return { ok: true, json: async () => ({ ok: true, config: { ...config, ...submitted } }) };
    }
    return { ok: true, json: async () => ({ ok: true, config }) };
  });
  fixture.render(); await fixture.settle(); let ui = fixture.render();
  find(ui, node => node.props.placeholder === '例: dsh互換性を維持する').props.onChange({ target: { value: 'Unsaved goal' } });
  find(ui, node => node.props.placeholder === 'dshで作業中').props.onChange({ target: { value: 'あ'.repeat(100) } });
  ui = fixture.render();
  const preview = find(ui, node => node.props['aria-label'] === 'Discord表示プレビュー');
  assert.ok(JSON.stringify(preview).includes('agent稼働中 (2)'));
  assert.ok(JSON.stringify(preview).includes('あ'.repeat(42)));
  assert.ok(!JSON.stringify(preview).includes('あ'.repeat(43)));
  await find(ui, node => node.tag === 'button' && node.children.includes('Discord設定を保存')).props.onClick();
  assert.deepEqual(Object.keys(submitted), ['discord']);
  ui = fixture.render();
  assert.equal(find(ui, node => node.props.placeholder === '例: dsh互換性を維持する').props.value, 'Unsaved goal');
  assert.equal(find(ui, node => node.tag === 'button' && node.children.includes('Discord設定を保存')).props.disabled, true);
});

test('invalid Discord URLs block saving with an actionable error, then recover', async () => {
  const fixture = await host(async path => ({ ok: true, json: async () => path === '/api/rdsh-discord' ? { ok: true, state: 'disabled' } : { ok: true, config: { context: {}, discord: {} } } }));
  fixture.render(); await fixture.settle(); let ui = fixture.render();
  find(ui, node => node.props.placeholder === 'https://…').props.onChange({ target: { value: 'javascript:alert(1)' } });
  ui = fixture.render();
  assert.ok(find(ui, node => node.props.role === 'alert'));
  assert.equal(find(ui, node => node.tag === 'button' && node.children.includes('Discord設定を保存')).props.disabled, true);
  find(ui, node => node.props.placeholder === 'https://…').props.onChange({ target: { value: 'https://example.com' } });
  find(ui, node => node.props.placeholder === '例: dshについて').props.onChange({ target: { value: '詳しく見る' } });
  assert.equal(find(fixture.render(), node => node.tag === 'button' && node.children.includes('Discord設定を保存')).props.disabled, false);
});

test('Discord save failures keep the draft and provide a working retry', async () => {
  let failed = true;
  const config = { context: {}, discord: { details: 'Saved' } };
  const fixture = await host(async (path, options) => {
    if (path === '/api/rdsh-discord') return { ok: true, json: async () => ({ ok: true, state: 'disabled' }) };
    if (options.method === 'POST') return { ok: !failed, json: async () => failed ? { ok: false } : { ok: true, config: { ...config, ...JSON.parse(options.body).config } } };
    return { ok: true, json: async () => ({ config }) };
  });
  fixture.render(); await fixture.settle(); let ui = fixture.render();
  find(ui, node => node.props.placeholder === 'dshで作業中').props.onChange({ target: { value: 'Draft' } });
  const save = () => find(fixture.render(), node => node.tag === 'button' && node.children.includes('Discord設定を保存')).props.onClick();
  await save(); ui = fixture.render();
  assert.ok(find(ui, node => node.props.role === 'alert' && node.children.some(c => typeof c === 'string' && c.includes('保存できません'))));
  assert.equal(find(ui, node => node.props.placeholder === 'dshで作業中').props.value, 'Draft');
  failed = false; await save();
  assert.equal(find(fixture.render(), node => node.tag === 'button' && node.children.includes('Discord設定を保存')).props.disabled, true);
});

test('connection alone is not reported as an acknowledged current preview', async () => {
  for (const details of ['Old', 'Current']) {
    const fixture = await host(async path => ({ ok: true, json: async () => path === '/api/rdsh-discord'
      ? { ok: true, state: 'connected', running_agents: 0, published_activity: { details, status_display_type: 2, state: '待機中' } }
      : { config: { context: {}, discord: { enabled: true, details: 'Current', show_elapsed: false, show_image: false } } } }));
    fixture.render(); await fixture.settle();
    const reflected = find(fixture.render(), node => node.props.role === 'status' && node.children.includes('Discordに反映しました'));
    assert.equal(!!reflected, details === 'Current');
  }
});
