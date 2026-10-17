import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { protectLiterals, restoreLiterals, shouldOfferTranslation, stripFencedCode } from '../plugins/rdsh-translation/translation-core.js';

test('translation core: identifier protection keeps snake, camel and acronym boundaries', () => {
  const identifiers = ['foo_bar', 'camelCase', 'HTTP', '_v2A', '__name', 'a__', 'a_0', 'a0_B', 'AA', '___'];
  const ordinary = ['a', 'A', 'Title', 'lowercase', '_name', '__', 'a_', 'A0_', '0_name', '0Camel'];
  const source = [...identifiers, ...ordinary].join(' ');
  const protectedText = protectLiterals(source, 'identifiers');
  assert.deepEqual(protectedText.literals.map(({ value }) => value), identifiers);
  assert.equal(restoreLiterals(protectedText.masked, protectedText.literals), source);
  const unicodeBoundary = protectLiterals('あcamelCaseい and 0camelCase and a_', 'unicode');
  assert.deepEqual(unicodeBoundary.literals.map(({ value }) => value), ['camelCase']);
});

test('translation core: LF and CRLF fences expose the following prose equally', () => {
  for (const newline of ['\n', '\r\n']) {
    for (const [prefix, fence] of [['', '```'], ['', '~~~~'], ['> ', '```']]) {
      for (const prose of ['The answer is ready.', 'これは日本語の説明です。']) {
        const source = `${prefix}${fence}js${newline}${prefix}console.log("code only");${newline}${prefix}${fence} \t${newline}${prose}`;
        assert.equal(stripFencedCode(source), prose);
        assert.equal(shouldOfferTranslation([{ type: 'text', text: source }]), prose === 'The answer is ready.');
      }
    }
    assert.equal(stripFencedCode(`~~~~js${newline}code${newline}~~~${newline}still code`), '');
  }
});

test('translation core: long identifier-like inputs finish within a bounded child process', () => {
  const moduleUrl = new URL('../plugins/rdsh-translation/translation-core.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { protectLiterals, restoreLiterals } from ${JSON.stringify(moduleUrl)};
    for (const source of ['0_'.repeat(11000), 'A'.repeat(22000), 'a'.repeat(22000), 'a' + '0_'.repeat(10999) + 'A']) {
      const result = protectLiterals(source, 'bounded');
      assert.equal(restoreLiterals(result.masked, result.literals), source);
    }
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});
