// Only run in an isolated process with the repository's mandatory preload.
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import SessionStore from '@deepseek-ai/dsh-session';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { apply } from '../index.js';
import { LOAD, SEARCH, STATUS } from '../discovery.js';
const ctx = new Context();
new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
new SessionStore(ctx);
const tools = new ToolRuntime(ctx, { mode: 'both' });
const before = tools.schemas().map(tool => tool.name);
assert.ok(tools.get('rdsh_inspect'));
// rdsh no longer forces ToolRuntime into `native` mode or rejects every tool
// except its own inspector: DSH's configured permission and approval behaviour
// applies to ordinary tools such as `run_code`, which must therefore be
// registered. The isolation guarantee that remains is that the MCP exposure
// plugin never registers its own tools and that `rdsh_inspect` cannot be
// dispatched by the model (asserted in tests/guarded-runtime-probe.mjs).
assert.ok(tools.get('run_code'), 'upstream DSH tools are no longer globally denied');
await assert.rejects(apply(ctx, { servers: [{ connection: { transport: 'streamable-http', serverName: 'refused',
  url: 'http://127.0.0.1:1/not-connected', reconnect: { enabled: false } }, exposure: 'deferred' }] }),
{ code: 'RDSH_MCP_GUARDED_NATIVE' });
assert.deepEqual(tools.schemas().map(tool => tool.name), before);
for (const name of [LOAD, SEARCH, STATUS]) assert.equal(tools.get(name), undefined);
await ctx.fiber.dispose();
console.log(JSON.stringify({ guardedNativeRefusedBeforeRegistration: true, nativeInspectionRetained: true, upstreamToolsRestored: true }));
