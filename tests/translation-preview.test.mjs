import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { apply, translatePreview, replaceTranslation, translationRoute, registerConfigApi } from '../plugins/rdsh-translation/index.js';
import { protectLiterals, restoreLiterals, shouldOfferTranslation } from '../plugins/rdsh-translation/translation-core.js';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const client = await readFile(new URL('../plugins/rdsh-translation/client.js', import.meta.url), 'utf8');
function agentFixture(text = 'The answer is ready.') {
  const events = [{ seq: 10, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'answer-1', content: [{ type: 'text', text }] } } },
    { seq: 11, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  let maintenance = false;
  const agent = { status: 'idle', options: { provider: 'initial', model: 'old' },
    session: { snapshotEvents: () => structuredClone(events), surface: { nodes: Object.freeze([10]) }, requestHeader: () => ({ config: { provider: 'current', model: 'selected' } }),
      append() { throw new Error('会話への書込みは禁止'); }, deriveMessages: () => structuredClone(events) },
    async runMaintenance(job) { if (maintenance) throw new Error('busy'); maintenance = true; try { return await job(new AbortController().signal); } finally { maintenance = false; } } };
  return { agent, events };
}
function llmFixture(transform = (text) => text.replace('The answer is ready.', '回答の準備ができました。')) {
  const calls = [];
  return { calls, async *stream(request) {
    calls.push(request);
    const marker = '--- 翻訳対象 ---\n';
    const prompt = request.messages[0].content[0].text;
    yield { type: 'text-delta', text: transform(prompt.slice(prompt.indexOf(marker) + marker.length)) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
}
function chatData(text = 'The answer is ready.') {
  return { status: 'settled', finalNode: { messageId: 'answer-1', interrupted: false, blocks: [{ kind: 'text', text }] } };
}
function localeFixture(language = 'ja') {
  const dictionaries = new Map();
  const state = { active: language };
  return { state, dictionaries,
    getSnapshot: () => ({ active: state.active, locales: [{ id: 'zh' }, { id: 'en' }], revision: 0 }),
    register(namespace, id, dictionary) {
      const key = `${namespace}:${id}`;
      assert.equal(dictionaries.has(key), false, 'Each dictionary has one owner');
      dictionaries.set(key, dictionary);
      return () => dictionaries.delete(key);
    },
    addLanguage() { assert.fail('the translation plugin must not own the Japanese language definition'); },
    bind(namespace) { return (key) => dictionaries.get(`${namespace}:${state.active}`)?.[key] ?? dictionaries.get(`${namespace}:en`)?.[key] ?? key; },
  };
}
function uiHost(execute, { data = chatData(), kanaThreshold = 0.08, responseOk = true, locale = localeFixture() } = {}) {
  const cells = [], effects = [];
  let cursor = 0, component, registration, current = data;
  const React = { createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat() }),
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], (value) => { cells[i] = typeof value === 'function' ? value(cells[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return cells[i] ||= { current: initial }; },
    useEffect(effect) { const i = cursor++; if (!(i in cells)) { cells[i] = true; effects.push(effect()); } } };
  const ctx = { locale, effect: (install) => { effects.push(install()); return () => {}; }, slots: { inject: (_slot, register) => register(), register(options, view) { registration = options; component = view; } }, remote: { commands: { execute } } };
  vm.runInNewContext(client, { fetch: async () => ({ ok: responseOk, json: async () => ({ ok: responseOk, kana_threshold: kanaThreshold }) }), window: { __ModuleLoader__: { load(module) {
    const plugin = module.factory((name) => { assert.equal(name, 'react'); return React; });
    // Cordis validates the root service independently of its dotted children.
    // Match the real Web host's admission so a missing `remote` cannot be hidden.
    const scoped = new Proxy(ctx, { get(target, key) {
      if (['slots', 'remote', 'locale'].includes(key) && !plugin.inject.includes(key)) throw new Error(`cannot get property "${key}" without inject`);
      return Reflect.get(target, key);
    } });
    plugin.apply(scoped);
  } } } });
  return { registration, async settle() { await new Promise((done) => setImmediate(done)); },
    render(messageId = 'answer-1') { cursor = 0; return component({ messageId, t: locale.bind('rdsh-translation'), useChat: (select) => select({ nodes: new Map([['answer', { kind: 'assistant-step', data: current }]]) }), ...registration.inject('session-1') }); },
    setData(data) { current = data; }, dispose() { for (const off of effects) off?.(); } };
}
function find(node, predicate) { if (!node || typeof node !== 'object') return undefined; if (predicate(node)) return node; return node.children.map((child) => find(child, predicate)).find(Boolean); }
const button = (view) => find(view, (node) => node.tag === 'button');
const textOf = (node) => !node ? '' : typeof node === 'object' ? node.children.map(textOf).join('') : String(node);

test('translation preview: button invokes the registered command and displays translation without changing the conversation', async () => {
  const { agent } = agentFixture();
  const llm = llmFixture();
  const commands = new Map();
  const ctx = { llm, commands: { register(value) { commands.set(value.name, value); return () => {}; } }, effect: (fn) => fn(), inject: () => ({ dispose: async () => {} }) };
  const dispose = apply(ctx);
  const command = commands.get('ja-preview');
  assert.deepEqual([...commands.keys()].sort(), ['ja-preview', 'ja-replace'], 'the plugin registers a display and an explicit replacement command');
  const before = JSON.stringify(agent.session.deriveMessages());
  const ui = uiHost(async (sessionId, line, attachments) => {
    assert.equal(sessionId, 'session-1'); assert.equal(line, '/ja-preview answer-1'); assert.equal(attachments.length, 0);
    return { ok: true, value: { result: await command.handler({ agent, rawInput: line.split(' ')[1], signal: new AbortController().signal }) } };
  });
  ui.render(); await ui.settle();
  assert.equal(command.recordInput, false);
  assert.equal(commands.get('ja-replace').recordInput, false);
  await button(ui.render()).props.onClick();
  assert.match(textOf(ui.render()), /回答の準備ができました/);
  assert.match(textOf(ui.render()), /原文と会話履歴は変更していません/);
  assert.equal(JSON.stringify(agent.session.deriveMessages()), before);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].provider, 'current'); assert.equal(llm.calls[0].model, 'selected');
  assert.equal(llm.calls[0].messages.length, 1);
  ui.dispose(); await dispose();
});

