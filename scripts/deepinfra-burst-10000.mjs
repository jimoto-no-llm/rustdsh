#!/usr/bin/env node
// Start exactly 10,000 bounded chat requests from 50 model-isolated processes.
// This measures client-side in-flight requests, not provider-side concurrency.
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeJournals } from './deepinfra-burst-journal.mjs';

const pairs = process.argv.slice(2);
if (pairs.length % 2 !== 0) throw new Error('Expected --name value pairs');
const args = Object.fromEntries(Array.from({ length: pairs.length / 2 }, (_, i) =>
  [pairs[2 * i], pairs[2 * i + 1]]));
const allowed = ['--key-file', '--out', '--total', '--models', '--budget-usd',
  '--connect-timeout-ms', '--request-timeout-ms', '--recover'];
if (Object.keys(args).length !== pairs.length / 2 ||
    Object.keys(args).some((name) => !allowed.includes(name))) throw new Error('Unknown or duplicate option');
const keyFile = args['--key-file'];
const out = args['--out'];
if (args['--recover']) {
  if (!out || Object.keys(args).some((key) => !['--recover', '--out'].includes(key)))
    throw new Error('Recovery usage: --recover EVIDENCE.json --out NEW.json');
  const manifest = JSON.parse(readFileSync(args['--recover'], 'utf8'));
  if (manifest.version !== 2 || !Array.isArray(manifest.plans) || !manifest.journalDir)
    throw new Error('Evidence has no recoverable journals');
  const summary = { ...manifest, ...summarizeJournals(manifest), recoveredAt: new Date().toISOString() };
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ phase: summary.phase, recordedStarts: summary.recordedStarts,
    http200: summary.http200, interruptedUnknown: summary.interruptedUnknown }));
  process.exit(summary.http200 === manifest.targetSimultaneous ? 0 : 2);
}
const total = Number(args['--total'] ?? 10_000);
const modelCount = Number(args['--models'] ?? 50);
const budgetUsd = Number(args['--budget-usd'] ?? 0.0266);
const connectMs = Number(args['--connect-timeout-ms'] ?? 30_000);
const requestMs = Number(args['--request-timeout-ms'] ?? 120_000);
if (!keyFile || !out || !Number.isSafeInteger(total) || total < 1 || total > 10_000 ||
    !Number.isSafeInteger(modelCount) || modelCount < 1 || modelCount > 50 ||
    total % modelCount !== 0 || total / modelCount > 200 ||
    !Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 0.0266 ||
    !Number.isSafeInteger(connectMs) || connectMs < 1 || connectMs > 120_000 ||
    !Number.isSafeInteger(requestMs) || requestMs < connectMs || requestMs > 300_000) {
  throw new Error('Usage: --key-file PATH --out PATH [--total 10000] [--models 50] [--budget-usd 0.0266]');
}
const perModel = total / modelCount;
const line = readFileSync(keyFile, 'utf8').split(/\r?\n/)
  .find((item) => /^\s*DEEPINFRA_API_KEY=/.test(item));
const key = line?.split('=').slice(1).join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
if (!key) throw new Error('DeepInfra key file is unavailable or empty');
const headers = { authorization: `Bearer ${key}` };
const preflight = await Promise.allSettled([
  fetch('https://api.deepinfra.com/v1/me/rate_limit',
    { headers, signal: AbortSignal.timeout(20_000) }),
  fetch('https://api.deepinfra.com/v1/openai/models',
    { headers, signal: AbortSignal.timeout(20_000) }),
]);
if (preflight.some((item) => item.status === 'rejected')) throw new Error('Preflight API query failed');
const [limitsResponse, modelsResponse] = preflight.map((item) => item.value);
if (!limitsResponse.ok || !modelsResponse.ok) throw new Error('Preflight API query failed');
const limits = await limitsResponse.json();
const catalog = await modelsResponse.json();
if (!Number.isSafeInteger(limits.rate_limit) || limits.rate_limit < perModel ||
    !Number.isSafeInteger(limits.tpm_rate_limit) || !Array.isArray(catalog.data)) {
  throw new Error('DeepInfra limits or model catalog are incomplete');
}
const candidates = catalog.data.filter((item) => item.metadata?.tags?.includes('chat') &&
  Number.isFinite(item.metadata?.pricing?.input_tokens) &&
  Number.isFinite(item.metadata?.pricing?.output_tokens) &&
  item.metadata.pricing.input_tokens >= 0 && item.metadata.pricing.output_tokens >= 0 &&
  !/guard|safety|moderation/i.test(item.id))
  .sort((a, b) => (15 * a.metadata.pricing.input_tokens + a.metadata.pricing.output_tokens) -
    (15 * b.metadata.pricing.input_tokens + b.metadata.pricing.output_tokens))
  .slice(0, modelCount);
