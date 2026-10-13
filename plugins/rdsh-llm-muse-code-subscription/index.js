import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { BridgeError } from './protocol.mjs';
import { runWorker } from './runner.mjs';

export const name = 'llm-muse-code-subscription';
export const inject = ['llm', 'sessions'];
const providers = ['muse-code', 'muse-code-contributor'];
const mode = provider => {
  if (!providers.includes(provider)) throw new LlmError('Unsupported Muse Code provider', 'UNKNOWN_PROVIDER');
  return provider === 'muse-code-contributor' ? 'on' : 'off';
};
const label = row => row.displayLabel !== row.modelId ? row.displayLabel : row.modelId.split('-').map(word => word ? word[0].toUpperCase() + word.slice(1) : word).join(' ');

export class MuseSubscriptionAdapter extends LlmAdapter {
  constructor(ctx, config = {}) { super(); this.ctx = ctx; this.config = config; this.active = new Map(); this.catalogs = new Map(); this.pending = new Map(); }
  providerInfo(provider) { return { id: provider, name: mode(provider) === 'on' ? 'Muse Code · Contributor（学習利用）' : 'Muse Code · 定額契約' }; }
  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'muse-code'); }
  runtime() { return { museCommand: this.config.museCommand, authFile: this.config.authFile }; }
  async listModels(provider) {
    const contributorMode = mode(provider);
    const cached = this.catalogs.get(provider);
    if (cached?.expires > Date.now()) return cached.models;
    if (this.pending.has(provider)) return this.pending.get(provider);
    const controller = new AbortController();
    const request = runWorker({ operation: 'list-models', contributorMode, runtime: this.runtime() }, this.config, controller.signal);
    this.active.set(controller, request.then(() => {}, () => {}));
    const pending = request.then(({ catalog }) => {
      const models = catalog.models.map(row => ({ provider, id: row.modelId,
        name: label(row) + (contributorMode === 'on' ? ' · Contributor（学習利用）' : ' · Muse Code 定額'), inputModalities: ['text'],
        description: row.description ?? 'Muse Code SDK compatibility route; Harness executes tools',
        ...(row.contextLimit !== null ? { context: { contextWindow: row.contextLimit } } : {}),
        ...(row.outputLimit !== null ? { defaultMaxTokens: row.outputLimit } : {}),
        ...(Array.isArray(row.variants) && row.variants.length ? { reasoning: { defaultEffort: row.defaultReasoningEffort, efforts: row.variants.map(id => ({ id, name: id })) } } : {}) }));
      this.catalogs.set(provider, { models, expires: Date.now() + 60000 });
      return models;
    }).catch(error => { throw new LlmError(error instanceof BridgeError ? error.message : 'Muse Code catalog unavailable', error instanceof BridgeError ? error.code : 'MUSE_UNAVAILABLE'); })
      .finally(() => { this.pending.delete(provider); this.active.delete(controller); });
    this.pending.set(provider, pending);
    return pending;
  }
  async resolveModel(provider, model) {
    const resolved = (await this.listModels(provider)).find(item => item.id === model);
    if (!resolved) throw new LlmError('Unsupported Muse Code model', 'UNKNOWN_MODEL');
    return resolved;
  }
  async *stream(options) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });
    this.active.set(controller, completed);
    try {
      const session = options.sessionId ? this.ctx.sessions.get(options.sessionId) : null;
      const result = await runWorker({
        model: options.model, reasoningEffort: options.reasoningEffort, system: options.system,
        messages: options.messages.map(message => ({ role: message.role, content: message.content })), tools: options.tools ?? [],
        executionWorkspace: session?.header.cwd,
        contributorMode: mode(options.provider ?? 'muse-code'), runtime: this.runtime(),
      }, this.config, controller.signal);
      // The helper has exited. Disposal must not wait for a consumer paused at
      // a yield while rendering the already buffered answer.
      this.active.delete(controller); complete();
      let index = 0;
      if (result.response.text) {
        yield { type: 'block-start', index, blockType: 'text' };
        yield { type: 'text-delta', index, text: result.response.text };
        yield { type: 'block-end', index: index++, block: { type: 'text', text: result.response.text } };
      }
      for (const call of result.response.toolCalls) {
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments };
        yield { type: 'block-end', index: index++, block: { type: 'tool-call', ...call } };
      }
      if (result.tokenUsage) yield { type: 'usage', usage: result.tokenUsage };
      yield { type: 'finish', reason: { kind: result.response.toolCalls.length ? 'tool-calls' : 'stop' } };
    } catch (error) {
      this.active.delete(controller); complete();
      if (error instanceof BridgeError && error.code === 'ABORTED') {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: error.message } } };
      } else throw new LlmError(error instanceof BridgeError ? error.message : 'Muse Code helper failed', error instanceof BridgeError ? error.code : 'MUSE_UNAVAILABLE');
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.active.delete(controller); complete();
    }
  }
  async dispose() {
    const requests = [...this.active];
    for (const [controller] of requests) controller.abort();
    await Promise.all(requests.map(([, completed]) => completed));
    this.catalogs.clear();
  }
}

export function apply(ctx, config) {
  const adapter = new MuseSubscriptionAdapter(ctx, config);
  const unregister = ctx.llm.registerAdapter(providers, adapter);
  ctx.on('dispose', async () => { unregister(); await adapter.dispose(); });
}
