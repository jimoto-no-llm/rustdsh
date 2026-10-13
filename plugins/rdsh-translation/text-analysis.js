export const DEFAULT_KANA_THRESHOLD = 0.08;
export const MIN_KANA_THRESHOLD = 0.01;
export const MAX_KANA_THRESHOLD = 0.5;

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
      if (opening) {
        openFence = { char: opening[0], length: opening.length };
      } else if (line) {
        visible.push(line);
      }
      continue;
    }

    const closing = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(?:\n|$)/u)?.[1];
    if (closing && closing[0] === openFence.char && closing.length >= openFence.length) {
      openFence = undefined;
    }
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

  return {
    kana,
    lexical,
    ratio: lexical === 0 ? 0 : kana / lexical,
  };
}

export function shouldOfferTranslation(content, threshold = DEFAULT_KANA_THRESHOLD) {
  const score = kanaRatio(content);
  return score.lexical > 0 && score.ratio < normalizeKanaThreshold(threshold);
}
