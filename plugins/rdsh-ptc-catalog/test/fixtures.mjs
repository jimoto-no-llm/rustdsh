import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { createScope } from '@deepseek-ai/dsh-scope';
import { createCatalog } from '../catalog.js';
import { apply } from '../index.js';

export const renderers = { typescript: renderToolsSdk, python: renderToolsSdkPy };

export function fixture({ mode = 'ptc', language = 'typescript', catalog = true, config = {} } = {}) {
  const ctx = new Context();
  const prompt = new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  const programs = [];
  const requests = [];
  // Test provider only. It never evaluates model-authored source or replaces
  // the original run_code dispatcher. Callbacks exercise its real bindings.
  const runtime = {
    language, isolation: 'fixture',
    resolve(request) { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 30000 }; },
    async run(request) {
      requests.push(request);
      const program = programs.shift();
      if (!program) throw new Error('No fixed test program was queued');
      try { return { logs: [], value: await program(request.bindings[0].functions, request) }; }
      catch (error) { return { logs: [], error: { kind: 'exception', message: error.message } }; }
    },
  };
  ctx.provide('ptcRuntime', runtime);
  const tools = new ToolRuntime(ctx, { mode, maxParallelSubCalls: 8 });
  const dispose = catalog ? apply(ctx, config) : () => {};
  const events = [];

  function agent(parent) {
    const result = { session: { header: { cwd: process.cwd() }, append(type, data) { events.push({ type, data }); } } };
    const scoped = createScope(parent?.ctx ?? ctx, result, parent ? { parent } : undefined);
    result.ctx = scoped.ctx;
    return result;
  }

  let calls = 0;
  async function run(scope, program) {
    programs.push(program);
    return tools.execute({ name: 'run_code', arguments: { code: '// fixed fixture; the provider does not evaluate this source', description: 'Catalog integration fixture' },
      agent: scope, callId: `catalog-fixture-${++calls}`, signal: new AbortController().signal });
  }

  return { ctx, tools, prompt, runtime, requests, programs, events, agent, run, dispose,
    catalog: createCatalog(tools, renderers, config),
    async close() { dispose(); await ctx.fiber.dispose(); } };
}

export function tool(name, description = 'Read a scoped fixture value.', execute = async args => ({ value: args.key ?? 'fixture' })) {
  return { name, description,
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: [], additionalProperties: false },
    output: { schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) { return execute(args, exec); } };
}

export function sdkSchemas(tools, scope) {
  return tools.schemas(scope).filter(schema => schema.name !== 'run_code')
    .map(schema => ({ ...schema, output: structuredClone(tools.get(schema.name, scope).output.schema) }));
}

export function canonicalValue(outcome) {
  if (outcome.isError) throw new Error(JSON.stringify(outcome));
  return outcome.value;
}
