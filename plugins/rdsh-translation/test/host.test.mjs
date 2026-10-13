import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply as applyTranslation, findVisibleAnswer, readSettings, streamTranslation, translateAndReplace, translationRoute } from '../index.js';

function fixture({ status = 'idle', text = 'A concise answer.' } = {}) {
  const events = [{
    seq: 7,
    type: 'assistant/message',
    data: { turn: 2, step: 1, message: { id: 'answer-7', content: [{ type: 'text', text }] } },
  }];
  const appends = [];
  const session = {
    surface: { nodes: [7] },
    snapshotEvents: () => [...events],
    append(type, data, options) {
      appends.push({ type, data, options });
      const event = { seq: 8, type, data, ...options };
      events.push(event);
      this.surface.nodes = [8];
      return event;
    },
  };
  const agent = {
    status,
    options: { provider: 'current-provider', model: 'current-model' },
    session,
    runMaintenance(task) {
      return task(new AbortController().signal);
    },
  };
  return { agent, appends, events };
}

test('one standalone auxiliary request replaces only the selected surface answer', async () => {
  const state = fixture();
  let calls = 0;
  const llm = {
    async *stream(options) {
      calls += 1;
      assert.equal(options.provider, 'current-provider');
      assert.equal(options.model, 'current-model');
      assert.equal(options.messages.length, 1);
      assert.equal(options.messages[0].role, 'user');
      assert.equal(options.sessionId, undefined);
      yield { type: 'text-delta', text: '日本語の回答です。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const result = await translateAndReplace({ agent: state.agent, llm, messageId: 'answer-7', settings: { provider: '', model: '' } });
  assert.deepEqual(result, { kind: 'success', text: '和訳に置き換えました', sourceEventSeq: 8 });
  assert.equal(calls, 1);
  assert.equal(state.appends.length, 1);
  assert.equal(state.appends[0].type, 'user/message');
  assert.deepEqual(state.appends[0].options, {
    surfaceOp: { op: 'replace', startSeq: 7, endSeq: 7 },
    sourceEventSeqs: [7],
  });
  assert.equal(state.appends[0].data.content[0].text, '日本語の回答です。');
  assert.equal(state.appends[0].data.source.kind, 'compact-checkpoint');
  assert.equal(state.appends[0].data.source.originalMessageId, 'answer-7');
  assert.equal(state.events.filter((event) => event.type === 'turn/start' || event.type === 'user/message').length, 1);
});

test('a running or already-shadowed answer fails before any auxiliary request', async () => {
  const state = fixture({ status: 'running' });
  let calls = 0;
  const llm = { async *stream() { calls += 1; } };
  const busy = await translateAndReplace({ agent: state.agent, llm, messageId: 'answer-7', settings: { provider: '', model: '' } });
  assert.equal(busy.kind, 'error');
  assert.match(busy.text, /実行中/u);
  assert.equal(calls, 0);
  assert.equal(state.appends.length, 0);

  state.agent.status = 'idle';
  state.agent.session.surface.nodes = [];
  assert.throws(() => findVisibleAnswer(state.agent, 'answer-7'), /surface/u);
});

test('fenced code survives translation byte-for-byte and non-stop finishes do not settle', async () => {
  const code = 'Here is the code:\n```js\nconst target = path;\n```';
  const llm = {
    async *stream(options) {
      const prompt = options.messages[0].content[0].text;
      const token = prompt.match(/__RDSH_KEEP_[a-f0-9]+_0__/u)?.[0];
      assert.ok(token);
      yield { type: 'text-delta', text: `コードです。\n${token}` };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const translated = await streamTranslation(llm, { provider: 'p', model: 'm' }, code);
  assert.match(translated, /```js\nconst target = path;\n```/u);

  const incomplete = {
    async *stream() {
      yield { type: 'text-delta', text: '途中' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    },
  };
  await assert.rejects(streamTranslation(incomplete, { provider: 'p', model: 'm' }, 'English answer.'), /途中で切らず/u);
});

test('an incomplete translation leaves the original surface untouched', async () => {
  const state = fixture();
  const llm = {
    async *stream() {
      yield { type: 'text-delta', text: '途中まで' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    },
  };
  const result = await translateAndReplace({ agent: state.agent, llm, messageId: 'answer-7', settings: { provider: '', model: '' } });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /途中で切らず/u);
  assert.equal(state.appends.length, 0);
  assert.deepEqual(state.agent.session.surface.nodes, [7]);
  assert.equal(state.events.length, 1);
});

test('rdsh.json controls the kana threshold and requires an atomic optional route', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rdsh-translation-settings-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'rdsh.json'), JSON.stringify({ translation: { kana_threshold: 0.23, provider: 'cheap-provider', model: 'cheap-model' } }));
  const settings = await readSettings();
  assert.deepEqual(settings, { kanaThreshold: 0.23, provider: 'cheap-provider', model: 'cheap-model' });
  assert.deepEqual(translationRoute({ options: { provider: 'current', model: 'route' } }, settings), { provider: 'cheap-provider', model: 'cheap-model' });
  assert.deepEqual(translationRoute({ options: { provider: 'current', model: 'route' } }, { provider: '', model: '' }), { provider: 'current', model: 'route' });
  assert.throws(() => translationRoute({ options: { provider: 'current', model: 'route' } }, { provider: 'cheap-provider', model: '' }), /両方/u);
});

test('the config endpoint rejects unauthenticated requests and exposes only the threshold', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rdsh-translation-api-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'rdsh.json'), JSON.stringify({ translation: { kana_threshold: 0.31, provider: 'private-provider', model: 'private-model' } }));

  let rejection;
  let route;
  const ctx = {
    commands: { register() { return () => {}; } },
    effect(setup) { return setup(); },
    inject(_services, setup) {
      const dispose = setup({
        connection: { requestRejection: () => rejection },
        webServer: { register(definition) { route = definition; return () => {}; } },
      });
      return { dispose: async () => { await dispose?.(); } };
    },
  };
  const dispose = applyTranslation(ctx);
  const request = async (method = 'GET') => {
    let status;
    let body = '';
    await route.handler({ method }, {
      writeHead(value) { status = value; },
      end(value = '') { body = value; },
    });
    return { status, body: body ? JSON.parse(body) : null };
  };

  rejection = 401;
  assert.deepEqual(await request(), { status: 401, body: { ok: false, error: 'unauthorized' } });
  rejection = undefined;
  assert.deepEqual(await request(), { status: 200, body: { ok: true, kana_threshold: 0.31 } });
  assert.deepEqual(await request('POST'), { status: 405, body: { ok: false, error: 'method-not-allowed' } });
  await dispose();
});
