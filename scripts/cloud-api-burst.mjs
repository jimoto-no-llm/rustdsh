#!/usr/bin/env node
// Direct API qualification only; this does not create agents or sandboxes.
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight } from './cloud-api-burst-plan.mjs';
import { summarizeJournals } from './deepinfra-burst-journal.mjs';

const argv = process.argv.slice(2);
if (argv.length % 2) throw new Error('Expected option/value pairs');
const args = Object.fromEntries(Array.from({ length: argv.length / 2 }, (_, i) => [argv[i * 2], argv[i * 2 + 1]]));
const allowed = ['--deepinfra-key-file', '--openrouter-key-file', '--out', '--run',
  '--openrouter-models', '--deepinfra-models', '--per-model', '--target', '--budget-usd',
  '--max-input-price', '--max-output-price'];
if (Object.keys(args).length !== argv.length / 2 || Object.keys(args).some((key) => !allowed.includes(key)))
  throw new Error('Unknown or duplicate option');
const options = { orModels: Number(args['--openrouter-models'] ?? 40),
  diModels: Number(args['--deepinfra-models'] ?? 20), perModel: Number(args['--per-model'] ?? 200),
  target: Number(args['--target'] ?? 10_000), budgetUsd: Number(args['--budget-usd'] ?? 0.0266),
  maxInputPrice: args['--max-input-price'] == null ? undefined : Number(args['--max-input-price']),
  maxOutputPrice: args['--max-output-price'] == null ? undefined : Number(args['--max-output-price']) };
const total = (options.orModels + options.diModels) * options.perModel;
if (!args['--out'] || !args['--deepinfra-key-file'] || !args['--openrouter-key-file'] ||
    ![options.orModels, options.diModels, options.perModel, options.target].every(Number.isSafeInteger) ||
    options.orModels < 1 || options.orModels > 50 || options.diModels < 0 || options.diModels > 50 ||
    options.perModel < 1 || options.perModel > (options.diModels > 0 ? 200 : 1000) ||
    total > 12_000 || options.target < 1 || options.target > total ||
    !Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0 || options.budgetUsd > 0.50 ||
    [options.maxInputPrice, options.maxOutputPrice].some((price) => price != null && (!Number.isFinite(price) || price <= 0)) ||
    (args['--run'] && !['true', 'false'].includes(args['--run']))) throw new Error('Invalid burst options');
const keyFiles = { deepinfra: resolve(args['--deepinfra-key-file']), openrouter: resolve(args['--openrouter-key-file']) };
const details = await preflight(keyFiles, options);
const out = resolve(args['--out']);
const manifest = { version: 2, phase: 'preflight', startedAt: new Date().toISOString(),
  targetSimultaneous: options.target, total, maximumRequests: total,
  budgetUsd: options.budgetUsd, ...details, keyFiles, journalDir: `${out}.journal` };
const save = (data, initial = false) => {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (initial) writeFileSync(out, text, { flag: 'wx' });
  else { writeFileSync(`${out}.tmp`, text); renameSync(`${out}.tmp`, out); }
};
save(manifest, true);
console.log(JSON.stringify({ phase: 'preflight', target: options.target, maximumRequests: total,
  estimatedUsd: details.reservedTotalUsd, ...details.preflight }));
if (args['--run'] !== 'true') process.exit(0);
mkdirSync(manifest.journalDir);
const workerFile = join(dirname(fileURLToPath(import.meta.url)), 'cloud-api-burst-worker.mjs');
const workers = manifest.plans.map((plan, index) => {
  const child = fork(workerFile, [out, String(index)], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const state = { child, finished: false, ready: false, exitCode: null, exitSignal: null, launched: 0 };
  state.prepared = new Promise((resolve) => { state.preparedResolve = resolve; });
  state.checked = new Promise((resolve) => { state.checkResolve = resolve; });
  state.closed = new Promise((resolve) => { state.closeResolve = resolve; });
  child.on('message', (message) => {
    if (message?.type === 'ready') { state.ready = true; state.connections = message.connections; state.preparedResolve(true); }
    if (message?.type === 'checked') state.checkResolve(message.ready === true);
    if (message?.type === 'launched') state.launched = message.count;
  });
  child.on('error', () => { state.preparedResolve(false); state.checkResolve(false); });
  child.on('close', (code, signal) => {
    state.finished = true; state.exitCode = code; state.exitSignal = signal;
    state.preparedResolve(false); state.checkResolve(false); state.closeResolve();
  });
  return state;
});
const timeout = (ms) => new Promise((resolve) => { const timer = setTimeout(() => resolve(null), ms); timer.unref(); });
const stop = () => { for (const w of workers) if (!w.finished) w.child.kill(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const progress = setInterval(() => console.log(JSON.stringify({ phase: 'progress',
  readyWorkers: workers.filter((w) => w.ready).length, finishedWorkers: workers.filter((w) => w.finished).length,
  launched: workers.reduce((sum, w) => sum + w.launched, 0) })), 10_000);
const ready = await Promise.race([Promise.all(workers.map((w) => w.prepared)), timeout(90_000)]);
let checked = null;
if (ready?.every(Boolean)) {
  for (const w of workers) if (w.child.connected) w.child.send({ type: 'check' }, () => {});
  checked = await Promise.race([Promise.all(workers.map((w) => w.checked)), timeout(5000)]);
}
if (!checked?.every(Boolean)) {
  stop(); await Promise.all(workers.map((w) => w.closed)); clearInterval(progress);
  save({ ...manifest, phase: 'aborted_before_burst', requestsStarted: 0,
    readyWorkers: workers.filter((w) => w.ready).length });
  throw new Error('Connection preparation failed; no chat requests sent');
}
const startAt = Date.now() + 2000;
save({ ...manifest, phase: 'running', startAt, requestsStartedUpperBound: total });
for (const w of workers) if (w.child.connected) w.child.send({ type: 'start', startAt }, () => {});
await Promise.race([Promise.all(workers.map((w) => w.closed)), timeout(155_000)]);
stop(); await Promise.all(workers.map((w) => w.closed)); clearInterval(progress);
process.off('SIGINT', stop); process.off('SIGTERM', stop);
const summary = { ...manifest, ...summarizeJournals(manifest, workers, { workersStopped: true }),
  finishedAt: new Date().toISOString(), startAt,
  preparedConnections: workers.reduce((sum, w) => sum + (w.connections || 0), 0),
  launchedReported: workers.reduce((sum, w) => sum + w.launched, 0) };
summary.targetReachedBySuccessfulRequestOverlap = summary.peakSuccessfulRequestsInFlight >= options.target;
save(summary);
console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).filter(([key]) =>
  !['plans', 'byModel', 'keyFiles'].includes(key)))));
if (!summary.targetReachedBySuccessfulRequestOverlap) process.exitCode = 2;
