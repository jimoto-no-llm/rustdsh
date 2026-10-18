#!/usr/bin/env node
// One bounded DeepInfra API burst across distinct chat models. It does not run agents.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const BASE = 'https://api.deepinfra.com';
const PROMPT = '1';
const MAX_OUTPUT_TOKENS = 1;
const PILOT_BATCH = 10;
const MAX_PILOTS = 70;
const TARGET_MODELS = 50;

function options() {
  const pairs = process.argv.slice(2);
  if (pairs.length % 2 !== 0) throw new Error('Expected --name value pairs');
  const args = Object.fromEntries(Array.from({ length: pairs.length / 2 }, (_, i) =>
    [pairs[2 * i], pairs[2 * i + 1]]));
  const allowed = ['--key-file', '--out', '--max-requests', '--budget-usd', '--seconds', '--max-in-flight'];
  if (Object.keys(args).length !== pairs.length / 2 ||
      Object.keys(args).some((x) => !allowed.includes(x))) throw new Error('Unknown or duplicate option');
  const config = {
    keyFile: args['--key-file'], out: args['--out'],
    maxRequests: Number(args['--max-requests'] ?? 10_000),
    budgetUsd: Number(args['--budget-usd'] ?? 0.0266),
    seconds: Number(args['--seconds'] ?? 900),
    maxInFlight: Number(args['--max-in-flight'] ?? 256),
  };
  if (!config.keyFile || !config.out || !Number.isSafeInteger(config.maxRequests) ||
      config.maxRequests < 1 || config.maxRequests > 10_000 ||
      !Number.isFinite(config.budgetUsd) || config.budgetUsd <= 0 || config.budgetUsd > 0.0266 ||
      !Number.isSafeInteger(config.seconds) || config.seconds < 30 || config.seconds > 1800 ||
      !Number.isSafeInteger(config.maxInFlight) || config.maxInFlight < 1 ||
      config.maxInFlight > 10_000) {
    throw new Error('Usage: --key-file PATH --out PATH [--max-requests 10000] [--budget-usd 0.0266] [--seconds 900] [--max-in-flight 256]');
  }
  return config;
}

function readKey(path) {
  const line = readFileSync(path, 'utf8').split(/\r?\n/)
    .find((item) => /^\s*DEEPINFRA_API_KEY=/.test(item));
  const key = line?.split('=').slice(1).join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!key) throw new Error('DeepInfra key file is unavailable or empty');
  return key;
}

function assertResponse(response, name) {
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
  return response.json();
}

const config = options();
const key = readKey(config.keyFile);
const headers = { authorization: `Bearer ${key}` };
const begun = performance.now();
const deadline = begun + config.seconds * 1000;
const [limits, catalog] = await Promise.all([
  fetch(`${BASE}/v1/me/rate_limit`, { headers, signal: AbortSignal.timeout(20_000) })
    .then((r) => assertResponse(r, 'Rate limit query')),
  fetch(`${BASE}/v1/openai/models`, { headers, signal: AbortSignal.timeout(20_000) })
    .then((r) => assertResponse(r, 'Model catalog query')),
]);
const perModelLimit = limits.rate_limit;
const tpmLimit = limits.tpm_rate_limit;
if (!Number.isSafeInteger(perModelLimit) || perModelLimit < 1 ||
    !Number.isSafeInteger(tpmLimit) || tpmLimit < 1 || !Array.isArray(catalog.data)) {
  throw new Error('Account limits or model catalog are incomplete');
}
const models = catalog.data.filter((m) => m.metadata?.tags?.includes('chat') &&
  Number.isFinite(m.metadata?.pricing?.input_tokens) &&
  Number.isFinite(m.metadata?.pricing?.output_tokens) &&
  m.metadata.pricing.input_tokens >= 0 && m.metadata.pricing.output_tokens >= 0)
  .map((m) => ({ id: m.id, inputPrice: m.metadata.pricing.input_tokens,
    outputPrice: m.metadata.pricing.output_tokens }))
  .sort((a, b) => (15 * a.inputPrice + a.outputPrice) -
    (15 * b.inputPrice + b.outputPrice));

