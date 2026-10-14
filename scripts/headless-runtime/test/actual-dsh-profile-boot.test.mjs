import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const candidate = process.env.RDSH_CANDIDATE;

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, 'condition did not settle before timeout');
}

test('actual headless boot mounts the inserted cleanup plugin and closes only its created agent session', { skip: !candidate }, async () => {
  const require = createRequire(import.meta.url);
  const { WebSocketServer } = require(path.join(candidate, 'node_modules/ws'));
  const server = new WebSocketServer({ port: 0 });
  const peers = new Set();
  server.on('connection', peer => peers.add(peer));
  await new Promise(resolve => server.once('listening', resolve));
  const oldHome = process.env.DSH_HOME;
  const oldExitCode = process.exitCode;
  const home = await mkdtemp(path.join(tmpdir(), 'rdsh-headless-profile-'));
  let boot;
  try {
    const overlay = path.join(home, 'headless-cleanup.yml');
    const plugin = path.join(candidate, 'plugins/rdsh-session-cleanup/index.js');
    await writeFile(overlay, `- id: headless-startup\n  disabled: true\n- id: headless-runner\n  disabled: true\n- insert:\n    - id: rdsh-session-cleanup\n      name: ${plugin}\n      config: {}\n`);
    process.env.DSH_HOME = home;

    const profileBoot = await import(pathToFileURL(path.join(candidate, 'node_modules/@deepseek-ai/dsh/lib/profile-boot.js')).href);
    profileBoot.prepareProfile('headless');

    const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(path.join(candidate, 'node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js')).href);
    const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]);
    boot = await profileBoot.runProfile({ environment, profile: 'headless', patchFiles: [overlay], args: [] });
    assert.equal(boot.ctx.get('profileContext')?.name, 'headless');

    const handle = await boot.ctx.agents.create({ sessionId: randomUUID() });
    const sdk = await import(pathToFileURL(path.join(candidate, 'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js')).href);
    const acquire = sdk.__rdshAcquireWebSocketForTest;
    const url = `ws://127.0.0.1:${server.address().port}`;
    const owned = await acquire(url, new Headers(), 'owned-cache', 'account', undefined, 500, undefined, 'node-ws', handle.agent.id);
    const unrelated = await acquire(url, new Headers(), 'unrelated-cache', 'account', undefined, 500, undefined, 'node-ws', 'unrelated-session');

    const began = performance.now();
    await boot.shutdown.shutdown(0);
    assert.ok(performance.now() - began < 2_000, 'app shutdown must settle within two seconds');
    await waitFor(() => owned.socket.readyState === 3);
    assert.equal(unrelated.socket.readyState, 1, 'the mounted cleanup plugin must not close an unowned session');
    assert.equal(process.exitCode, 0);
    await sdk.closeOpenAICodexWebSocketSessions('unrelated-session');
  } finally {
    await boot?.ctx.fiber.dispose().catch(() => {});
    for (const peer of peers) peer.terminate();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    process.exitCode = oldExitCode;
  }
});


