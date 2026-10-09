// Explicit live test only: publishes temporary activity to the user's Discord.
// It runs real DSH agents but holds them before model dispatch, then clears presence.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { installDiscordPresence, DiscordIpc, defaultDiscordApplicationId } from '../../plugins/rdsh-settings/discord.js';
const { values } = parseArgs({ options: { 'hold-seconds': { type: 'string', default: '60' }, extras: { type: 'boolean', default: false }, output: { type: 'string', default: 'target/discord-live/with-application-id.json' } } });
const hold = Number(values['hold-seconds']);
assert.ok(Number.isFinite(hold) && hold >= 1 && hold <= 300);
const modules = process.env.RDSH_NATIVE_MODULES;
assert.ok(modules, 'Set RDSH_NATIVE_MODULES to the installed original DSH node_modules');
const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href);
const [{ Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry }, { SystemPrompt }, { ToolRuntime }, { LlmRuntime, createUserMessage }, { AgentLoop }] = await Promise.all([
  'cordis', 'dsh-agent', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-llm', 'dsh-agent-loop',
].map(load));
const ctx = new Context();
new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx);
new SystemPrompt(ctx, {}); new ToolRuntime(ctx); new LlmRuntime(ctx);
const loop = new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 10 });
const releases = [], errors = [], acknowledgements = [];
const report = { scope: 'Live Windows Discord IPC + original DSH AgentLoop, with zero model requests', application_id: defaultDiscordApplicationId,
  rpc_verified: false, profile_ui_verified: false, acknowledgements, actual_model_requests: 0, cleared: false };
ctx.on('agent/error', ({ error }) => { errors.push(error.message); });
ctx.on('agent/pre-step', () => new Promise(resolve => releases.push(() => resolve({ kind: 'reject' }))));
let enabled = true;
const presence = installDiscordPresence(ctx, {
  // Deliberately omit application_id: test the bundled default as users will use it.
  loadSettings: async () => ({ discord: { enabled, ...(values.extras ? { button_label: 'dshについて', button_url: 'https://github.com/jimoto-no-llm/rustdsh' } : {}) } }),
  connect: async id => {
    const rpc = await DiscordIpc.connect(id);
    return {
      get closed() { return rpc.closed; }, destroy() { rpc.destroy(); },
      async setActivity(activity) {
        const response = await rpc.setActivity(activity);
        assert.equal(response.cmd, 'SET_ACTIVITY');
        const data = response.data;
        const observation = { stage: activity?.state ?? 'cleared', sent: activity, acknowledged: true,
          returned: data ? { application_id: data.application_id, name: data.name, details: data.details, state: data.state, type: data.type, status_display_type: data.status_display_type, assets: data.assets, buttons: data.buttons, timestamps: data.timestamps } : null };
        acknowledgements.push(observation);
        console.log(JSON.stringify(observation));
      },
    };
  }, interval: 1e6, throttle: 1000,
});
const wait = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000));
try {
  const a = await loop.create('discord-live-a'), b = await loop.create('discord-live-b');
  await presence.refresh(); assert.equal(presence.status().state, 'connected');
  assert.equal(acknowledgements.at(-1).sent.state, '待機中');
  await wait(15);
  for (const agent of [a, b]) agent.followup(createUserMessage({ source: { kind: 'human' }, content: [{ type: 'text', text: 'Discord integration test; no model request' }] }));
  for (let i = 0; i < 200 && releases.length < 2; i++) await wait(0.005);
  assert.equal(releases.length, 2);
  await presence.refresh(); assert.equal(presence.status().state, 'connected');
  assert.equal(acknowledgements.at(-1).sent.state, 'agent稼働中 (2)');
  console.log(JSON.stringify({ phase: 'running', hold_seconds: hold }));
  await wait(hold);
  for (const release of releases) release();
  await Promise.all([a.whenIdle(), b.whenIdle()]);
  await presence.refresh(); assert.equal(acknowledgements.at(-1).sent.state, '待機中');
  await wait(15);
  enabled = false; await presence.refresh();
  assert.equal(presence.status().state, 'disabled');
  assert.equal(acknowledgements.at(-1).sent, null);
  assert.deepEqual(errors, []);
  report.rpc_verified = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  for (const release of releases) release();
  await presence.stop(); await ctx.fiber.dispose();
  report.cleared = acknowledgements.at(-1)?.sent === null;
  const output = resolve(values.output);
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ rpc_verified: report.rpc_verified, profile_ui_verified: report.profile_ui_verified, cleared: report.cleared, output }));
}