test('translation preview: copy comes from the locale catalog and follows the active language', async () => {
  const locale = localeFixture('ja');
  const ui = uiHost(() => assert.fail('copy checks must not translate'), { locale });
  ui.render(); await ui.settle();
  assert.deepEqual([...locale.dictionaries.keys()].sort(), ['rdsh-translation:en', 'rdsh-translation:ja', 'rdsh-translation:zh']);
  assert.equal(ui.registration.locale, 'rdsh-translation');
  assert.match(textOf(ui.render()), /日本語訳を表示/);
  locale.state.active = 'en';
  assert.match(textOf(ui.render()), /Show Japanese translation/);
  locale.state.active = 'zh';
  assert.match(textOf(ui.render()), /显示日文翻译/);
  ui.dispose();
});

test('translation preview: Japanese, code-only, running and interrupted answers have no action', async () => {
  const variants = [chatData('これは日本語の回答です。'), chatData('```js\nconsole.log("English");\n```'),
    chatData('> ```js\n> console.log("English");\n> ```'), chatData('    print("Hello world")\n'), { ...chatData(), status: 'running' },
    { ...chatData(), finalNode: { ...chatData().finalNode, interrupted: true } },
    { ...chatData(), finalNode: { ...chatData().finalNode, blocks: [{ kind: 'image' }] } }];
  for (const data of variants) { const ui = uiHost(() => assert.fail('呼出し不可'), { data }); ui.render(); await ui.settle(); assert.equal(ui.render(), null); ui.dispose(); }
  const chinese = uiHost(() => {}, { data: chatData('这是中文回答。') }); chinese.render(); await chinese.settle(); assert.ok(button(chinese.render())); chinese.dispose();
});

