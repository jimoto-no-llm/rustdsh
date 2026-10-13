import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_KANA_THRESHOLD,
  kanaRatio,
  normalizeKanaThreshold,
  shouldOfferTranslation,
  stripFencedCode,
  textBlocksContent,
} from '../text-analysis.js';

test('English and Chinese answers without kana are eligible', () => {
  assert.equal(shouldOfferTranslation([{ type: 'text', text: 'A concise English answer.' }]), true);
  assert.equal(shouldOfferTranslation([{ type: 'text', text: '这是一个中文回答。' }]), true);
});

test('ordinary Japanese prose is not eligible at the default threshold', () => {
  const content = [{ type: 'text', text: '今日は天気がよく、散歩に出かけました。' }];
  assert.ok(kanaRatio(content).ratio > DEFAULT_KANA_THRESHOLD);
  assert.equal(shouldOfferTranslation(content), false);
});

test('only visible text blocks are scored', () => {
  const content = [
    { type: 'image', alt: '日本語の画像説明' },
    { type: 'text', text: 'Good morning.' },
    { type: 'text', text: 'How can I help?' },
  ];
  assert.equal(textBlocksContent(content), 'Good morning.\nHow can I help?');
  assert.equal(shouldOfferTranslation(content), true);
});

test('fenced code does not affect kana detection', () => {
  const content = [{
    type: 'text',
    text: 'The output is ready.\n```js\nconst result = "日本語です";\n```',
  }];
  assert.equal(stripFencedCode(content[0].text), 'The output is ready.\n');
  assert.equal(kanaRatio(content).ratio, 0);
  assert.equal(shouldOfferTranslation(content), true);
});

test('tilde fences and an unclosed fence are excluded conservatively', () => {
  assert.equal(stripFencedCode('Visible.\n~~~text\n日本語\n~~~\n'), 'Visible.\n');
  assert.equal(stripFencedCode('Visible.\n```text\n日本語'), 'Visible.\n');
  assert.equal(shouldOfferTranslation([{ type: 'text', text: '```text\n日本語' }]), false);
});

test('threshold is finite, bounded, and configurable', () => {
  const mixed = [{ type: 'text', text: 'A aa あ' }];
  assert.equal(normalizeKanaThreshold(undefined), DEFAULT_KANA_THRESHOLD);
  assert.equal(normalizeKanaThreshold(-1), 0.01);
  assert.equal(normalizeKanaThreshold(2), 0.5);
  assert.equal(shouldOfferTranslation(mixed, 0.2), false);
  assert.equal(shouldOfferTranslation(mixed, 0.4), true);
});

test('empty text and non-text-only answers do not show the action', () => {
  assert.equal(shouldOfferTranslation([{ type: 'text', text: '... 😺' }]), false);
  assert.equal(shouldOfferTranslation([{ type: 'image', alt: 'English text' }]), false);
  assert.equal(shouldOfferTranslation(null), false);
});
