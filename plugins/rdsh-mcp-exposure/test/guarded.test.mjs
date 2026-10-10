import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);

test('the actual mandatory rdsh preload refuses the bundle without opening PTC or changing audited Native registrations', async t => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|COMSPEC|WINDIR|TEMP|TMP|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(key)));
  Object.assign(env, { RDSH_TOOL_RUNTIME: fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-tools')),
    RDSH_SECURE_WORKSPACE: root, RDSH_SHARED_FILES: '[]' });
  const { stdout } = await execute(process.execPath, ['--import', new URL('../../../security/preload.mjs', import.meta.url).href,
    fileURLToPath(new URL('./guarded-probe.mjs', import.meta.url))], { cwd: root, env, timeout: 20000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result, { guardedNativeRefusedBeforeRegistration: true, nativeInspectionRetained: true, runCodeAbsent: true });
  t.diagnostic(JSON.stringify(result));
});