test('translation preview: configured threshold controls the offer', async () => {
  for (const [kanaThreshold, expected] of [[0.01, false], [0.5, true]]) {
    const ui = uiHost(() => {}, { data: chatData('あabcdefghij'), kanaThreshold }); ui.render(); await ui.settle(); assert.equal(Boolean(button(ui.render())), expected); ui.dispose();
  }
});

test('translation preview: double click issues one request and a failed request can be retried', async () => {
  let done, calls = 0;
  const ui = uiHost(() => { calls++; return new Promise((resolve) => { done = resolve; }); });
  ui.render(); await ui.settle(); const click = button(ui.render()).props.onClick;
  const pending = click(); await click(); assert.equal(calls, 1); assert.equal(button(ui.render()).props.disabled, true);
  done({ ok: true, value: { result: { kind: 'error', text: '翻訳を取得できませんでした' } } }); await pending;
  assert.match(textOf(find(ui.render(), (node) => node.props.role === 'alert')), /翻訳を取得できませんでした/);
  assert.equal(button(ui.render()).props.disabled, false);
  const retry = button(ui.render()).props.onClick(); done({ ok: true, value: { result: { kind: 'success', text: '再試行に成功しました。' } } }); await retry;
  assert.equal(calls, 2); assert.match(textOf(ui.render()), /再試行に成功/); ui.dispose();
});

test('translation preview: old request cannot populate another answer or an unmounted component', async () => {
  let done;
  const ui = uiHost(() => new Promise((resolve) => { done = resolve; })); ui.render(); await ui.settle();
  const pending = button(ui.render()).props.onClick(); ui.setData({ ...chatData(), finalNode: { ...chatData().finalNode, messageId: 'answer-2' } }); ui.render('answer-2');
  done({ ok: true, value: { result: { kind: 'success', text: '古い訳文' } } }); await pending;
  assert.doesNotMatch(textOf(ui.render('answer-2')), /古い訳文/);
  const second = button(ui.render('answer-2')).props.onClick(); ui.dispose(); done({ ok: true, value: { result: { kind: 'success', text: '破棄後の訳文' } } }); await second;
  assert.doesNotMatch(textOf(ui.render('answer-2')), /破棄後の訳文/);
});

test('translation preview: malformed or rejected command results are errors, never partial success', async () => {
  for (const value of [{ ok: false }, { ok: true }, { ok: true, value: { result: { kind: 'success', text: '' } } }]) {
    const ui = uiHost(async () => value); ui.render(); await ui.settle(); await button(ui.render()).props.onClick(); assert.ok(find(ui.render(), (node) => node.props.role === 'alert')); assert.equal(find(ui.render(), (node) => node.tag === 'section'), undefined); ui.dispose();
  }
});

test('translation preview: literals survive and missing or duplicate protection tokens are rejected', () => {
  const source = 'Use `src/main.rs`, file_name and --help at C:\\work\\file.rs.\n```rust\nfn main() {}\n```';
  const input = protectLiterals(source, 'fixture');
  assert.equal(restoreLiterals(input.masked, input.literals), source);
  assert.throws(() => restoreLiterals('省略した訳文', input.literals));
  assert.throws(() => restoreLiterals(input.masked + input.literals[0].token, input.literals));
  assert.equal(shouldOfferTranslation([{ type: 'text', text: '```rust\nfn main() {}\n```' }]), false);
});

test('translation preview: Unicode paths and quoted or indented code stay intact', () => {
  for (const literal of ['/home/用户/output.json', '\\\\共有\\用户\\回答.json', '../資料/output.json', '資料/output.json',
    '> ```js\n> console.log("Hello world");\n> ```\n', '    print("Hello world")\n']) {
    const source = `Example:\n\n${literal}`;
    const input = protectLiterals(source, 'boundary');
    assert.ok(input.literals.some(({ value }) => value.includes(literal)), literal);
    const translated = input.masked.replace('Example:', '例:').replaceAll('用户', '利用者').replaceAll('Hello world', 'こんにちは');
    assert.equal(restoreLiterals(translated, input.literals), source.replace('Example:', '例:'));
  }
  for (const code of ['> ```js\n> console.log("English");\n> ```', '    print("Hello world")\n']) {
    assert.equal(shouldOfferTranslation([{ type: 'text', text: code }]), false);
  }
});

