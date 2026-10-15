import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardLanguage, reminderSummary, REMINDER_TEXT } from '../plugins/rdsh-answer-guard/index.js';

for (const [language, summary, diagnostic] of [
  ['en', 'A reply without visible text was detected; another output was requested', 'must be an integer >= 0, got -1'],
  ['zh-CN', '检测到没有正文的回复，已请求重新输出', '必须是大于等于0的整数，收到 -1'],
  ['ja', '本文なしの応答を検知したため、再出力を要求しました', '0以上の整数にしてください。指定値: -1'],
]) {
  test(`answer guard uses ${language} for owned text, preserving steering data`, () => {
    const home = mkdtempSync(join(tmpdir(), 'rdsh-guard-言語-'));
    try {
      const path = join(home, 'rdsh.json');
      const settings = JSON.stringify({ general: { language }, features: { answer_guard: true }, untouched: '資料/空 白' });
      writeFileSync(path, settings, { mode: 0o400 });
      const env = { DSH_HOME: home, RDSH_LANG: '', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
      assert.equal(guardLanguage(env), language);
      assert.equal(reminderSummary(language), summary);
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { createReminder, createAnswerGuard } from './plugins/rdsh-answer-guard/index.js';
        const notice = createReminder();
        let diagnostic;
        try { createAnswerGuard({ maxNudges: -1 }); } catch (error) { diagnostic = error.message; }
        console.log(JSON.stringify({notice, diagnostic}));
      `], { cwd: new URL('..', import.meta.url), env: { ...process.env, ...env }, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      const { notice, diagnostic: actual } = JSON.parse(child.stdout);
      assert.deepEqual(notice.source, { kind: 'rdsh-answer-guard', form: 'notice', summary });
      assert.deepEqual(notice.content, [{ type: 'text', text: REMINDER_TEXT }]);
      assert.equal(notice.role, 'user');
      assert.match(notice.id, /^[0-9a-f-]{36}$/);
      assert.ok(actual.includes(diagnostic), actual);
      assert.equal(readFileSync(path, 'utf8'), settings);
      assert.equal(guardLanguage({ ...env, RDSH_LANG: 'ja_JP.UTF-8' }), 'ja');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

test('missing and malformed settings preserve system preference and file bytes', () => {
  const home = mkdtempSync(join(tmpdir(), 'rdsh-guard-locale-'));
  try {
    const env = { DSH_HOME: home, LC_MESSAGES: 'zh_CN.UTF-8' };
    assert.equal(guardLanguage(env), 'zh-CN');
    const path = join(home, 'rdsh.json');
    writeFileSync(path, '{壊れた設定');
    assert.equal(guardLanguage(env), 'zh-CN');
    assert.equal(readFileSync(path, 'utf8'), '{壊れた設定');
    writeFileSync(path, '{"general":{"language":"auto"}}');
    assert.equal(guardLanguage({ ...env, LC_ALL: 'ja_JP.UTF-8' }), 'ja');
    assert.equal(guardLanguage({ ...env, RDSH_LANG: 'unsupported', LC_ALL: 'ja_JP.UTF-8' }), 'en');
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('plugin metadata exports the three DSH locale resources', async () => {
  const metadata = [];
  for (const language of ['en', 'zh', 'ja']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `console.log(import.meta.resolve('rdsh-answer-guard/locale/${language}.json'))`], { cwd: new URL('../plugins/rdsh-answer-guard/', import.meta.url), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    metadata.push(JSON.parse(readFileSync(new URL(child.stdout.trim()), 'utf8')).meta);
  }
  assert.equal(new Set(metadata.map(value => value.title)).size, 3);
  assert.equal(new Set(metadata.map(value => value.description)).size, 3);
});
