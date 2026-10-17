import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { normalizeKanaThreshold, protectLiterals, restoreLiterals, buildTranslationPrompt } from './translation-core.js';

export const inject = ['commands', 'llm'];
const MAX_BYTES = 64 * 1024;
// 置換ノードはcompactionのcheckpointと同じくuser/messageでしか追加できない
// （assistant/messageは開いているstepを要求する）。専用のsource.kindで
// compact-checkpointと区別し、表示側が置換と判定できるようにする。
const REPLACEMENT_SOURCE = 'rdsh-translation';
class PreviewError extends Error {}

// 読み手向けの文言はこのカタログだけが持つ。モデルへの翻訳指示と保護トークンは
// 言語に依存しないため、ここには含めない。
const MESSAGES = Object.freeze({
  'settings.malformed': { en: 'The rdsh.json format is invalid', zh: 'rdsh.json 的格式无效', ja: 'rdsh.jsonの形式を確認してください' },
  'settings.unreadable': { en: 'Could not read rdsh.json', zh: '无法读取 rdsh.json', ja: 'rdsh.jsonを読み込めません' },
  'answer.id': { en: 'The target answer id is invalid', zh: '目标回答的 ID 无效', ja: '対象回答のIDが不正です' },
  'answer.missing': { en: 'The target answer is outside the current conversation', zh: '无法在当前会话中确认目标回答', ja: '対象回答を現在の会話から確認できません' },
  'answer.unfinished': { en: 'Only a completed answer can be translated', zh: '只能翻译已完成的回答', ja: '完了した回答だけを翻訳できます' },
  'answer.attachments': { en: 'An answer with an image, attachment or tool call cannot be translated', zh: '包含图片、附件或工具调用的回答无法翻译', ja: '画像・添付・tool callを含む回答は翻訳できません' },
  'answer.empty': { en: 'The target answer has no text to translate', zh: '目标回答没有可翻译的文本', ja: '対象回答に翻訳できるテキストがありません' },
  'answer.oversized': { en: 'The answer is too long to translate', zh: '回答过长，无法翻译', ja: '回答が長すぎるため翻訳できません' },
  'route.unknown': { en: 'The current model is unavailable', zh: '无法获取当前模型', ja: '現在のモデルを取得できません' },
  'agent.busy': { en: 'Translate only after the answer has finished generating', zh: '请在回答生成结束后再翻译', ja: '回答の生成が完了してから翻訳してください' },
  'result.shape': { en: 'The translation result has an unexpected shape', zh: '翻译结果的格式无法确认', ja: '和訳結果の形式を確認できません' },
  'result.oversized': { en: 'The translation is too long; display was stopped', zh: '翻译结果过长，已停止显示', ja: '和訳結果が長すぎるため表示を中止しました' },
  'result.incomplete': { en: 'The translation did not finish. Try again.', zh: '翻译未能正常完成。请重试。', ja: '和訳が正常に完了しませんでした。再試行してください' },
  'answer.changed': { en: 'The target answer changed. Try again.', zh: '目标回答已更改。请重试。', ja: '対象回答が変わりました。再試行してください' },
  'literals.lost': { en: 'The translation lost code, identifiers or paths; display was stopped', zh: '翻译未能保留代码、标识符或路径，已停止显示', ja: '和訳でコード・識別子・パスを保持できなかったため表示を中止しました' },
  'translation.failed': { en: 'The translation could not finish. Check the running work and try again.', zh: '无法完成翻译。请确认正在运行的作业后重试。', ja: '和訳を完了できませんでした。実行中の処理を確認して再試行してください' },
  'config.read': { en: 'Check rdsh.json', zh: '请检查 rdsh.json', ja: 'rdsh.jsonを確認してください' },
  'auth.unavailable': { en: 'Could not confirm authentication', zh: '无法确认认证', ja: '認証を確認できません' },
  'method.unavailable': { en: 'This operation is not available', zh: '此操作不可用', ja: 'この操作は利用できません' },
  'answer.replaced': { en: 'This answer was already replaced by its Japanese translation', zh: '此回答已替换为日文翻译', ja: 'この回答はすでに日本語訳へ置き換えられています' },
  'replace.failed': { en: 'The answer could not be replaced in the conversation history', zh: '无法在会话历史中替换回答', ja: '回答を会話履歴上で置き換えられませんでした' },
  'command.description': { en: 'Show a Japanese translation of the answer (the conversation history is unchanged)', zh: '显示回答的日文翻译（不更改会话历史）', ja: '回答の日本語訳を表示します（会話履歴は変更しません）' },
  'command.replace': { en: 'Replace the answer with its Japanese translation in the conversation history', zh: '在会话历史中用日文翻译替换回答', ja: '回答を日本語訳で会話履歴上に置き換えます' },
});
function message(language, key) { return MESSAGES[key][language] ?? MESSAGES[key].en; }
const reject = (language, key) => { throw new PreviewError(message(language, key)); };

