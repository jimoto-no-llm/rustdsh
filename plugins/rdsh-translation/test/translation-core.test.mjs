import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTranslationPrompt,
  isFinalTranslatableAssistant,
  protectLiterals,
  restoreLiterals,
  translationReplacementSource,
} from '../translation-core.js';

test('only a settled, matching, translatable text answer exposes the action', () => {
  const answer = {
    status: 'settled',
    finalNode: { messageId: 'message-1', blocks: [{ type: 'text', text: 'A useful English answer.' }] },
  };
  assert.equal(isFinalTranslatableAssistant(answer, 'message-1'), true);
  assert.equal(isFinalTranslatableAssistant(answer, 'message-2'), false);
  assert.equal(isFinalTranslatableAssistant({ ...answer, status: 'interrupted' }, 'message-1'), false);
  assert.equal(isFinalTranslatableAssistant({ ...answer, finalNode: { ...answer.finalNode, interrupted: true } }, 'message-1'), false);
  assert.equal(isFinalTranslatableAssistant({ ...answer, finalNode: { messageId: 'message-1', blocks: [{ type: 'text', text: '日本語の回答です。' }] } }, 'message-1'), false);
  assert.equal(isFinalTranslatableAssistant({ ...answer, finalNode: { messageId: 'message-1', blocks: [{ type: 'text', text: 'English' }, { type: 'image' }] } }, 'message-1'), false);
});

test('configured threshold changes action eligibility', () => {
  const data = { status: 'settled', finalNode: { messageId: 'm', blocks: [{ type: 'text', text: 'A aa あ' }] } };
  assert.equal(isFinalTranslatableAssistant(data, 'm', 0.2), false);
  assert.equal(isFinalTranslatableAssistant(data, 'm', 0.4), true);
});

test('translation prompt restores exact fenced code, identifiers, paths, links, and flags', () => {
  const original = 'Run `dsh --version` and call getSessionID.\n```rs\nlet config_path = "M:\\\\Tools\\\\rdsh.json";\n```\nSee Cargo.toml at https://example.com/docs.';
  const { masked, literals } = protectLiterals(original, 'test');
  assert.equal(literals.length, 5);
  const prompt = buildTranslationPrompt(masked, literals);
  assert.match(prompt, /翻訳文だけ/u);
  assert.equal(restoreLiterals(`回答: ${masked}`, literals), `回答: ${original}`);
});

test('Unix, Windows, UNC, and relative path forms survive exactly', () => {
  const original = 'Use /var/tmp/rdsh/cache, src/session/store, ./plugins/rdsh-translation, M:/Codex/home/worktrees, and \\\\server\\share\\folder.';
  const { masked, literals } = protectLiterals(original, 'paths');
  assert.ok(masked.includes(' '));
  assert.equal(restoreLiterals(masked, literals), original);
  for (const path of ['/var/tmp/rdsh/cache', 'src/session/store', './plugins/rdsh-translation', 'M:/Codex/home/worktrees', '\\\\server\\share\\folder']) {
    assert.ok(literals.some((literal) => literal.value === path || literal.value.startsWith(path)), `${path} should be protected as a single literal`);
  }
});

test('a changed or missing protected token fails without committing a replacement', () => {
  const { literals } = protectLiterals('Open `Cargo.toml`.', 'test');
  assert.throws(() => restoreLiterals('Open Cargo.toml.', literals), /保護情報/u);
  assert.throws(() => restoreLiterals(`${literals[0].token} ${literals[0].token}`, literals), /保護情報/u);
});

test('replacement source retains original text for a collapsed disclosure', () => {
  const content = [{ type: 'text', text: 'Original answer.' }];
  assert.deepEqual(translationReplacementSource('message-1', content, { turn: 4, step: 2 }), {
    kind: 'compact-checkpoint',
    rdshTranslation: true,
    originalMessageId: 'message-1',
    originalText: 'Original answer.',
    originalTurn: 4,
    originalStep: 2,
  });
});
