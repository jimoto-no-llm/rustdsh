#!/usr/bin/env node
// Bounded, credential-safe DeepInfra API load test. This does not create agents or sandboxes.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';
const URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
const PROMPT = 'Reply with READY only.';
const MAX_OUTPUT_TOKENS = 8;
// Official standard-tier prices per million tokens, checked 2026-10-18.
const INPUT_USD_PER_M = 0.02;
const OUTPUT_USD_PER_M = 0.04;
// A conservative reservation for the fixed prompt and bounded output.
const RESERVE_USD = (64 * INPUT_USD_PER_M + MAX_OUTPUT_TOKENS * OUTPUT_USD_PER_M) / 1_000_000;

function options() {
  const args = Object.fromEntries(Array.from({ length: process.argv.length - 2 }, (_, i) => i)
    .filter((i) => i % 2 === 0)
    .map((i) => [process.argv[i + 2], process.argv[i + 3]]));
  const result = {
    keyFile: args['--key-file'],
    maxSuccess: Number(args['--max-success'] ?? 10_000),
    maxRequests: Number(args['--max-requests'] ?? 10_000),
    concurrency: Number(args['--concurrency'] ?? 32),
    budgetUsd: Number(args['--budget-usd'] ?? 0.0266),
    seconds: Number(args['--seconds'] ?? 900),
  };
  if (!result.keyFile || !Number.isSafeInteger(result.maxSuccess) || result.maxSuccess < 1 ||
      result.maxSuccess > 10_000 || !Number.isSafeInteger(result.maxRequests) ||
      result.maxRequests < 1 || result.maxRequests > 10_000 ||
      !Number.isSafeInteger(result.concurrency) ||
      result.concurrency < 1 || result.concurrency > 10_000 ||
      !Number.isFinite(result.budgetUsd) || result.budgetUsd <= 0 || result.budgetUsd > 0.05 ||
      !Number.isSafeInteger(result.seconds) || result.seconds < 1 || result.seconds > 1800 ||
      Object.keys(args).length !== (process.argv.length - 2) / 2 ||
      Object.keys(args).some((arg) => !['--key-file', '--max-success', '--max-requests', '--concurrency', '--budget-usd', '--seconds'].includes(arg))) {
    throw new Error('Usage: --key-file PATH [--max-success 10000] [--max-requests 10000] [--concurrency 32] [--budget-usd 0.0266] [--seconds 900]');
  }
  return result;
}

function readKey(path) {
  const line = readFileSync(path, 'utf8').split(/\r?\n/)
    .find((item) => /^\s*DEEPINFRA_API_KEY=/.test(item));
  const key = line?.split('=').slice(1).join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!key) throw new Error('DeepInfra key file is unavailable or empty');
  return key;
}

const config = options();
const key = readKey(config.keyFile);
const limitResponse = await fetch('https://api.deepinfra.com/v1/me/rate_limit', {
  headers: { authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(20_000),
});
const accountLimits = await limitResponse.json();
const accountConcurrencyLimit = accountLimits.rate_limit;
if (!limitResponse.ok || !Number.isSafeInteger(accountConcurrencyLimit) || accountConcurrencyLimit < 1) {
  throw new Error('DeepInfra account concurrency limit could not be verified');
}
if (config.concurrency > accountConcurrencyLimit) {
  console.log(JSON.stringify({ blocked: true, reason: 'account_concurrency_limit',
    requestedConcurrency: config.concurrency, accountConcurrencyLimit,
    model: MODEL, modelRequestsSent: 0 }));
  process.exit(3);
}
const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }],
  max_tokens: MAX_OUTPUT_TOKENS, temperature: 0 });
const start = performance.now();
const deadline = start + config.seconds * 1000;
const stats = { attempted: 0, succeeded: 0, ready: 0, rateLimited: 0,
  currentInFlight: 0, peakClientInFlight: 0,
  httpErrors: {}, transportUnknown: 0, transportErrors: {}, modelMismatch: 0, missingCost: 0,
  estimatedCostUsd: 0, unknownReserveUsd: 0,
  promptTokens: 0, completionTokens: 0, latenciesMs: [] };
let concurrency = config.concurrency;
let stopReason = 'target_reached';
let lastProgress = start;

async function one() {
  const begun = performance.now();
  stats.currentInFlight++;
  stats.peakClientInFlight = Math.max(stats.peakClientInFlight, stats.currentInFlight);
  try {
    const response = await fetch(URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json().catch(() => null);
    if (response.status === 429) {
      return { kind: 'rate_limit', retryAfter: Number(response.headers.get('retry-after')) || 2 };
    }
    if (!response.ok || !result) return { kind: 'http_error', status: response.status };
    if (result.model !== MODEL) return { kind: 'model_mismatch' };
    const reported = result.usage?.estimated_cost;
    if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) {
      return { kind: 'missing_cost' };
    }
    return { kind: 'success', ready: result.choices?.[0]?.message?.content?.trim() === 'READY',
      cost: reported, promptTokens: result.usage?.prompt_tokens ?? 0,
      completionTokens: result.usage?.completion_tokens ?? 0,
      latencyMs: performance.now() - begun };
  } catch (error) {
    // A timeout can be billed server-side; never retry an unknown result automatically.
    const name = String(error?.name ?? 'Unknown').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    const code = String(error?.cause?.code ?? 'none').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    return { kind: 'transport_unknown', errorType: `${name}:${code}` };
  } finally {
    stats.currentInFlight--;
  }
}

