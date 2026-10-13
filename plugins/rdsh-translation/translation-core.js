import { randomBytes } from 'node:crypto';

export const DEFAULT_KANA_THRESHOLD = 0.08;
export const MIN_KANA_THRESHOLD = 0.01;
export const MAX_KANA_THRESHOLD = 0.5;
export const TRANSLATION_SOURCE_KIND = 'compact-checkpoint';

const KANA = /^[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9d]$/u;
const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;

export function normalizeKanaThreshold(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_KANA_THRESHOLD;
  return Math.min(MAX_KANA_THRESHOLD, Math.max(MIN_KANA_THRESHOLD, value));
}

export function textBlocksContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function stripFencedCode(value) {
  const lines = String(value ?? '').match(/[^\n]*(?:\n|$)/gu) ?? [];
  const visible = [];
  let openFence;
  for (const line of lines) {
    const opening = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/u)?.[1];
    if (!openFence) {
      if (opening) openFence = { char: opening[0], length: opening.length };
      else if (line) visible.push(line);
      continue;
    }
    const closing = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(?:\n|$)/u)?.[1];
    if (closing && closing[0] === openFence.char && closing.length >= openFence.length) openFence = undefined;
  }
  return visible.join('');
}

export function kanaRatio(content) {
  const text = stripFencedCode(textBlocksContent(content));
  let kana = 0;
  let lexical = 0;
  for (const character of text) {
    if (LETTER_OR_NUMBER.test(character)) lexical += 1;
    if (KANA.test(character)) kana += 1;
  }
  return { kana, lexical, ratio: lexical === 0 ? 0 : kana / lexical };
}

export function shouldOfferTranslation(content, threshold = DEFAULT_KANA_THRESHOLD) {
  const score = kanaRatio(content);
  return score.lexical > 0 && score.ratio < normalizeKanaThreshold(threshold);
}

export function isFinalTranslatableAssistant(data, messageId, threshold = DEFAULT_KANA_THRESHOLD) {
  const finalNode = data?.finalNode;
  if (data?.status !== 'settled' || !finalNode || finalNode.messageId !== messageId) return false;
  if (finalNode.interrupted === true || finalNode.blocks?.some((block) => !['text', 'reasoning'].includes(block?.type))) return false;
  return shouldOfferTranslation(finalNode.blocks, threshold);
}

export function protectLiterals(input, nonce = randomBytes(8).toString('hex')) {
  const source = String(input ?? '');
  const spans = [];
  const lines = source.match(/[^\n]*(?:\n|$)/gu) ?? [];
  let offset = 0;
  let open;
  for (const line of lines) {
    const fence = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/u)?.[1];
    if (!open && fence) open = { start: offset, char: fence[0], length: fence.length };
    else if (open) {
      const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(?:\n|$)/u)?.[1];
      if (close && close[0] === open.char && close.length >= open.length) {
        spans.push({ start: open.start, end: offset + line.length });
        open = undefined;
      }
    }
    offset += line.length;
  }
  if (open) spans.push({ start: open.start, end: source.length });
  const patterns = [
    /``[^`\n]+``|`[^`\n]+`|https?:\/\/[^\s<>]+|(?<![\w./\\])--?[A-Za-z][\w-]*(?![\w./\\])|\b[A-Za-z_][A-Za-z0-9_]*(?:_[A-Za-z0-9_]+|[A-Z][A-Za-z0-9_]*)+\b/gu,
    /\b[A-Za-z]:[\\/][^\s<>"']+/gu,
    /\\\\[\w.$-]+\\[\w.$-]+(?:\\[\w.$-]+)*/gu,
    /(?<![\w.])\/(?:[\w.$-]+\/)*[\w.$-]+/gu,
    /(?<![\w.])(?:\.\.?[\\/](?:[\w.$-]+[\\/])*[\w.$-]+(?:\.[\w-]+)?|(?:[\w.$-]+[\\/])+[\w.$-]+(?:\.[\w-]+)?)/gu,
    /\b[\w./\\-]+\.(?:rs|js|mjs|ts|json|toml|yaml|yml|md|sh|ps1|py|exe)\b/gu,
  ];
  for (const match of patterns.flatMap((pattern) => [...source.matchAll(pattern)])) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const literals = [];
  let masked = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor || span.end <= span.start) continue;
    const value = source.slice(span.start, span.end);
    if (!value) continue;
    const token = `__RDSH_KEEP_${nonce}_${literals.length}__`;
    masked += source.slice(cursor, span.start) + token;
    literals.push({ token, value });
    cursor = span.end;
  }
  masked += source.slice(cursor);
  return { masked, literals };
}

export function restoreLiterals(translated, literals) {
  let result = String(translated ?? '');
  for (const { token, value } of literals) {
    const first = result.indexOf(token);
    if (first < 0 || result.indexOf(token, first + token.length) >= 0) {
      throw new Error('翻訳結果でコード・識別子・パスの保護情報を確認できません');
    }
    result = result.slice(0, first) + value + result.slice(first + token.length);
  }
  return result;
}

export function buildTranslationPrompt(text, literals = []) {
  const protection = literals.length
    ? `\n保護トークンはすべて一度だけ、綴りを変えずに出力へ残してください: ${literals.map((item) => item.token).join(' ')}`
    : '';
  return `次の回答文だけを自然な日本語に翻訳してください。要約、説明、前置き、追指示は追加せず、翻訳文だけを返してください。文の意味とMarkdownの段落構造を保ってください。\n${protection}\n\n--- 翻訳対象 ---\n${text}`;
}

export function translationReplacementSource(messageId, originalContent, originalLocation = {}) {
  return {
    kind: TRANSLATION_SOURCE_KIND,
    rdshTranslation: true,
    originalMessageId: messageId,
    originalText: textBlocksContent(originalContent),
    ...(Number.isSafeInteger(originalLocation.turn) ? { originalTurn: originalLocation.turn } : {}),
    ...(Number.isSafeInteger(originalLocation.step) ? { originalStep: originalLocation.step } : {}),
  };
}