test('translation preview: interrupted, hidden, malformed, unfinished and oversized answers never call the model', async () => {
  for (const mutate of [({ agent }) => { agent.status = 'running'; }, ({ events }) => { events[0].data.interrupted = true; },
    ({ agent }) => { agent.session.surface.nodes = []; }, ({ events }) => { events[1].data.reason.kind = 'aborted'; },
    ({ events }) => { events[0].data.message.content = [{ type: 'image' }]; }, ({ events }) => { events[0].data.message.content[0].text = '大'.repeat(22000); }]) {
    const fixture = agentFixture(); mutate(fixture); const llm = llmFixture();
    const result = await translatePreview({ agent: fixture.agent, llm, messageId: 'answer-1' }); assert.equal(result.kind, 'error'); assert.equal(llm.calls.length, 0);
  }
  assert.equal((await translatePreview({ agent: agentFixture().agent, llm: llmFixture(), messageId: '../bad' })).kind, 'error');
});

test('translation preview: finish, empty, output limit, cancellation and changed-target failures do not change history', async () => {
  for (const kind of ['max-tokens', 'empty', 'oversized', 'cancelled', 'changed']) {
    const { agent, events } = agentFixture(); const signal = new AbortController(); const before = JSON.stringify(events);
    const llm = { async *stream() { if (kind === 'cancelled') signal.abort(); if (kind === 'changed') agent.session.surface.nodes = [];
      yield { type: 'text-delta', text: kind === 'empty' ? '' : kind === 'oversized' ? 'a'.repeat(65537) : '訳文' };
      yield { type: 'finish', reason: { kind: kind === 'max-tokens' ? 'max-tokens' : 'stop' } }; } };
    assert.equal((await translatePreview({ agent, llm, messageId: 'answer-1', signal: signal.signal })).kind, 'error'); assert.equal(JSON.stringify(events), before);
  }
});

test('translation preview: maintenance lock rejects a second command even though public status is idle', async () => {
  const { agent } = agentFixture(); let release, calls = 0;
  const llm = { async *stream() { calls++; await new Promise((done) => { release = done; }); yield { type: 'text-delta', text: '訳文' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const first = translatePreview({ agent, llm, messageId: 'answer-1' });
  const second = await translatePreview({ agent, llm, messageId: 'answer-1' }); assert.equal(second.kind, 'error'); assert.equal(calls, 1); release(); assert.equal((await first).kind, 'success');
});

test('translation preview: route prefers the request header and falls back only when no header exists', () => {
  const { agent } = agentFixture(); assert.deepEqual(translationRoute(agent), { provider: 'current', model: 'selected' });
  agent.session.requestHeader = () => undefined; assert.deepEqual(translationRoute(agent), { provider: 'initial', model: 'old' });
  agent.session.requestHeader = () => ({ config: { provider: '', model: '' } }); assert.throws(() => translationRoute(agent));
});

test('translation preview: config authentication precedes method and file access; HEAD has no body', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rdsh-translation-')); const previous = process.env.DSH_HOME; process.env.DSH_HOME = dir;
  // Pin the language so the message assertion does not depend on the host locale.
  const previousLang = process.env.RDSH_LANG; process.env.RDSH_LANG = 'en';
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; if (previousLang === undefined) delete process.env.RDSH_LANG; else process.env.RDSH_LANG = previousLang; await rm(dir, { recursive: true, force: true }); });
  let handler; const ctx = { webServer: { register(route) { handler = route.handler; return () => {}; } }, connection: { requestRejection: (req) => req.rejection } };
  registerConfigApi(ctx);
  async function request(method, rejection) { let status, output, headers; await handler({ method, rejection }, { writeHead(value, fields) { status = value; headers = fields; }, end(value) { output = value; } }); return { status, output: output ? JSON.parse(output) : undefined, headers }; }
  await writeFile(join(dir, 'rdsh.json'), '{broken');
  for (const code of [401, 403]) assert.equal((await request('POST', code)).status, code);
  assert.equal((await request('POST')).status, 405);
  const broken = await request('GET');
  assert.equal(broken.status, 400);
  // 壊れた JSON は「形式が不正」。以前は「読み込めません」と誤報していた。
  assert.equal(broken.output.error, 'The rdsh.json format is invalid');
  await writeFile(join(dir, 'rdsh.json'), JSON.stringify({ translation: { kana_threshold: 0.2 }, secret_field: 'not-returned' }));
  assert.deepEqual((await request('GET')).output, { ok: true, kana_threshold: 0.2 }); assert.equal((await request('HEAD')).output, undefined);
  ctx.connection = undefined; assert.equal((await request('GET')).status, 503);
});