const state = {
  attempted: 0, http200: 0, usable: 0, rateLimited: 0,
  httpErrors: {}, transportUnknown: 0, transportErrors: {}, serverUnknown: 0,
  missingCost: 0, modelMismatch: 0,
  knownCostUsd: 0, unknownReserveUsd: 0, currentInFlight: 0, peakClientInFlight: 0,
  completed: 0, activeByModel: new Map(),
};

function round(value) { return Number(value.toFixed(8)); }
function price(model, inputTokens, outputTokens = MAX_OUTPUT_TOKENS) {
  return (inputTokens * model.inputPrice + outputTokens * model.outputPrice) / 1_000_000;
}
function reserve(model, pilot) {
  if (!pilot) return price(model, 64);
  const observedInput = Math.max(1, pilot.promptTokens || 15);
  return Math.max(price(model, observedInput + 2), pilot.cost * 1.10);
}

async function call(model, reservedUsd) {
  if (state.attempted >= config.maxRequests) throw new Error('Request cap reached');
  state.attempted++;
  state.currentInFlight++;
  state.peakClientInFlight = Math.max(state.peakClientInFlight, state.currentInFlight);
  state.activeByModel.set(model.id, (state.activeByModel.get(model.id) || 0) + 1);
  try {
    const response = await fetch(`${BASE}/v1/openai/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.id,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: MAX_OUTPUT_TOKENS, temperature: 0 }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => null);
    if (response.status === 429) {
      state.rateLimited++;
      return { kind: 'rate_limited' };
    }
    if (response.status >= 500 || (response.ok && !body)) {
      state.httpErrors[response.status] = (state.httpErrors[response.status] || 0) + 1;
      state.serverUnknown++;
      state.unknownReserveUsd += reservedUsd;
      return { kind: 'server_unknown', status: response.status };
    }
    if (!response.ok) {
      state.httpErrors[response.status] = (state.httpErrors[response.status] || 0) + 1;
      return { kind: 'http_error', status: response.status };
    }
    if (body.model !== model.id) {
      state.modelMismatch++;
      return { kind: 'model_mismatch', receivedModel: body.model || null };
    }
    const cost = body.usage?.estimated_cost;
    if (!Number.isFinite(cost) || cost < 0) {
      state.missingCost++;
      state.unknownReserveUsd += reservedUsd;
      return { kind: 'missing_cost' };
    }
    state.knownCostUsd += cost;
    state.http200++;
    const usable = typeof body.choices?.[0]?.message?.content === 'string' &&
      body.choices[0].message.content.trim().length > 0;
    if (usable) state.usable++;
    return { kind: 'success', cost, usable,
      promptTokens: body.usage?.prompt_tokens || 0,
      completionTokens: body.usage?.completion_tokens || 0 };
  } catch (error) {
    state.transportUnknown++;
    state.unknownReserveUsd += reservedUsd;
    const name = String(error?.name || 'unknown').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    const code = String(error?.cause?.code || 'none').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    const errorClass = `${name}:${code}`;
    state.transportErrors[errorClass] = (state.transportErrors[errorClass] || 0) + 1;
    return { kind: 'transport_unknown', errorClass };
  } finally {
    state.currentInFlight--;
    state.activeByModel.set(model.id, state.activeByModel.get(model.id) - 1);
    state.completed++;
  }
}

const pilotResults = [];
for (let offset = 0; offset < Math.min(models.length, MAX_PILOTS) &&
     pilotResults.length < TARGET_MODELS && state.attempted < config.maxRequests;
     offset += PILOT_BATCH) {
  if (performance.now() >= deadline) break;
  const batch = models.slice(offset, offset + PILOT_BATCH)
    .slice(0, config.maxRequests - state.attempted);
  const pilotReserve = batch.reduce((sum, model) => sum + reserve(model), 0);
  if (state.knownCostUsd + state.unknownReserveUsd + pilotReserve > config.budgetUsd) break;
  const results = await Promise.all(batch.map((model) => call(model, reserve(model))));
  for (let i = 0; i < batch.length; i++) {
    if (results[i].kind === 'success') pilotResults.push({ model: batch[i], pilot: results[i] });
  }
  console.log(JSON.stringify({ phase: 'pilot', attempted: state.attempted,
    eligible: pilotResults.length, knownCostUsd: round(state.knownCostUsd) }));
}
const pilotAttempted = state.attempted;

const eligible = pilotResults.sort((a, b) => reserve(a.model, a.pilot) -
  reserve(b.model, b.pilot)).slice(0, TARGET_MODELS);
const selectedIds = new Set(eligible.map((item) => item.model.id));
const fallbackPool = pilotResults.filter((item) => !selectedIds.has(item.model.id))
  .slice(0, 2);
for (const item of eligible) {
  if (fallbackPool.length >= 2) break;
  fallbackPool.push(item);
}
let fallbackSlots = fallbackPool.length >= 2
  ? Math.min(100, Math.floor((config.maxRequests - state.attempted) / 10)) : 0;
const fallbackReservePerCall = fallbackPool.length
  ? Math.max(...fallbackPool.map((item) => reserve(item.model, item.pilot))) : 0;
const fallbackTokenReserve = fallbackPool.length
  ? Math.max(...fallbackPool.map((item) =>
    Math.max(1, item.pilot.promptTokens || 15) + MAX_OUTPUT_TOKENS + 2)) : 0;
while (fallbackSlots > 0 && state.knownCostUsd + state.unknownReserveUsd +
       fallbackSlots * fallbackReservePerCall > config.budgetUsd) fallbackSlots--;
const planned = [];
let reservedBurstUsd = 0;
let reservedTokens = 0;
const remaining = Math.max(0, config.maxRequests - state.attempted - fallbackSlots);
if (performance.now() < deadline) {
  for (const item of eligible) {
    const perRequestReserve = reserve(item.model, item.pilot);
    const tokenReserve = Math.max(1, item.pilot.promptTokens || 15) + MAX_OUTPUT_TOKENS + 2;
    for (let i = 0; i < perModelLimit && planned.length < remaining; i++) {
      if (state.knownCostUsd + state.unknownReserveUsd + reservedBurstUsd +
          fallbackSlots * fallbackReservePerCall + perRequestReserve > config.budgetUsd) break;
      if (reservedTokens + fallbackSlots * fallbackTokenReserve + tokenReserve > tpmLimit) break;
      planned.push({ model: item.model, reservedUsd: perRequestReserve });
      reservedBurstUsd += perRequestReserve;
      reservedTokens += tokenReserve;
    }
  }
}
// Round-robin prevents the first wave from filling only the cheapest few models.
const grouped = new Map();
for (const job of planned) {
  if (!grouped.has(job.model.id)) grouped.set(job.model.id, []);
  grouped.get(job.model.id).push(job);
}
const balancedPlan = [];
while (balancedPlan.length < planned.length) {
  for (const jobs of grouped.values()) {
    if (jobs.length) balancedPlan.push(jobs.pop());
  }
}
console.log(JSON.stringify({ phase: 'plan', availableModels: catalog.data.length,
  chatModelsWithPrices: models.length, pilotAttempted: state.attempted,
  pilotEligible: pilotResults.length, selectedModels: eligible.length,
  plannedBurst: planned.length, fallbackSlots,
  plannedTotalRequests: state.attempted + planned.length + fallbackSlots,
  reservedBurstUsd: round(reservedBurstUsd),
  reservedFallbackUsd: round(fallbackSlots * fallbackReservePerCall),
  accountPerModelLimit: perModelLimit, accountTpmLimit: tpmLimit }));

let completedBurst = 0;
const progressTimer = setInterval(() => {
  console.log(JSON.stringify({ phase: 'burst_progress', completed: completedBurst,
    total: planned.length, http200: state.http200, transportUnknown: state.transportUnknown }));
}, 10_000);
const burstResults = [];
let nextJob = 0;
let stopReason = null;
let fallbackAttempted = 0;
let fallbackUnavailable = 0;
let tailAttempted = 0;
function record(model, result, phase) {
  completedBurst++;
  burstResults.push({ model: model.id, kind: result.kind, phase,
    usable: result.usable || false, cost: result.cost || 0 });
  if (result.kind === 'transport_unknown' || result.kind === 'server_unknown' ||
      result.kind === 'missing_cost' || result.kind === 'model_mismatch') {
    stopReason ||= `unreconciled_${result.kind}`;
  } else if (result.kind === 'http_error' && (result.status === 401 || result.status === 403)) {
    stopReason ||= 'authentication_error';
  }
}
function chooseFallback(excludeId) {
  return fallbackPool.find((item) => item.model.id !== excludeId &&
    (state.activeByModel.get(item.model.id) || 0) < perModelLimit);
}
async function worker() {
  while (!stopReason && nextJob < balancedPlan.length && performance.now() < deadline) {
    const { model, reservedUsd } = balancedPlan[nextJob++];
    const result = await call(model, reservedUsd);
    record(model, result, 'primary');
    if (result.kind !== 'rate_limited' || stopReason || fallbackAttempted >= fallbackSlots) continue;
    const alternate = chooseFallback(model.id);
    if (!alternate) { fallbackUnavailable++; continue; }
    fallbackAttempted++;
    const fallbackResult = await call(alternate.model, fallbackReservePerCall);
    record(alternate.model, fallbackResult, 'fallback');
  }
}
await Promise.all(Array.from({ length: Math.min(config.maxInFlight, balancedPlan.length) },
  () => worker()));
// Unused fallback slots can be spent on new independent requests, never on unknown outcomes.
if (!stopReason && nextJob === balancedPlan.length) {
  const tailJobs = Array.from({ length: fallbackSlots - fallbackAttempted }, (_, i) =>
    fallbackPool[i % fallbackPool.length]);
  let nextTail = 0;
  async function tailWorker() {
    while (!stopReason && nextTail < tailJobs.length && performance.now() < deadline) {
      const item = tailJobs[nextTail++];
      tailAttempted++;
      const result = await call(item.model, fallbackReservePerCall);
      record(item.model, result, 'tail');
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.maxInFlight, tailJobs.length) },
    () => tailWorker()));
}
clearInterval(progressTimer);

const byModel = {};
for (const result of burstResults) {
  const model = byModel[result.model] ||= { attempted: 0, http200: 0, usable: 0,
    errors: {}, knownCostUsd: 0 };
  model.attempted++;
  if (result.kind === 'success') {
    model.http200++;
    model.usable += Number(result.usable);
    model.knownCostUsd += result.cost;
  } else model.errors[result.kind] = (model.errors[result.kind] || 0) + 1;
}
for (const model of Object.values(byModel)) model.knownCostUsd = round(model.knownCostUsd);
const summary = {
  date: new Date().toISOString(), scope: 'direct_deepinfra_chat_api_only',
  prompt: PROMPT, maxOutputTokens: MAX_OUTPUT_TOKENS,
  maxRequests: config.maxRequests, maxInFlight: config.maxInFlight,
  budgetUsd: config.budgetUsd,
  accountPerModelLimit: perModelLimit, accountTpmLimit: tpmLimit,
  availableModels: catalog.data.length, chatModelsWithPrices: models.length,
  pilotAttempted,
  pilotEligible: pilotResults.length, selectedModels: eligible.length,
  plannedBurst: planned.length, primaryAttempted: nextJob,
  fallbackSlots, fallbackAttempted, fallbackUnavailable, tailAttempted,
  stopReason: stopReason || (performance.now() >= deadline ? 'duration_limit' : 'complete'),
  reservedBurstUsd: round(reservedBurstUsd),
  reservedFallbackUsd: round(fallbackSlots * fallbackReservePerCall),
  attempted: state.attempted, http200: state.http200, usable: state.usable,
  rateLimited: state.rateLimited, httpErrors: state.httpErrors,
  transportUnknown: state.transportUnknown, transportErrors: state.transportErrors,
  serverUnknown: state.serverUnknown,
  missingCost: state.missingCost,
  modelMismatch: state.modelMismatch,
  peakClientInFlight: state.peakClientInFlight,
  knownCostUsd: round(state.knownCostUsd),
  unknownReserveUsd: round(state.unknownReserveUsd),
  elapsedSeconds: Math.round((performance.now() - begun) / 1000),
  byModel,
  serverSideConcurrencyMeasured: false,
  sandboxesCreated: 0,
  agentLoopsStarted: 0,
};
writeFileSync(config.out, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ phase: 'final', ...Object.fromEntries(Object.entries(summary)
  .filter(([key]) => key !== 'byModel')) }));
if (state.attempted < config.maxRequests || state.http200 < config.maxRequests) process.exitCode = 2;