while (stats.succeeded < config.maxSuccess && stats.attempted < config.maxRequests) {
  if (performance.now() >= deadline) { stopReason = 'duration_limit'; break; }
  const room = Math.floor((config.budgetUsd - stats.estimatedCostUsd - stats.unknownReserveUsd) / RESERVE_USD);
  if (room <= 0) { stopReason = 'budget_reservation_limit'; break; }
  const count = Math.min(concurrency, config.maxSuccess - stats.succeeded,
    config.maxRequests - stats.attempted, room);
  const results = await Promise.all(Array.from({ length: count }, () => one()));
  stats.attempted += count;
  let limited = 0;
  let retryAfter = 0;
  for (const result of results) {
    switch (result.kind) {
      case 'success':
        stats.succeeded++;
        stats.ready += Number(result.ready);
        stats.estimatedCostUsd += result.cost;
        stats.promptTokens += result.promptTokens;
        stats.completionTokens += result.completionTokens;
        stats.latenciesMs.push(result.latencyMs);
        break;
      case 'rate_limit':
        stats.rateLimited++;
        limited++;
        retryAfter = Math.max(retryAfter, result.retryAfter);
        break;
      case 'http_error':
        stats.httpErrors[result.status] = (stats.httpErrors[result.status] ?? 0) + 1;
        break;
      case 'model_mismatch': stats.modelMismatch++; break;
      case 'missing_cost': stats.missingCost++; break;
      case 'transport_unknown':
        stats.transportUnknown++;
        stats.unknownReserveUsd += RESERVE_USD;
        stats.transportErrors[result.errorType] = (stats.transportErrors[result.errorType] ?? 0) + 1;
        break;
    }
  }
  if (stats.estimatedCostUsd + stats.unknownReserveUsd >= config.budgetUsd) {
    stopReason = 'budget_limit'; break;
  }
  if (stats.modelMismatch || stats.missingCost || stats.httpErrors[401] || stats.httpErrors[403] ||
      stats.transportUnknown > Math.max(100, stats.attempted * 0.05) ||
      stats.attempted > config.maxSuccess * 1.5) {
    stopReason = 'error_limit'; break;
  }
  if (limited) {
    concurrency = Math.max(1, Math.floor(concurrency / 2));
    await new Promise((resolve) => setTimeout(resolve, Math.min(30, retryAfter) * 1000));
  } else if (concurrency < config.concurrency) {
    concurrency = Math.min(config.concurrency, concurrency + 1);
  }
  const now = performance.now();
  if (now - lastProgress >= 30_000 || stats.succeeded % 1000 < count) {
    console.log(JSON.stringify({ progress: true, succeeded: stats.succeeded,
      attempted: stats.attempted, concurrency, rateLimited: stats.rateLimited,
      transportUnknown: stats.transportUnknown,
      estimatedCostUsd: Number(stats.estimatedCostUsd.toFixed(8)),
      elapsedSeconds: Math.round((now - start) / 1000) }));
    lastProgress = now;
  }
}

if (stats.succeeded < config.maxSuccess && stats.attempted >= config.maxRequests) {
  stopReason = 'request_limit';
}

stats.latenciesMs.sort((a, b) => a - b);
const percentile = (p) => stats.latenciesMs.length
  ? Math.round(stats.latenciesMs[Math.ceil(stats.latenciesMs.length * p) - 1]) : null;
console.log(JSON.stringify({ model: MODEL, stopReason, attempted: stats.attempted,
  maxRequests: config.maxRequests,
  accountConcurrencyLimit, peakClientInFlight: stats.peakClientInFlight,
  succeeded: stats.succeeded, ready: stats.ready, rateLimited: stats.rateLimited,
  httpErrors: stats.httpErrors, transportUnknown: stats.transportUnknown,
  transportErrors: stats.transportErrors,
  modelMismatch: stats.modelMismatch, missingCost: stats.missingCost,
  estimatedCostUsd: Number(stats.estimatedCostUsd.toFixed(8)),
  unknownReserveUsd: Number(stats.unknownReserveUsd.toFixed(8)),
  promptTokens: stats.promptTokens, completionTokens: stats.completionTokens,
  elapsedSeconds: Math.round((performance.now() - start) / 1000),
  p50Ms: percentile(0.50), p95Ms: percentile(0.95), p99Ms: percentile(0.99) }));
if (stats.succeeded < config.maxSuccess) process.exitCode = 2;
