import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../index.js';

const modules = process.env.DSH_TEST_NODE_MODULES;
test('installed DSH runtime preserves nested permission denial and successful canonical output', { skip: !modules }, async () => {
  const require = createRequire(join(modules, '..', 'package.json'));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { default: ToolRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
  const { default: SystemPrompt } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href);
  const { createScope } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')).href);
  const ctx = new Context();
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  const tools = new ToolRuntime(ctx, { mode: 'native', maxParallelSubCalls: 8 });
  let bodies = 0;
  tools.register({ name: 'subagent', description: 'Fixed delegated fixture',
    parameters: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' }, run_in_background: { type: 'boolean' } }, required: ['description', 'prompt', 'run_in_background'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute() { bodies++; return { text: 'real registry success' }; } });
  const dispose = apply(ctx);
  const agent = {};
  agent.ctx = createScope(ctx, agent).ctx;
  const run = () => tools.execute({ name: 'model_call', arguments: { prompt: 'fixed task' }, agent, callId: 'root', signal: new AbortController().signal });
  try {
    const deny = ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'subagent' ? { kind: 'deny', reason: 'nested policy denied' } : next());
    const rejected = await run();
    assert.equal(rejected.isError, true);
    assert.match(rejected.error.message, /nested policy denied/);
    assert.equal(bodies, 0);
    deny();
    const accepted = await run();
    assert.equal(accepted.isError, false, JSON.stringify(accepted));
    assert.deepEqual(accepted.value.result, { text: 'real registry success' });
    assert.deepEqual(accepted.content, [{ type: 'text', text: 'real registry success' }]);
    assert.equal(bodies, 1);
  } finally { dispose(); await ctx.fiber.dispose(); }
});
