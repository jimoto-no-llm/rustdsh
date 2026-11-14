// rdsh-llm-native: provider routes that speak the OpenAI Responses API and use
// the provider's own compaction (`/responses/compact`). DSH is not modified:
// the adapter registers through `ctx.llm`, and a compacted window travels in
// the replay state DSH already stores beside each assistant message.
import z from '@deepseek-ai/schemastery';
import { LlmAdapter, attributionHeaders, normalizeApiKey } from '@deepseek-ai/dsh-llm';
import { createAdapter, checkProviders } from './adapter.mjs';

export const name = 'rdsh-llm-native';
export const inject = ['llm'];

export const Config = z.object({
  providers: z.dict(z.object({
    displayName: z.string(),
    baseURL: z.string().required(),
    api: z.string(),
    apiKeyEnv: z.string(),
    models: z.array(z.object({
      id: z.string().required(), name: z.string(), contextWindow: z.number(), maxTokens: z.number(),
      compactAtTokens: z.number(), compactInBackground: z.boolean(), pauseAfterCompaction: z.boolean(),
      compaction: z.string(),
    })).required(),
  })).default({}),
});

export function apply(ctx, config) {
  const providers = checkProviders(config.providers ?? {});
  const routes = Object.keys(providers);
  if (routes.length === 0) return;
  const adapter = createAdapter({ LlmAdapter, providers, headers: attributionHeaders,
    key(envName) {
      const raw = process.env[envName];
      if (raw === undefined) return undefined;
      const checked = normalizeApiKey(raw);
      return checked.ok ? checked.value : undefined;
    },
    warn: message => ctx.logger?.warn?.(message) });
  ctx.llm.registerAdapter(routes, adapter);
}
