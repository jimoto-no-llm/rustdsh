import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../index.js';
import { attachSessionCleanup } from '../cleanup.mjs';
import { cleanupDiagnostic } from '../diagnostics.mjs';

test('headless rejects a missing asynchronous completion API with localized diagnostics and unchanged code', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rdsh-cleanup-locale-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    for (const [language, expected] of Object.entries({
      en: 'Session cleanup requires the rdsh headless runtime with its asynchronous close-completion API.',
      ja: 'セッションの後始末には、非同期の終了完了待機APIを備えたrdsh headlessランタイムが必要です。',
      'zh-CN': '会话清理需要提供异步关闭完成API的rdsh headless运行时。',
    })) {
      await writeFile(join(home, 'rdsh.json'), JSON.stringify({ general: { language } }));
      assert.equal(cleanupDiagnostic('runtime'), expected);
      const expectedFailure = {
        en: 'Headless session resource cleanup failed.',
        ja: 'headlessセッションのリソースを後始末できませんでした。',
        'zh-CN': 'headless会话资源清理失败。',
      }[language];
      const listeners = new Map(), disposers = [];
      const raw = new Error('upstream cleanup detail');
      attachSessionCleanup({
        get: () => ({ name: 'headless' }),
        on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); },
        effect(install) { disposers.push(install()); },
      }, async () => { throw raw; });
      listeners.get('agent/created')({ agent: { id: 'owned', session: { id: 'owned' } } });
      await assert.rejects(disposers[0](), error => {
        assert.equal(error.code, 'RDSH_SESSION_CLEANUP_FAILED');
        assert.equal(error.message, expectedFailure);
        assert.deepEqual(error.errors, [raw]);
        return true;
      });

      await assert.rejects(apply({ get: () => ({ name: 'headless' }), on: () => assert.fail('Unsupported runtime must not register listeners') }),
        { code: 'RDSH_SESSION_CLEANUP_RUNTIME', message: expected });
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
