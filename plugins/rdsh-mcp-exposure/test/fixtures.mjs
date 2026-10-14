import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools';
import SessionStore from '@deepseek-ai/dsh-session';
import { createScope } from '@deepseek-ai/dsh-scope';
import { createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { Discovery } from '../discovery.js';
import { discoveryTools } from '../tools.js';
import { compileConfig } from '../policy.js';

export function fixture({ mode = 'native', config, setupDiscovery = true, promptConfig = {} } = {}) {
  const ctx = new Context();
  const prompt = new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false, ...promptConfig });
  const sessions = new SessionStore(ctx);
  const programs = [], requests = [];
  const runtime = { language: 'typescript', isolation: 'fixture',
    resolve(request) { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 30000 }; },
    async run(request) { requests.push(request); const program = programs.shift();
      if (!program) throw new Error('A fixed test program must be queued');
      try { return { logs: [], value: await program(request.bindings[0].functions) }; }
      catch (error) { return { logs: [], error: { kind: 'exception', message: error.message } }; }
    } };
  if (mode !== 'native') ctx.provide('ptcRuntime', runtime);
  const tools = new ToolRuntime(ctx, { mode, maxParallelSubCalls: 8 });
  const compiled = config ? compileConfig(config) : undefined;
  const discovery = setupDiscovery && compiled ? new Discovery(tools, compiled, { typescript: renderToolsSdk, python: renderToolsSdkPy }) : undefined;
  if (discovery) {
    const definitions = discoveryTools(discovery); discovery.bindHelpers(definitions);
    for (const definition of definitions) tools.register(definition);
    tools.guard(exec => discovery.guard(exec));
    ctx.on('tools/result', (exec, result) => { discovery.settle(exec, result); });
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => discovery.present(await next(), context, runtime.language));
  }
  let nextSession = 0, nextCall = 0;
  function agent({ session, parent, cwd = process.cwd() } = {}) {
    const value = { session: session ?? sessions.create(`mcp-session-${++nextSession}`, { meta: { cwd } }) };
    value.ctx = createScope(parent?.ctx ?? ctx, value, parent ? { parent } : undefined).ctx;
    return value;
  }
  async function execute(scope, name, args = {}, signal = new AbortController().signal) {
    return tools.execute({ name, arguments: args, agent: scope, callId: `mcp-call-${++nextCall}`, signal });
  }
  async function ptc(scope, program) {
    programs.push(program);
    return execute(scope, 'run_code', { code: '// fixed test provider callback; never evaluates model source', description: 'MCP exposure fixture' });
  }
  // A standard durable native receipt, authored using the original message and
  // Session APIs. Tests use the normal pipeline's canonical returned result.
  function persistNative(scope, name, args, result) {
    const session = scope.session, callId = `persisted-${++nextCall}`;
    const turn = nextCall, step = nextCall;
    session.append('turn/start', { turn });
    session.append('step/start', { turn, step });
    const call = session.append('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) });
    const message = createToolResultMessage({ callId, content: result.content, isError: result.isError });
    session.append('tool/result', { turn, step, message, ...(result.meta ? { meta: result.meta } : {}) },
      { sourceEventSeqs: [call.seq], surfaceOp: 'append' });
    session.append('step/end', { turn, step });
    session.append('turn/end', { turn, reason: 'completed' });
  }
  return { ctx, prompt, tools, sessions, runtime, requests, compiled, discovery, agent, execute, ptc, persistNative,
    async close() { discovery?.dispose(); await ctx.fiber.dispose(); } };
}

export function definition(name, description = 'Read a fixed scoped value.', body = async () => ({ value: 'FIXED' })) {
  return { name, description, parameters: { type: 'object', properties: { key: { type: 'string' } }, additionalProperties: false },
    output: { schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    classifyExecution: () => ({ concurrencySafe: true }), execute: body };
}

export function value(result) { if (result.isError) throw new Error(JSON.stringify(result.error)); return result.value; }

export const connection = serverName => ({ transport: 'streamable-http', serverName, url: 'http://127.0.0.1:1/mcp', reconnect: { enabled: false } });