test('translation preview: recommended installation includes web/desktop, excludes headless, and can be disabled', async () => {
  const shell = process.platform === 'win32'
    ? resolve((await executeFile('git', ['--exec-path'], { timeout: 10000 })).stdout.trim(), '../../../bin/sh.exe')
    : 'sh';
  for (const [profile, enabled, expected] of [['web', undefined, true], ['desktop', undefined, true], ['headless', undefined, false], ['web', '0', false]]) {
    const env = { ...process.env, PROFILE: profile, DRY_RUN: '1', SOUND: '0', GITVIEW: '0', RDSH_BIN: process.execPath };
    if (enabled === undefined) delete env.TRANSLATION; else env.TRANSLATION = enabled;
    const { stdout } = await executeFile(shell, [join(root, 'plugins/install.sh')], { cwd: root, env, timeout: 10000 });
    assert.equal(stdout.includes('/plugins/rdsh-translation'), expected, profile);
  }
});

function replaceFixture(text = 'The answer is ready.') {
  const events = [{ seq: 10, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'answer-1', content: [{ type: 'text', text }] } } },
    { seq: 11, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  const surface = { nodes: [10], replaceGeneration: 0, contentGeneration: 0 };
  const appended = [];
  let maintenance = false;
  const agent = { status: 'idle', options: { provider: 'initial', model: 'old' },
    session: { snapshotEvents: () => structuredClone(events), surface, requestHeader: () => ({ config: { provider: 'current', model: 'selected' } }),
      append(type, data, opts) { appended.push({ type, data: structuredClone(data), opts: structuredClone(opts) }); const event = { seq: events.length + 10, type, data, ...opts }; events.push(event); surface.nodes = [...surface.nodes.filter((seq) => seq !== 10), event.seq]; surface.replaceGeneration += 1; return event; },
      deriveMessages: () => structuredClone(events.filter((event) => event.seq !== 10).map((event) => event.data)) },
    async runMaintenance(job) { if (maintenance) throw new Error('busy'); maintenance = true; try { return await job(new AbortController().signal); } finally { maintenance = false; } } };
  return { agent, events, surface, appended };
}

