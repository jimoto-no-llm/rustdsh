// Used in an isolated Node process with the mandatory preload.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { apply as applyPtcCatalog } from '../plugins/rdsh-ptc-catalog/index.js';

const root = path.resolve(process.env.RDSH_TOOL_RUNTIME, '../../..');
const { Context } = await import(pathToFileURL(path.join(root, 'cordis/lib/index.js')));
const { createScope } = await import(pathToFileURL(path.join(root, 'dsh-scope/lib/index.js')));
const { PtcExecutor } = await import(pathToFileURL(path.join(root, 'dsh-tool-executor-ptc/lib/index.js')));
const { default: ToolRuntime } = await import(pathToFileURL(process.env.RDSH_TOOL_RUNTIME));

const ctx = new Context();
ctx.provide('systemPrompt', { tools() {}, section() { return () => {}; }, getSectionOrder() { return 1; } });
const tools = new ToolRuntime(ctx);
const ptc = new PtcExecutor(ctx);
tools.setExecutor(ptc);

// The catalog bundle requires an already authorized PTC composition. The
// guarded launcher must refuse it before any registration or prompt wiring.
assert.throws(() => applyPtcCatalog(ctx), { code: 'RDSH_CATALOG_GUARDED_NATIVE' });
assert.equal(tools.get('rdsh_catalog_search'), undefined);
assert.equal(tools.get('rdsh_catalog_describe'), undefined);

// The preload must leave DSH's selected executor and ordinary guards intact.
assert.equal(tools.selectExecutor(), ptc);
const agent = { session: { id: 'dummy-session', append() {} } };
const scoped = createScope(ctx, agent);
agent.ctx = scoped.ctx;
const scopedPtc = new PtcExecutor(scoped.ctx);
scoped.ctx.tools.setExecutor(scopedPtc);
assert.equal(scoped.ctx.tools.selectExecutor(agent), scopedPtc);
assert.equal(tools.checkGuards({ name: 'bash', agent }), undefined);
assert.equal(tools.checkGuards({ name: 'run_code', agent }), undefined);
assert.equal(tools.checkGuards({ name: 'rdsh_inspect', agent }), undefined);

const inspector = tools.get('rdsh_inspect');
assert.ok(inspector, 'the isolated inspection tool should be registered');
const result = await inspector.execute({ command: 'printf DUMMY_GUARDED_RUNTIME' });
assert.equal(result.exitCode, 0, result.stderr);
assert.equal(result.stdout, 'DUMMY_GUARDED_RUNTIME');

const batch = await tools.execute({
  calls: [{
    type: 'tool-call',
    id: 'dummy-dispatch',
    name: 'rdsh_inspect',
    arguments: JSON.stringify({ command: 'printf DUMMY_MODEL_DISPATCH' }),
  }],
  agent,
  signal: new AbortController().signal,
});
const dispatched = batch.results.find(entry => entry.callId === 'dummy-dispatch')?.result;
assert.equal(dispatched?.isError, true);
assert.match(JSON.stringify(dispatched), /only `run_code` is callable directly/);

console.log('guarded runtime refused the PTC catalog, preserved DSH modes and kept isolated inspection available');
