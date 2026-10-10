// Used in an isolated Node process with the mandatory preload.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(process.env.RDSH_TOOL_RUNTIME, '../../..');
const { Context } = await import(pathToFileURL(path.join(root, 'cordis/lib/index.js')));
const { createScope } = await import(pathToFileURL(path.join(root, 'dsh-scope/lib/index.js')));
const { default: ToolRuntime } = await import(pathToFileURL(process.env.RDSH_TOOL_RUNTIME));

const ctx = new Context();
ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 1; } });
const tools = new ToolRuntime(ctx, { mode: 'ptc' });

// The preload must leave DSH's selected mode and ordinary middleware intact.
assert.equal(tools.defaultMode, 'ptc');
assert.equal(tools.modeFor(), 'ptc');
const agent = {};
const scoped = createScope(ctx, agent);
agent.ctx = scoped.ctx;
scoped.ctx.tools.presentAs('ptc');
assert.equal(scoped.ctx.tools.modeFor(), 'ptc');
assert.equal(tools.guardReason({ name: 'bash', agent }), undefined);
assert.equal(tools.guardReason({ name: 'run_code', agent }), undefined);
assert.equal(tools.guardReason({ name: 'rdsh_inspect', agent }), undefined);

const inspector = tools.get('rdsh_inspect');
assert.ok(inspector, 'the isolated inspection tool should be registered');
const result = await inspector.execute({ command: 'printf DUMMY_GUARDED_RUNTIME' });
assert.equal(result.exitCode, 0, result.stderr);
assert.equal(result.stdout, 'DUMMY_GUARDED_RUNTIME');

const dispatched = await tools.execute({
  name: 'rdsh_inspect',
  arguments: { command: 'printf DUMMY_MODEL_DISPATCH' },
  agent,
  callId: 'dummy-dispatch',
  signal: new AbortController().signal,
});
assert.equal(dispatched.isError, true);
assert.match(JSON.stringify(dispatched), /only `run_code` is callable directly/);

console.log('DSH modes are preserved and isolated inspection remains available');
