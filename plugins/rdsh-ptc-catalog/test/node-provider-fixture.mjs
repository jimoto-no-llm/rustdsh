// Trusted, fixed program only, launched with a fresh home by node-provider.test.
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SessionStore from '@deepseek-ai/dsh-session';
import FileSystem from '@deepseek-ai/dsh-fs-local';
import Subprocess from '@deepseek-ai/dsh-subprocess-local';
import Sandbox from '@deepseek-ai/dsh-sandbox-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SEARCH, DESCRIBE } from '../catalog.js';
import { apply } from '../index.js';
import { tool, canonicalValue } from './fixtures.mjs';

const ctx = new Context();
const events = [];
let invoked = 0;
try {
  await ctx.plugin(SessionStore);
  await ctx.plugin(FileSystem);
  await ctx.plugin(Subprocess);
  await ctx.plugin(Sandbox, {});
  await ctx.plugin(SessionProjections);
  // This fixed fixture is execution proof, not a confinement claim. The
  // guarded rdsh launcher is tested separately and continues to deny PTC.
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: process.cwd() });
  await ctx.plugin(NodeRuntime, { timeoutMs: 10000, maxTimeoutMs: 10000 });
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  const tools = new ToolRuntime(ctx, { mode: 'ptc', maxParallelSubCalls: 8 });
  apply(ctx);
  tools.register(tool('fixture/read.value', 'Read the fixed catalog fixture.', async args => {
    invoked++; return { value: args.key };
  }));
  tools.register(tool('fixture/hidden.value', 'FIXTURE_HIDDEN_SENTINEL'));
  const agent = { session: ctx.sessions.create('catalog-native-fixture', { meta: { cwd: process.cwd() } }) };
  ctx.on('session/event', (session, event) => {
    if (session === agent.session) events.push({ type: event.type, data: event.data });
  });
  agent.ctx = createScope(ctx, agent).ctx;
  agent.ctx.tools.restrict({ deny: ['fixture/hidden.value'] });
  const outcome = await tools.execute({ name: 'run_code',
    arguments: { description: 'Search, describe and invoke a fixed original Node PTC binding', code: `
      const search = await tools[${JSON.stringify(SEARCH)}]({query: "fixed catalog fixture", namespace: "fixture"});
      const name = search.tools[0].name;
      const described = await tools[${JSON.stringify(DESCRIBE)}]({name});
      const hidden = await tools[${JSON.stringify(DESCRIBE)}]({name: "fixture/hidden.value"});
      const value = await tools[name]({key: "ORIGINAL_NODE_BINDING"});
      return {value, name, completeTypes: described.status === "ok" && described.tool.input.type === "object" && described.tool.output.type === "object", hidden: hidden.status, credentialAbsent: process.env.DEEPSEEK_API_KEY === undefined};
    ` }, agent, callId: 'catalog-original-node', signal: new AbortController().signal });
  const value = canonicalValue(outcome).result;
  assert.deepEqual(value, { value: { value: 'ORIGINAL_NODE_BINDING' }, name: 'fixture/read.value', completeTypes: true, hidden: 'not_found', credentialAbsent: true });
  assert.equal(invoked, 1);
  assert.deepEqual(events.filter(event => event.type === 'tool/ptc-dispatch').map(event => event.data.name),
    [SEARCH, DESCRIBE, DESCRIBE, 'fixture/read.value']);
  const deny = agent.ctx.tools.guard(exec => exec.name === 'fixture/read.value' ? 'fixture denied after discovery' : undefined);
  const denied = await tools.execute({ name: 'run_code', arguments: { code: 'return tools["fixture/read.value"]({key: "NO_REPLAY"});', description: 'Check original guard' },
    agent, callId: 'catalog-original-denied', signal: new AbortController().signal });
  assert.equal(denied.isError, true);
  assert.equal(invoked, 1);
  deny();
  console.log(JSON.stringify({ fixture: 'original-node-provider', result: value, actualBodyCalls: invoked,
    guardDenied: denied.isError, nestedEvents: events.filter(event => event.type === 'tool/ptc-dispatch').length }));
} finally {
  await ctx.fiber.dispose();
}