function commandHost(fixture, llm) {
  const commands = new Map();
  const ctx = { llm, commands: { register(value) { commands.set(value.name, value); return () => {}; } }, effect: (fn) => fn(), inject: () => ({ dispose: async () => {} }) };
  apply(ctx);
  return { commands, execute: async (sessionId, line, attachments) => {
    const [name, id] = line.replace(/^\//u, '').split(' ');
    return { ok: true, value: { result: await commands.get(name).handler({ agent: fixture.agent, rawInput: id, signal: new AbortController().signal }) } };
  } };
}

const replaceButton = (view) => find(view, (node) => node.props['data-testid'] === 'rdsh-translate-replace');

test('translation replace: the action calls ja-replace and appends one exact surface replacement', async () => {
  const fixture = replaceFixture();
  const llm = llmFixture();
  const ui = uiHost(commandHost(fixture, llm).execute);
  ui.render(); await ui.settle();
  assert.match(textOf(replaceButton(ui.render())), /日本語訳で置き換える/);
  await replaceButton(ui.render()).props.onClick();
  assert.equal(fixture.appended.length, 1, 'the replace action must append exactly one event');
  const [appended] = fixture.appended;
  assert.equal(appended.type, 'user/message');
  assert.equal(appended.data.role, 'user');
  assert.deepEqual(appended.data.content, [{ type: 'text', text: '回答の準備ができました。' }]);
  assert.equal(appended.data.source.kind, 'rdsh-translation');
  assert.equal(typeof appended.data.id, 'string');
  assert.deepEqual(appended.opts.surfaceOp, { op: 'replace', startSeq: 10, endSeq: 10 });
  assert.deepEqual(appended.opts.sourceEventSeqs, [10]);
  assert.deepEqual(fixture.surface.nodes, [12]);
  assert.equal(JSON.stringify(fixture.agent.session.deriveMessages()).includes('The answer is ready.'), false, 'the model-visible history must no longer carry the original');
  assert.equal(JSON.stringify(fixture.agent.session.deriveMessages()).includes('回答の準備ができました。'), true);
  assert.match(textOf(ui.render()), /次のモデル要求/);
  assert.match(textOf(replaceButton(ui.render())), /履歴を置き換えました/);
  assert.equal(replaceButton(ui.render()).props.disabled, true);
  ui.dispose();
});

test('translation replace: only an explicit click replaces history; the preview stays display-only', async () => {
  const fixture = replaceFixture();
  const ui = uiHost(commandHost(fixture, llmFixture()).execute);
  ui.render(); await ui.settle();
  const before = JSON.stringify(fixture.agent.session.deriveMessages());
  await button(ui.render()).props.onClick();
  assert.equal(fixture.appended.length, 0, 'the display action must never touch the session');
  assert.match(textOf(ui.render()), /原文と会話履歴は変更していません/);
  assert.equal(JSON.stringify(fixture.agent.session.deriveMessages()), before);
  ui.dispose();
});

test('translation replace: busy, missing, lost literals and a rejecting session never append', async () => {
  const cases = [];
  const busy = replaceFixture(); busy.agent.status = 'running'; cases.push(['busy', busy, llmFixture(), /回答の生成が完了してから/]);
  const missing = replaceFixture(); missing.events[0].data.message.id = 'other'; cases.push(['missing', missing, llmFixture(), /確認できません/]);
  const lost = replaceFixture('Use file_name now.'); cases.push(['lost', lost, llmFixture(() => '訳文'), /コード・識別子・パス/]);
  const refusing = replaceFixture(); refusing.agent.session.append = () => { throw new Error('session refused'); }; cases.push(['refusing', refusing, llmFixture(), /置き換えられませんでした/]);
  for (const [name, fixture, llm, expected] of cases) {
    const result = await replaceTranslation({ agent: fixture.agent, llm, messageId: 'answer-1' });
    assert.equal(result.kind, 'error', name);
    assert.match(result.text, expected, name);
    assert.equal(fixture.appended.length, 0, name);
  }
});

test('translation replace: an already replaced answer reports its own error instead of a silent miss', async () => {
  const fixture = replaceFixture();
  fixture.events.push({ seq: 12, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 10, endSeq: 10 }, sourceEventSeqs: [10], data: { id: 'r1', role: 'user', content: [{ type: 'text', text: '回答の準備ができました。' }], source: { kind: 'rdsh-translation' } } });
  fixture.surface.nodes = [12];
  const result = await replaceTranslation({ agent: fixture.agent, llm: llmFixture(), messageId: 'answer-1' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /すでに日本語訳へ置き換えられています/u);
  assert.equal(fixture.appended.length, 0);
});

test('translation replace: Japanese answers expose no replacement action', async () => {
  const ui = uiHost(() => assert.fail('no call'), { data: chatData('これは日本語の回答です。') });
  ui.render(); await ui.settle();
  assert.equal(ui.render(), null);
  ui.dispose();
});
