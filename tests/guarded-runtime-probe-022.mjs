// Used in an isolated Node process with the mandatory preload, against the
// 0.2.2 line where the tool service moved onto Cordis. The 0.2.1 probe in
// guarded-runtime-probe.mjs drives the PTC runtime API that 0.2.2 replaced.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(process.env.RDSH_TOOL_RUNTIME, '../../..');
const { Context } = await import(pathToFileURL(path.join(root, 'cordis/lib/index.js')));
const { default: ToolRuntime } = await import(pathToFileURL(process.env.RDSH_TOOL_RUNTIME));

const ctx = new Context();
ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 1; } });
const tools = new ToolRuntime(ctx);

// The preload installs the boundary from the constructor: if the anchor moved
// again the import itself fails with UNSUPPORTED_CONSTRUCTOR, and a service
// without the hook would simply not carry rdsh_inspect.
const inspector = tools.get('rdsh_inspect');
assert.ok(inspector, 'the isolated inspection tool should be registered');
const result = await inspector.execute({ command: 'printf PROBE_022_RUNTIME' });
assert.equal(result.exitCode, 0, result.stderr);
assert.equal(result.stdout, 'PROBE_022_RUNTIME');
console.log('ok');
