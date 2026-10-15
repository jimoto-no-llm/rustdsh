import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCursorSdkBackend } from './cursor-sdk.mjs';
import { createAgySdkBackend } from './agy-sdk.mjs';
import { registerDevinTool } from './devin-tool.mjs';

async function loadLlmRuntime() {
  const locations = [import.meta.url, pathToFileURL(join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/package.json')).href];
  for (const location of locations) {
    let resolved;
    try { resolved = createRequire(location).resolve('@deepseek-ai/dsh-llm'); } catch { continue; }
    return import(pathToFileURL(resolved).href);
  }
  throw new Error('rdsh-direct-models requires the installed DSH LLM runtime');
}
const { LlmAdapter, resolveRetryPolicy } = await loadLlmRuntime();
export const name = 'rdsh-direct-models';
export const inject = ['llm', 'tools', 'credentials'];
export const providers = ['cursor-sdk', 'agy-sdk'];
const labels = { 'cursor-sdk': 'Cursor (official SDK, rdsh tools)', 'agy-sdk': 'Antigravity (official SDK, rdsh tools)' };

function defaultBackends({ keyResolver } = {}) {
  return { 'cursor-sdk': createCursorSdkBackend(), 'agy-sdk': createAgySdkBackend({ keyResolver }) };
}

function normalizeUsage(usage) {
  if (!usage) return undefined;
  const count = key => {
    const value = Number(usage[key] ?? 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('SDK backend returned invalid token usage');
    return value;
  };
  return { inputTokens: count('inputTokens'), outputTokens: count('outputTokens'), ...Object.fromEntries(['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'].filter(key => key in usage).map(key => [key, count(key)])) };
}

export class DirectModelsAdapter extends LlmAdapter {
  constructor({ backends = defaultBackends() } = {}) { super(); this.backends = backends; }
  backend(provider) {
    const backend = this.backends[provider];
    if (!backend) throw new Error('Unknown SDK provider route');
    return backend;
  }
  providerInfo(provider) { this.backend(provider); return { id: provider, name: labels[provider] ?? provider }; }
  providerRetryPolicy(provider) { this.backend(provider); return resolveRetryPolicy({mode:'normal',maxRetries:0}, 'rdsh-direct-models'); }
  async listModels(provider) {
    const models = await this.backend(provider).discover();
    if (!Array.isArray(models)) throw new Error('SDK backend returned an invalid model catalog');
    return models.map(model => {
      if (!model || typeof model.id !== 'string' || !model.id) throw new Error('SDK backend returned an invalid model ID');
      return { provider, id: model.id, name: model.name ?? model.id, inputModalities: ['text'] };
    });
  }
  async resolveModel(provider, model, signal) {
    signal?.throwIfAborted();
    this.backend(provider);
    return { provider, id: model, name: model, inputModalities: ['text'] };
  }
  async *stream(options) {
    options.signal?.throwIfAborted();
    const backend = this.backend(options.provider);
    const result = await backend.generate({ ...options, messages: options.messages ?? [] });
    options.signal?.throwIfAborted();
    if (!result || typeof result.text !== 'string' || !Array.isArray(result.toolCalls)) throw new Error('SDK backend returned an invalid generation');
    const allowed = new Set((options.tools ?? []).map(tool => tool.name));
    const seen = new Set();
    for (const call of result.toolCalls) {
      if (!call || typeof call.id !== 'string' || !call.id || seen.has(call.id) || !allowed.has(call.name) || typeof call.arguments !== 'string') throw new Error('SDK backend returned an invalid tool call');
      let args;
      try { args = JSON.parse(call.arguments); } catch { throw new Error('SDK backend returned invalid tool JSON'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('SDK backend returned invalid tool arguments');
      seen.add(call.id);
    }
    if (!result.text && !result.toolCalls.length) throw new Error('SDK backend returned an empty generation');
    const usage = normalizeUsage(result.usage);
    let index = 0;
    if (result.text) {
      yield { type: 'block-start', index, blockType: 'text' };
      yield { type: 'text-delta', index, text: result.text };
      yield { type: 'block-end', index, block: { type: 'text', text: result.text } };
      index++;
    }
    for (const call of result.toolCalls) {
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments };
      yield { type: 'block-end', index, block: { type: 'tool-call', ...call } };
      index++;
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'finish', reason: { kind: result.toolCalls.length ? 'tool-calls' : 'stop' }, ...(result.replayState ? { replayState: { response: result.replayState } } : {}) };
  }
}

export function apply(ctx) {
  const keyResolver = async () => (await ctx.credentials.resolve('GEMINI_API_KEY'))?.value ?? (await ctx.credentials.resolve('GOOGLE_API_KEY'))?.value;
  const unregisterAdapter = ctx.llm.registerAdapter(providers, new DirectModelsAdapter({ backends: defaultBackends({ keyResolver }) }));
  const unregisterTool = registerDevinTool(ctx);
  return () => { unregisterTool?.(); unregisterAdapter?.(); };
}
