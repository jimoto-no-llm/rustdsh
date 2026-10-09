// Real installed DSH AgentLoop + Cordis events; no external provider/model calls.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installDiscordPresence } from '../../plugins/rdsh-settings/discord.js';
const modules = process.env.RDSH_NATIVE_MODULES;
assert.ok(modules, 'Set RDSH_NATIVE_MODULES to the original DSH node_modules directory');
const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
const [{ Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry }, { SystemPrompt }, { ToolRuntime }, { LlmRuntime, createUserMessage }, { AgentLoop }] = await Promise.all([
  'cordis', 'dsh-agent', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-llm', 'dsh-agent-loop',
].map(load));
const ctx = new Context();
new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx);
new SystemPrompt(ctx, {}); new ToolRuntime(ctx); new LlmRuntime(ctx);
const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 10 });
const publications = [], releases = [];
const errors = [];
ctx.on('agent/error', ({ error }) => { errors.push(error.message); });
ctx.on('agent/pre-step', () => new Promise(resolve => { releases.push(() => resolve({ kind: 'reject' })); }));
const presence = installDiscordPresence(ctx, {
  loadSettings: async () => ({ discord: { enabled: true, application_id: '123456789012345678' } }),
  connect: async () => ({ setActivity: async value => publications.push(value), destroy() {} }),
  minUpdateInterval: 0, interval: 1e6, throttle: 1,
});
try {
  const a = await loop.create('discord-qa-a'); const b = await loop.create('discord-qa-b');
  await presence.refresh(); assert.equal(publications.at(-1).state, '待機中');
  for (const agent of [a, b]) agent.followup(createUserMessage({ source: { kind: 'human' }, content: [{ type: 'text', text: 'isolated fixture' }] }));
  for (let i = 0; i < 200 && releases.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(releases.length, 2, `native loop did not reach pre-step: ${errors.join(', ')}`);
  await presence.refresh(); assert.equal(publications.at(-1).state, 'agent稼働中 (2)');
  for (const release of releases) release();
  await Promise.all([a.whenIdle(), b.whenIdle()]);
  await presence.refresh(); assert.equal(publications.at(-1).state, '待機中');
  assert.deepEqual(errors, []);
  console.log('PASS: original DSH AgentLoop emits idle -> two running agents -> idle to Discord; zero model requests');
} finally { await presence.stop(); await ctx.fiber.dispose(); }
