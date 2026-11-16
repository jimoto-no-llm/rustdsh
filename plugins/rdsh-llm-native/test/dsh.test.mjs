// The plugin inside the real DSH: registration through `ctx.llm`, and a
// compacted window surviving the session log across separate processes.
// The provider is the emulator with a fixed reply function; no model is called.
// Needs RDSH_DSH_RUNTIME, a folder holding node_modules/@deepseek-ai/dsh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createEmulator, listen } from '../../../tools/responses-emulator/server.mjs';

const exec = promisify(execFile);
const runtime = process.env.RDSH_DSH_RUNTIME;
const plugin = fileURLToPath(new URL('..', import.meta.url));

test('real DSH stores the window and replays it from the session log', {
  skip: runtime ? false : 'RDSH_DSH_RUNTIME is required', timeout: 180000,
}, async () => {
  const top = join(resolve(runtime), 'node_modules');
  // npm installs flat; a global install nests the packages under dsh itself.
  const modules = existsSync(join(top, '@deepseek-ai/dsh-llm')) ? top : join(top, '@deepseek-ai/dsh/node_modules');
  const dsh = join(top, '@deepseek-ai/dsh/lib/bin.js');
  const seen = [];
  const emulator = createEmulator({ chat: async ({ messages }) => {
    seen.push(messages);
    const last = messages.at(-1).content;
    const text = last.startsWith('Summarize the conversation above') ? 'SUMMARY-MARK the port is 8443'
      : messages.some(m => m.role === 'system' && m.content.includes('SUMMARY-MARK')) ? 'answer from summary' : 'plain answer';
    return { content: text, toolCalls: [], finish: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 } };
  } });
  const port = await listen(emulator.server);
  const root = await mkdtemp(join(tmpdir(), 'rdsh-llm-native-'));
  try {
    const copy = join(root, 'plugin');
    const profile = join(root, 'home/profiles/headless');
    await cp(plugin, copy, { recursive: true, filter: path => !path.includes('node_modules') && !path.endsWith('/test') });
    await mkdir(join(profile, 'node_modules'), { recursive: true });
    await mkdir(join(root, 'work'));
    const link = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(modules, join(copy, 'node_modules'), link);
    await symlink(join(modules, '@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'), link);
    await symlink(copy, join(profile, 'node_modules/rdsh-llm-native'), link);
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'native-test', private: true, type: 'module',
      dependencies: { 'rdsh-llm-native': `file:${copy.replaceAll('\\', '/')}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'rdsh-llm-native'] } } }));
    await writeFile(join(profile, 'cordis.patch.yml'), [
      '- id: rdsh-llm-native', '  config:', '    providers:', '      native:',
      `        baseURL: 'http://127.0.0.1:${port}/v1'`, '        apiKeyEnv: RDSH_NATIVE_KEY', '        models:',
      // The system prompt alone is past this trigger, so the second turn compacts.
      '          - { id: emulated, contextWindow: 262144, maxTokens: 512, compactAtTokens: 200 }',
      '- id: agent-default-model', '  config:', '    provider: native', '    model: emulated', ''].join('\n'));
    const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), DSH_HOME: join(root, 'home'),
      TMPDIR: root, TMP: root, TEMP: root, PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(process.platform === 'win32' ? ';' : ':'),
      RDSH_NATIVE_KEY: 'synthetic-key', DSH_PERMISSION_MODE: 'read-only', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
    let session;
    const turn = async prompt => {
      const out = await exec(process.execPath, [dsh, '--profile', 'headless', '--json',
        ...(session ? ['--session-id', session] : []), prompt], { env, cwd: join(root, 'work'), timeout: 60000, maxBuffer: 16e6 });
      const events = out.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
      session ??= events.find(event => event.type === 'session').sessionId;
      return events.find(event => event.type === 'final').text;
    };
    assert.equal(await turn('remember: the port is 8443'), 'plain answer');
    assert.equal(emulator.log.map(entry => entry.path).includes('/responses/compact'), false);
    // A new process: DSH rebuilds the history, the adapter compacts the first turn.
    assert.equal(await turn('which port?'), 'answer from summary');
    const paths = emulator.log.map(entry => entry.path);
    assert.equal(paths.filter(path => path === '/responses/compact').length, 1);
    // A third process finds the window in the session log and sends it back unchanged.
    const before = emulator.log.entries.length;
    assert.equal(await turn('and again?'), 'answer from summary');
    const replayed = emulator.log.entries.slice(before).filter(entry => entry.path === '/responses' && entry.compactionItems === 1);
    assert.equal(replayed.length, 1);
    assert.equal(emulator.log.entries.slice(before).some(entry => entry.path === '/responses/compact'), false);
    // The first turn's text never reaches the model again; the summary does.
    assert.ok(!seen.at(-1).some(m => String(m.content).includes('remember: the port is 8443')));
    assert.ok(seen.at(-1).some(m => String(m.content).includes('SUMMARY-MARK')));
  } finally {
    await new Promise(done => emulator.server.close(done));
    assert.ok(root.startsWith(join(tmpdir(), 'rdsh-llm-native-')));
    await rm(root, { recursive: true, force: true });
  }
});
