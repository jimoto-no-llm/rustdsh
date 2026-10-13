import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  buildTranslationPrompt,
  normalizeKanaThreshold,
  protectLiterals,
  restoreLiterals,
  translationReplacementSource,
} from './translation-core.js';

export const inject = ['commands', 'llm'];

const settingsPath = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'rdsh.json');
const nonempty = (value) => typeof value === 'string' ? value.trim() : '';

export async function readSettings() {
  let settings;
  try {
    settings = JSON.parse(await readFile(settingsPath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') settings = {};
    else throw new Error('rdsh.jsonを読み込めません');
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('rdsh.jsonを読み込めません');
  const translation = settings.translation && typeof settings.translation === 'object' && !Array.isArray(settings.translation)
    ? settings.translation : {};
  return {
    kanaThreshold: normalizeKanaThreshold(translation.kana_threshold),
    provider: nonempty(translation.provider),
    model: nonempty(translation.model),
  };
}

export function translationRoute(agent, settings) {
  const provider = settings.provider;
  const model = settings.model;
  if (!!provider !== !!model) throw new Error('和訳用providerとmodelは両方設定してください');
  if (provider && model) {
    if (provider.length > 128 || model.length > 128 || /[\r\n]/u.test(provider + model)) throw new Error('和訳用provider/modelの設定を確認してください');
    return { provider, model };
  }
  const route = { provider: nonempty(agent.options?.provider), model: nonempty(agent.options?.model) };
  if (!route.provider || !route.model) throw new Error('現在のprovider/modelを取得できません');
  return route;
}

export function findVisibleAnswer(agent, messageId) {
  if (typeof messageId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(messageId)) {
    throw new Error('対象回答のIDが不正です');
  }
  const event = agent.session.snapshotEvents().find((candidate) => candidate.type === 'assistant/message' && candidate.data?.message?.id === messageId);
  if (!event) throw new Error('対象回答をsession logから見つけられません');
  if (event.data.interrupted === true) throw new Error('中断された回答は置き換えられません');
  if (!agent.session.surface.nodes.includes(event.seq)) throw new Error('対象回答は現在の履歴surfaceにありません。/compact済みか確認してください');
  const content = event.data.message?.content;
  if (!Array.isArray(content) || content.length === 0 || content.some((block) => !['text', 'reasoning'].includes(block?.type) || block.type === 'text' && typeof block.text !== 'string')) {
    throw new Error('画像・添付・tool callを含む回答はこの操作で置き換えられません');
  }
  const originalText = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  if (!originalText.trim()) throw new Error('対象回答に翻訳できるテキストがありません');
  return { event, message: event.data.message, originalText };
}

export async function streamTranslation(llm, route, originalText, signal) {
  const protectedInput = protectLiterals(originalText);
  const prompt = buildTranslationPrompt(protectedInput.masked, protectedInput.literals);
  let output = '';
  let finish;
  for await (const chunk of llm.stream({
    ...route,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature: 0,
    maxTokens: 8192,
    signal,
  })) {
    if (chunk.type === 'text-delta') output += chunk.text;
    if (chunk.type === 'finish') finish = chunk.reason;
  }
  if (finish?.kind !== 'stop') {
    const reason = finish?.kind === 'max-tokens' ? '和訳が長すぎるため、途中で切らずに中止しました' : '和訳モデルが正常に完了しませんでした';
    throw new Error(reason);
  }
  if (!output.trim()) throw new Error('和訳結果が空でした');
  return restoreLiterals(output, protectedInput.literals);
}

export async function translateAndReplace({ agent, llm, messageId, settings, signal }) {
  if (agent.status !== 'idle') return { kind: 'error', text: 'agentが実行中です。完了してから再試行してください' };
  try {
    return await agent.runMaintenance(async (agentSignal) => {
      const target = findVisibleAnswer(agent, messageId);
      const route = translationRoute(agent, settings);
      const controller = new AbortController();
      const relay = (source) => { if (!controller.signal.aborted) controller.abort(source.reason); };
      const abortFromInvocation = () => relay(signal);
      const abortFromAgent = () => relay(agentSignal);
      if (signal?.aborted) abortFromInvocation();
      if (agentSignal.aborted) abortFromAgent();
      signal?.addEventListener('abort', abortFromInvocation, { once: true });
      agentSignal.addEventListener('abort', abortFromAgent, { once: true });
      let translated;
      try {
        translated = await streamTranslation(llm, route, target.originalText, controller.signal);
      } finally {
        signal?.removeEventListener('abort', abortFromInvocation);
        agentSignal.removeEventListener('abort', abortFromAgent);
      }
      const current = findVisibleAnswer(agent, messageId);
      if (current.event.seq !== target.event.seq) throw new Error('対象回答が処理中に変わりました。置き換えを中止しました');
      const replacement = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: translated }],
        source: translationReplacementSource(messageId, target.message.content, {
          turn: target.event.data.turn,
          step: target.event.data.step,
        }),
      };
      const seq = agent.session.append('user/message', replacement, {
        surfaceOp: { op: 'replace', startSeq: target.event.seq, endSeq: target.event.seq },
        sourceEventSeqs: [target.event.seq],
      });
      return { kind: 'success', text: '和訳に置き換えました', sourceEventSeq: seq.seq };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '和訳に失敗しました';
    if (agent.status !== 'idle') return { kind: 'error', text: 'agentが実行中です。完了してから再試行してください' };
    return { kind: 'error', text: message };
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function authorized(ctx, req, res) {
  const status = typeof ctx.connection?.requestRejection === 'function' ? ctx.connection.requestRejection(req) : 503;
  if (status === undefined) return true;
  json(res, status, { ok: false, error: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'authentication-unavailable' });
  return false;
}

function registerConfigApi(ctx) {
  return ctx.webServer.register({
    kind: 'exact',
    path: '/api/rdsh-translation/config',
    handler: async (req, res) => {
      if (!authorized(ctx, req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method-not-allowed' });
      try {
        const settings = await readSettings();
        json(res, 200, { ok: true, kana_threshold: settings.kanaThreshold });
      } catch { json(res, 400, { ok: false, error: 'invalid-settings' }); }
    },
  });
}

export function apply(ctx) {
  return ctx.effect(() => {
    const offCommand = ctx.commands.register({
      name: 'ja',
      description: '現在の回答を日本語へ翻訳し、履歴上で置き換えます',
      recordInput: false,
      handler: async ({ agent, rawInput, signal }) => {
        if (agent.status !== 'idle') return { kind: 'error', text: 'agentが実行中です。完了してから再試行してください' };
        let settings;
        try { settings = await readSettings(); }
        catch (error) { return { kind: 'error', text: error.message }; }
        return translateAndReplace({ agent, llm: ctx.llm, messageId: rawInput.trim(), settings, signal });
      },
    });
    const web = ctx.inject(['webServer', 'connection'], (webCtx) => registerConfigApi(webCtx));
    return async () => { offCommand?.(); await web.dispose(); };
  });
}