/** Resolve owned copy from the launcher preference, saved settings, or the OS locale. */
export function translationLanguage(env = process.env) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(join(env.DSH_HOME || join(homedir(), '.dsh'), 'rdsh.json'), 'utf8'))?.general?.language;
  } catch { /* Missing or malformed settings keep the environment preference. */ }
  const value = env.RDSH_LANG?.trim() || (typeof saved === 'string' && saved !== 'auto' ? saved.trim() : '') ||
    [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((item) => item?.trim()) || Intl.DateTimeFormat().resolvedOptions().locale;
  const language = String(value).toLowerCase();
  return language.startsWith('ja') ? 'ja' : language.startsWith('zh') ? 'zh' : 'en';
}

export async function readSettings(language = translationLanguage()) {
  try {
    const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'rdsh.json');
    const doc = JSON.parse(await readFile(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) reject(language, 'settings.malformed');
    return { kanaThreshold: normalizeKanaThreshold(doc.translation?.kana_threshold) };
  } catch (error) {
    if (error.code === 'ENOENT') return { kanaThreshold: normalizeKanaThreshold() };
    if (error instanceof PreviewError) throw error;
    // 構文エラーは「読めなかった」ではなく「形式が不正」。専用の文言が
    // 用意されているのに到達できていなかった。
    if (error instanceof SyntaxError) reject(language, 'settings.malformed');
    reject(language, 'settings.unreadable');
  }
}

/** Whether one earlier replacement already shadowed this surface node. */
function isReplaced(events, seq) {
  return events.some((item) => item.type === 'user/message' && item.surfaceOp !== undefined && item.surfaceOp !== 'append'
    && Array.isArray(item.sourceEventSeqs) && item.sourceEventSeqs.includes(seq));
}

export function findAnswer(agent, messageId, language = translationLanguage()) {
  if (typeof messageId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(messageId)) reject(language, 'answer.id');
  const events = agent.session.snapshotEvents();
  const event = events.find((item) => item.type === 'assistant/message' && item.data?.message?.id === messageId);
  if (!event) reject(language, 'answer.missing');
  if (!agent.session.surface.nodes.includes(event.seq)) reject(language, isReplaced(events, event.seq) ? 'answer.replaced' : 'answer.missing');
  if (event.data.interrupted) reject(language, 'answer.missing');
  if (!events.some((item) => item.type === 'turn/end' && item.data?.turn === event.data.turn && item.data?.reason?.kind === 'completed')) {
    reject(language, 'answer.unfinished');
  }
  const blocks = event.data.message.content;
  if (!Array.isArray(blocks) || blocks.some((block) => !block || !['text', 'reasoning'].includes(block.type) || block.type === 'text' && typeof block.text !== 'string')) {
    reject(language, 'answer.attachments');
  }
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  if (!text.trim()) reject(language, 'answer.empty');
  if (Buffer.byteLength(text) > MAX_BYTES) reject(language, 'answer.oversized');
  return { seq: event.seq, text };
}

export function translationRoute(agent, language = translationLanguage()) {
  const config = agent.session.requestHeader()?.config || agent.options;
  const provider = config?.provider;
  const model = config?.model;
  if (typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()) reject(language, 'route.unknown');
  return { provider, model };
}

/**
 * Run one independent translation of the target answer. Must be called inside
 * `agent.runMaintenance`; returns the validated target and the restored text.
 */