if (candidates.length !== modelCount || total * 16 > limits.tpm_rate_limit) {
  throw new Error('Insufficient compatible models or token capacity');
}
const plans = candidates.map((item) => {
  const pricing = item.metadata.pricing;
  const reserveUsd = 1.10 * (15 * pricing.input_tokens + pricing.output_tokens) / 1_000_000;
  return { model: item.id, count: perModel, reserveUsd };
});
const reservedTotalUsd = plans.reduce((sum, item) => sum + item.count * item.reserveUsd, 0);
if (reservedTotalUsd > budgetUsd) throw new Error('Estimated cost exceeds budget');

const startedAt = new Date().toISOString();
const journalDir = resolve(`${out}.journal`);
const manifest = { version: 2, phase: 'preflight', startedAt,
  total, targetSimultaneous: total, modelCount, perModel, journalDir, plans,
  connectTimeoutMs: connectMs, requestTimeoutMs: requestMs,
  accountPerModelLimit: limits.rate_limit, accountTpmLimit: limits.tpm_rate_limit,
  budgetUsd, reservedTotalUsd };
const save = (data, initial = false) => {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  if (initial) writeFileSync(out, content, { flag: 'wx' });
  else {
    writeFileSync(`${out}.tmp`, content);
    renameSync(`${out}.tmp`, out);
  }
};
save(manifest, true);
mkdirSync(journalDir); // Exclusive run directory; never reuse old request IDs.
console.log(JSON.stringify({ phase: 'preflight', total, modelCount, perModel,
  reservedTotalUsd: Number(reservedTotalUsd.toFixed(8)) }));

const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'deepinfra-burst-worker.mjs');
const workers = plans.map((plan, index) => {
  const child = fork(workerPath, ['--model', plan.model, '--count', String(plan.count),
    '--reserve-usd', String(plan.reserveUsd), '--key-file', keyFile,
    '--journal', join(journalDir, `${index}.jsonl`),
    '--connect-timeout-ms', String(connectMs), '--request-timeout-ms', String(requestMs)],
  { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const state = { model: plan.model, child, ready: false, launched: 0,
    finished: false, exitCode: null, exitSignal: null };
  state.readyPromise = new Promise((resolve) => { state.readyResolve = resolve; });
  state.donePromise = new Promise((resolve) => { state.doneResolve = resolve; });
  child.stderr.on('data', () => {}); // Never store raw exceptions or request options.
  child.stdout.on('data', () => {});
  child.on('message', (message) => {
    if (message?.type === 'ready') {
      state.ready = true;
      state.readyResolve(true);
    } else if (message?.type === 'launched') {
      state.launched = message.count;
    }
  });
  child.on('error', () => { state.readyResolve(false); });
  child.on('close', (code, signal) => {
    state.finished = true;
    state.exitCode = code;
    state.exitSignal = signal;
    state.readyResolve(false);
    state.doneResolve(true);
  });
  return state;
});
const delay = (ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), ms);
  timer.unref();
});
const ready = await Promise.race([Promise.all(workers.map((w) => w.readyPromise)), delay(60_000)]);
if (!ready || ready.some((value) => !value)) {
  for (const worker of workers) if (!worker.finished) worker.child.kill();
  await Promise.all(workers.map((w) => w.donePromise));
  save({ ...manifest, phase: 'aborted_before_burst',
    readyWorkers: workers.filter((w) => w.ready).length, requestsStarted: 0 });
  throw new Error('Not all workers were ready; no burst was started');
}
const startAt = Date.now() + 2000;
save({ ...manifest, phase: 'running', startAt, requestsStartedUpperBound: total });
const stopWorkers = () => { for (const worker of workers) if (!worker.finished) worker.child.kill(); };
process.on('SIGINT', stopWorkers);
process.on('SIGTERM', stopWorkers);
for (const worker of workers) if (worker.child.connected)
  worker.child.send({ type: 'start', startAt }, () => {});
const progress = setInterval(() => {
  console.log(JSON.stringify({ phase: 'progress', workersFinished: workers.filter((w) => w.finished).length,
    workersLaunched: workers.filter((w) => w.launched > 0).length,
    launchedReported: workers.reduce((n, w) => n + w.launched, 0) }));
}, 10_000);
const completed = await Promise.race([Promise.all(workers.map((w) => w.donePromise)),
  delay(requestMs + 32_000)]);
clearInterval(progress);
if (!completed) {
  stopWorkers();
  await Promise.all(workers.map((w) => w.donePromise));
}
process.off('SIGINT', stopWorkers);
process.off('SIGTERM', stopWorkers);
const summary = { ...manifest, ...summarizeJournals(manifest, workers, { workersStopped: true }),
  finishedAt: new Date().toISOString(), startAt,
  launchedReported: workers.reduce((n, w) => n + w.launched, 0),
};
save(summary);
console.log(JSON.stringify({ phase: 'final', ...Object.fromEntries(Object.entries(summary)
  .filter(([key]) => !['byModel', 'plans'].includes(key))) }));
if (summary.phase !== 'complete' || summary.http200 !== total) process.exitCode = 2;
