import { randomUUID } from 'node:crypto';

export const name = 'rdsh-model-call';
export const inject = ['tools'];

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}
function argumentsFor(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !['prompt', 'provider', 'model'].includes(key)))
    throw fail('MODEL_CALL_ARGUMENTS', 'model_call accepts only prompt, provider and model');
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || Buffer.byteLength(raw.prompt, 'utf8') > 16384)
    throw fail('MODEL_CALL_ARGUMENTS', 'prompt must contain 1–16384 UTF-8 bytes');
  const hasProvider = Object.hasOwn(raw, 'provider');
  const hasModel = Object.hasOwn(raw, 'model');
  if (hasProvider !== hasModel) throw fail('MODEL_CALL_ROUTE', 'Supply provider and model together, or omit both to use the child default');
  for (const field of ['provider', 'model']) {
    if (hasProvider && (typeof raw[field] !== 'string' || !raw[field].trim() || raw[field].length > 200))
      throw fail('MODEL_CALL_ROUTE', `${field} must contain 1–200 characters`);
  }
  return { description: 'Delegated model workspace task', prompt: raw.prompt, run_in_background: false,
    ...(hasProvider ? { provider: raw.provider, model: raw.model } : {}) };
}

/** A transport alias: the existing scoped subagent keeps all execution policy. */
export function definition(tools) {
  if (typeof tools?.schemas !== 'function' || typeof tools?.execute !== 'function')
    throw fail('MODEL_CALL_RUNTIME', 'The DSH tools runtime is required');
  const active = new WeakSet();
  return {
    name: 'model_call',
    description: 'Delegate a task to a DSH child agent with the current workspace and inherited tools (including file reading/writing when permitted). Waits for its result. Use list_subagent_models before selecting provider and model; omit both to use configured child defaults. The existing DSH subagent model allowlist, depth limits, sandbox and permissions apply.',
    parameters: { type: 'object', properties: {
      prompt: { type: 'string', description: 'The complete delegated task, maximum 16384 UTF-8 bytes.' },
      provider: { type: 'string', description: 'An allowed provider from list_subagent_models; supply with model.' },
      model: { type: 'string', description: 'An allowed model from list_subagent_models; supply with provider.' },
    }, required: ['prompt'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { result: {}, content: { type: 'array', items: { type: 'object' } } },
        required: ['result', 'content'], additionalProperties: false },
      render: (_args, value) => value.content,
    },
    isConcurrencySafe: () => false,
    async execute(raw, exec) {
      const args = argumentsFor(raw);
      exec.signal.throwIfAborted();
      if (!exec.agent || typeof exec.agent !== 'object')
        throw fail('MODEL_CALL_AGENT', 'model_call requires the calling DSH agent');
      const schemas = tools.schemas(exec.agent);
      const target = Array.isArray(schemas) && schemas.find(tool => tool.name === 'subagent');
      if (!target) throw fail('MODEL_CALL_SUBAGENT_UNAVAILABLE', 'The calling agent has no subagent tool');
      if (args.provider && (!target.parameters?.properties?.provider || !target.parameters?.properties?.model))
        throw fail('MODEL_CALL_SELECTION_DISABLED', 'Enable subagent-model-selection-settings and choose allowed models in DSH settings before selecting a child route');
      if (active.has(exec.agent)) throw fail('MODEL_CALL_REENTRANT', 'Recursive alias dispatch on the same agent is not supported');
      active.add(exec.agent);
      try {
        const nested = await tools.execute({
          callId: `${exec.callId}:model-call:${randomUUID()}`, rootCallId: exec.rootCallId,
          name: 'subagent', arguments: args, agent: exec.agent, parent: exec.token, signal: exec.signal,
        });
        for (const context of nested.additionalContexts ?? []) exec.deferContext(context);
        if (nested.isError) {
          const error = fail(nested.error?.info?.code ?? 'MODEL_CALL_FAILED', nested.error?.message ?? 'DSH subagent failed');
          if (nested.error?.info?.name) error.name = nested.error.info.name;
          throw error;
        }
        exec.signal.throwIfAborted();
        if (nested.concludesTurn === true) exec.concludeTurn();
        return { result: nested.value, content: nested.content };
      } finally {
        active.delete(exec.agent);
      }
    },
  };
}

export function apply(ctx) {
  const dispose = ctx.tools.register(definition(ctx.tools));
  return ctx.effect(() => dispose);
}
