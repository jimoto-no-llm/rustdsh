import { readFileSync } from 'node:fs';

export function readProviderKey(path, provider) {
  const content = readFileSync(path, 'utf8');
  if (provider === 'openrouter') {
    const keys = [...new Set(content.match(/sk-or-v1-[A-Za-z0-9_-]+/g) ?? [])];
    if (keys.length !== 1) throw new Error('Expected one OpenRouter key in the key file');
    return keys[0];
  }
  const line = content.split(/\r?\n/).find((line) => /^\s*DEEPINFRA_API_KEY=/.test(line));
  const key = line?.split('=').slice(1).join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!key) throw new Error('DeepInfra key unavailable');
  return key;
}

export function selectPlans(orCatalog, diCatalog, { orModels, diModels, perModel,
  maxInputPrice, maxOutputPrice }) {
  const ors = orCatalog.data.filter((m) => m.architecture?.output_modalities?.includes('text') &&
    !/:(free|batch)|^~|guard|moderation|safety/i.test(m.id) &&
    m.supported_parameters?.includes('max_tokens') && Number(m.pricing?.prompt) > 0 &&
    Number(m.pricing?.completion) > 0 && Number(m.pricing?.request || 0) === 0)
    .sort((a, b) => (32 * Number(a.pricing.prompt) + Number(a.pricing.completion)) -
      (32 * Number(b.pricing.prompt) + Number(b.pricing.completion))).slice(0, orModels);
  const dis = diCatalog.data.filter((m) => m.metadata?.tags?.includes('chat') &&
    Number.isFinite(m.metadata?.pricing?.input_tokens) && Number.isFinite(m.metadata?.pricing?.output_tokens) &&
    m.metadata.pricing.input_tokens >= 0 && m.metadata.pricing.output_tokens >= 0 &&
    !/guard|safety|moderation/i.test(m.id)).sort((a, b) =>
    (32 * a.metadata.pricing.input_tokens + a.metadata.pricing.output_tokens) -
    (32 * b.metadata.pricing.input_tokens + b.metadata.pricing.output_tokens)).slice(0, diModels);
  if (ors.length !== orModels || dis.length !== diModels) throw new Error('Insufficient priced models');
  const plans = [];
  for (const [provider, models] of [['openrouter', ors], ['deepinfra', dis]]) {
    for (const [modelIndex, model] of models.entries()) {
      const input = provider === 'openrouter' ? Number(model.pricing.prompt) : model.metadata.pricing.input_tokens / 1e6;
      const output = provider === 'openrouter' ? Number(model.pricing.completion) : model.metadata.pricing.output_tokens / 1e6;
      const body = { model: model.id, messages: [{ role: 'user', content: '1' }], max_tokens: 1 };
      let allowedModels = [model.id, model.canonical_slug].filter(Boolean);
      let reservedInput = input;
      let reservedOutput = output;
      if (provider === 'openrouter') {
        reservedInput = maxInputPrice == null ? input : maxInputPrice / 1e6;
        reservedOutput = maxOutputPrice == null ? output : maxOutputPrice / 1e6;
        body.provider = { allow_fallbacks: true, require_parameters: true,
          max_price: { prompt: reservedInput * 1e6 * (1 + 1e-9), completion: reservedOutput * 1e6 * (1 + 1e-9), request: 0 } };
        if (maxInputPrice != null && maxOutputPrice != null) {
          // OpenRouter validates at most three entries including the primary.
          const routed = [...new Set([0, 7, 17].map((offset) => models[(modelIndex + offset) % models.length]))];
          body.models = routed.map((m) => m.id);
          delete body.model;
          allowedModels = routed.flatMap((m) => [m.id, m.canonical_slug].filter(Boolean));
        }
      }
      plans.push({ provider, model: model.id, count: perModel,
        allowedModels: [...new Set(allowedModels)],
        reserveUsd: 1.10 * (32 * reservedInput + reservedOutput), body });
    }
  }
  return plans;
}

export async function preflight(keyFiles, options) {
  const keys = Object.fromEntries(Object.entries(keyFiles).map(([provider, path]) => [provider, readProviderKey(path, provider)]));
  const queries = [
    ['orModels', 'https://openrouter.ai/api/v1/models', 'openrouter'],
    ['orKey', 'https://openrouter.ai/api/v1/key', 'openrouter'],
    ['orCredits', 'https://openrouter.ai/api/v1/credits', 'openrouter'],
    ['diModels', 'https://api.deepinfra.com/v1/openai/models', 'deepinfra'],
    ['diLimits', 'https://api.deepinfra.com/v1/me/rate_limit', 'deepinfra'],
  ];
  const result = await Promise.allSettled(queries.map(async ([, url, provider]) => {
    const response = await fetch(url, { headers: { authorization: `Bearer ${keys[provider]}` },
      signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('Provider preflight query failed');
    return response.json();
  }));
  if (result.some((r) => r.status === 'rejected')) throw new Error('Provider preflight incomplete; no chat requests sent');
  const data = Object.fromEntries(queries.map(([name], i) => [name, result[i].value]));
  const plans = selectPlans(data.orModels, data.diModels, options);
  const reservedTotalUsd = plans.reduce((sum, plan) => sum + plan.count * plan.reserveUsd, 0);
  const orReserved = plans.filter((p) => p.provider === 'openrouter').reduce((sum, p) => sum + p.count * p.reserveUsd, 0);
  const orRemaining = data.orCredits.data.total_credits - data.orCredits.data.total_usage;
  const keyRemaining = data.orKey.data.limit_remaining;
  const effectiveRemaining = data.orKey.data.effective_budget?.remaining_usd;
  if (!(reservedTotalUsd <= options.budgetUsd) || !(orRemaining >= orReserved) ||
      (keyRemaining != null && !(keyRemaining >= orReserved)) ||
      (effectiveRemaining != null && !(effectiveRemaining >= orReserved)) ||
      (options.diModels > 0 && !(data.diLimits.rate_limit >= options.perModel)) ||
      !(data.diLimits.tpm_rate_limit >= options.diModels * options.perModel * 33))
    throw new Error('Insufficient budget or capacity; no chat requests sent');
  return { plans, reservedTotalUsd, preflight: {
    checkedAt: new Date().toISOString(), openrouterBalanceUsd: orRemaining,
    openrouterKeyRemainingUsd: keyRemaining, deepinfraPerModelLimit: data.diLimits.rate_limit,
    deepinfraTpmLimit: data.diLimits.tpm_rate_limit } };
}
