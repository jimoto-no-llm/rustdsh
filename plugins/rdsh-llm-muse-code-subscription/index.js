import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { MODELS, BridgeError } from './protocol.mjs';
import { runWorker } from './runner.mjs';

export const name = 'llm-muse-code-subscription';
export const inject = ['llm', 'sessions'];
const labels = ['Muse Wonder · Muse Code 定額', 'Muse Wonder Full · Muse Code 定額'];

export class MuseSubscriptionAdapter extends LlmAdapter {
  constructor(ctx, config = {}) { super(); this.ctx = ctx; this.config = config; this.active = new Map(); }
  providerInfo(provider) { return { id: provider, name: 'Muse Code · 定額契約' }; }
  providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'muse-code'); }
  async listModels(provider) {
    return MODELS.map((id, index) => ({ provider, id, name: labels[index], inputModalities: ['text'], description: 'Muse Code SDK compatibility route; Harness executes tools' }));
  }
  async resolveModel(provider, model) {
    if (!MODELS.includes(model)) throw new LlmError('Unsupported Muse Code model', 'UNKNOWN_MODEL');
    return { ...(await this.listModels(provider)).find(item => item.id === model), context: { contextWindow: 1048576 }, defaultMaxTokens: 32768,
      reasoning: { defaultEffort: 'high', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id, name: id })) } };
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
        runtime: { museCommand: this.config.museCommand, authFile: this.config.authFile },
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
  }
}

export function apply(ctx, config) {
  const adapter = new MuseSubscriptionAdapter(ctx, config);
  const unregister = ctx.llm.registerAdapter(['muse-code'], adapter);
  ctx.on('dispose', async () => { unregister(); await adapter.dispose(); });
}