async function translateTarget({ agent, llm, messageId, signal, agentSignal, timeoutMs, language }) {
  const target = findAnswer(agent, messageId, language);
  const route = translationRoute(agent, language);
  const input = protectLiterals(target.text);
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, agentSignal, controller.signal].filter(Boolean));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    combined.throwIfAborted();
    let text = '';
    let finish;
    for await (const chunk of llm.stream({ ...route, messages: [{ role: 'user', content: [{ type: 'text', text: buildTranslationPrompt(input.masked, input.literals) }] }], temperature: 0, maxTokens: 8192, signal: combined })) {
      combined.throwIfAborted();
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text !== 'string') reject(language, 'result.shape');
        text += chunk.text;
        if (Buffer.byteLength(text) > MAX_BYTES) reject(language, 'result.oversized');
      }
      if (chunk.type === 'finish') finish = chunk.reason;
    }
    combined.throwIfAborted();
    if (finish?.kind !== 'stop' || !text.trim()) reject(language, 'result.incomplete');
    const current = findAnswer(agent, messageId, language);
    if (current.seq !== target.seq || current.text !== target.text) reject(language, 'answer.changed');
    try { return { target, text: restoreLiterals(text, input.literals) }; }
    catch { reject(language, 'literals.lost'); }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Admit translation work only while the agent is idle, then report failures. */
async function runTranslation({ agent, language, job }) {
  if (agent.status !== 'idle') return { kind: 'error', text: message(language, 'agent.busy') };
  try {
    return await agent.runMaintenance(job);
  } catch (error) {
    return { kind: 'error', text: error instanceof PreviewError ? error.message : message(language, 'translation.failed') };
  }
}

export async function translatePreview({ agent, llm, messageId, signal, timeoutMs = 60000, language = translationLanguage() }) {
  return runTranslation({ agent, language, job: async (agentSignal) => {
    const { text } = await translateTarget({ agent, llm, messageId, signal, agentSignal, timeoutMs, language });
    return { kind: 'success', text };
  } });
}

/**
 * Replace the target answer on the model-visible surface with its Japanese
 * translation, without adding a turn or a follow-up user request. The original
 * record stays in the append-only log and in the human transcript.
 */
export async function replaceTranslation({ agent, llm, messageId, signal, timeoutMs = 60000, language = translationLanguage() }) {
  return runTranslation({ agent, language, job: async (agentSignal) => {
    const { target, text } = await translateTarget({ agent, llm, messageId, signal, agentSignal, timeoutMs, language });
    let event;
    try {
      event = agent.session.append('user/message', {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: REPLACEMENT_SOURCE },
      }, { surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq }, sourceEventSeqs: [target.seq] });
    } catch { reject(language, 'replace.failed'); }
    return { kind: 'success', text, replacedSeq: target.seq, replacementSeq: event.seq };
  } });
}

function json(req, res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function registerConfigApi(ctx) {
  const language = translationLanguage();
  return ctx.webServer.register({ kind: 'exact', path: '/api/rdsh-translation/config', handler: async (req, res) => {
    let rejection = 503;
    try { if (typeof ctx.connection?.requestRejection === 'function') rejection = ctx.connection.requestRejection(req); } catch { /* 認証サービス異常時も拒否する */ }
    if (rejection !== undefined) return json(req, res, [401, 403].includes(rejection) ? rejection : 503, { ok: false, error: message(language, 'auth.unavailable') });
    if (!['GET', 'HEAD'].includes(req.method)) return json(req, res, 405, { ok: false, error: message(language, 'method.unavailable') });
    try { const settings = await readSettings(language); json(req, res, 200, { ok: true, kana_threshold: settings.kanaThreshold }); }
    catch (error) { json(req, res, 400, { ok: false, error: error instanceof PreviewError ? error.message : message(language, 'config.read') }); }
  } });
}

export function apply(ctx) {
  const language = translationLanguage();
  return ctx.effect(() => {
    const offPreview = ctx.commands.register({ name: 'ja-preview', description: message(language, 'command.description'), recordInput: false,
      handler: ({ agent, rawInput, signal }) => translatePreview({ agent, llm: ctx.llm, messageId: rawInput.trim(), signal, language }) });
    const offReplace = ctx.commands.register({ name: 'ja-replace', description: message(language, 'command.replace'), recordInput: false,
      handler: ({ agent, rawInput, signal }) => replaceTranslation({ agent, llm: ctx.llm, messageId: rawInput.trim(), signal, language }) });
    const web = ctx.inject(['webServer', 'connection'], registerConfigApi);
    return async () => { offPreview(); offReplace(); await web.dispose(); };
  });
}