test('actual headless CLI propagates node-ws through streamSimple and naturally exits after a local Codex WebSocket completion', { skip: !candidate }, async () => {
  const require = createRequire(import.meta.url);
  const { WebSocketServer } = require(path.join(candidate, 'node_modules/ws'));
  const server = new WebSocketServer({ port: 0 });
  const peers = new Set();
  let requests = 0;
  server.on('connection', peer => {
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('message', () => {
      requests++;
      const send = event => peer.send(JSON.stringify(event));
      send({ type: 'response.created', response: { id: `fake-response-${requests}` } });
      send({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `fake-message-${requests}`, phase: 'final_answer' } });
      send({ type: 'response.output_text.delta', output_index: 0, delta: 'FAKE_OK' });
      send({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `fake-message-${requests}`, phase: 'final_answer', content: [{ type: 'output_text', text: 'FAKE_OK' }] } });
      send({ type: 'response.completed', response: { id: `fake-response-${requests}`, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    });
  });
  await new Promise(resolve => server.once('listening', resolve));
  const run = await mkdtemp(path.join(tmpdir(), 'rdsh-headless-cli-ws-'));
  let child;
  try {
    for (const name of ['home', 'dsh-home', 'workspace', 'sessions', 'tmp', 'cache']) await mkdir(path.join(run, name));
    const patch = path.join(run, 'headless.yml');
    const cleanup = path.join(candidate, 'plugins/rdsh-session-cleanup/index.js');
    const diagnostic = path.join(run, 'cleanup-diagnostic.mjs');
    const evidence = path.join(run, 'cleanup-diagnostic.json');
    const pi = pathToFileURL(path.join(candidate, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href;
    await writeFile(diagnostic, `import { writeFile } from 'node:fs/promises'; import { cleanupSessionResourcesAsync } from ${JSON.stringify(pi)}; export const inject = ['agents', 'sessions', 'profileContext']; export function apply(ctx) { const owned = new Set(); const pending = new Set(); const record = { adopted: 0, cleanCalls: [], disposerOwned: -1, pendingSettled: -1, profile: ctx.get('profileContext')?.name }; const clean = id => { if (typeof id !== 'string' || !owned.delete(id)) return; record.cleanCalls.push(id); const task = Promise.resolve(cleanupSessionResourcesAsync(id)).catch(() => {}); pending.add(task); task.finally(() => pending.delete(task)); }; ctx.on('agent/created', ({ agent } = {}) => { const id = agent?.session?.id; if (typeof id === 'string' && id && agent.id === id) { owned.add(id); record.adopted++; record.agentSessionEqual = true; } }); ctx.on('session/disposed', session => clean(session?.id)); ctx.effect(() => async () => { record.disposerOwned = owned.size; for (const id of [...owned]) clean(id); await Promise.all([...pending]); record.pendingSettled = pending.size; await writeFile(${JSON.stringify(evidence)}, JSON.stringify(record)); setImmediate(() => { record.postDisposeResources = process.getActiveResourcesInfo().sort(); void writeFile(${JSON.stringify(evidence)}, JSON.stringify(record)); }); }, 'safe exact-session cleanup diagnostic'); }`);
    const fakeToken = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fake-account' } })).toString('base64url')}.fake`;
    await writeFile(patch, JSON.stringify([
      { id: 'agent-default-model', config: { provider: 'openai-codex', model: 'gpt-6-sol', reasoningEffort: 'high' } },
      { id: 'llm-pi-ai', config: { providers: { 'openai-codex': { models: [{ id: 'gpt-6-sol' }], baseURL: `http://127.0.0.1:${server.address().port}`, transport: 'websocket', webSocketFactory: 'node-ws', retryPolicy: { mode: 'normal', maxRetries: 0 }, apiKeyEnv: 'FAKE_API_KEY' } } } },
      { id: 'session-persistence-jsonl', config: { root: path.join(run, 'sessions') } },
      { id: 'session-title-llm', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
      { insert: [{ id: 'rdsh-session-cleanup', name: cleanup, config: {} }, { id: 'cleanup-diagnostic', name: diagnostic, config: {} }] },
    ]));
    child = spawn(path.join(candidate, 'node_modules/.bin/dsh'), ['headless', '--patch', patch, '--json', 'reply'], {
      cwd: path.join(run, 'workspace'),
      env: { PATH: process.env.PATH, HOME: path.join(run, 'home'), DSH_HOME: path.join(run, 'dsh-home'), TMPDIR: path.join(run, 'tmp'), NODE_COMPILE_CACHE: path.join(run, 'cache'), FAKE_API_KEY: fakeToken },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const started = performance.now();
    const result = await Promise.race([
      new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1_900)),
    ]);
    if (result.timeout) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      const details = await (await import('node:fs/promises')).readFile(evidence, 'utf8');
      assert.fail(`headless child did not naturally exit within the two-second acceptance limit: ${details}`);
    }
    assert.deepEqual(result, { code: 0, signal: null });
    assert.ok(performance.now() - started < 2_000);
    assert.equal(requests, 1, 'the isolated model turn must make exactly one SDK request');
    assert.match(output, /"phase":"turn_end"/);
    assert.match(output, /"type":"final"/);
    await waitFor(() => peers.size === 0);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    for (const peer of peers) peer.terminate();
    await new Promise(resolve => server.close(resolve));
    await rm(run, { recursive: true, force: true });
  }
});
