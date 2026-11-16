// Progress file. A finished run is reused when every input that shapes it is
// unchanged; a run that was started and never finished is never re-sent on its
// own, because the first request may still have been charged.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const STATE_SCHEMA = 1;

/** Key of one run: task content, arm, instruction text and run conditions. */
export function runKey({ taskHash, arm, instruction, conditions }) {
  const ordered = Object.keys(conditions).sort().map(key => [key, conditions[key]]);
  return createHash('sha256')
    .update(JSON.stringify([taskHash, arm, instruction ?? null, ordered]))
    .digest('hex');
}

export function emptyState() {
  return { schema: STATE_SCHEMA, runs: {}, usage: { runs: 0, calls: 0, tokens: 0 } };
}

export async function loadState(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
  const state = JSON.parse(text);
  if (state?.schema !== STATE_SCHEMA || typeof state.runs !== 'object') {
    throw new TypeError('compaction-eval: the state file has another schema');
  }
  return state;
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, `${JSON.stringify(state, null, 2)}\n`);
  await rename(partial, path);
}

/**
 * What to do with a run on (re)start.
 * - `reuse`: a finished result with the same key exists.
 * - `blocked`: it was started and has no result; needs `retryInterrupted`.
 * - `run`: nothing recorded, or an interrupted run the caller chose to retry.
 */
export function plan(state, key, { retryInterrupted = false } = {}) {
  const entry = state.runs[key];
  if (!entry) return 'run';
  if (entry.status === 'done') return 'reuse';
  return retryInterrupted ? 'run' : 'blocked';
}

export function markStarted(state, key, meta) {
  state.runs[key] = { status: 'started', ...meta };
}

export function markDone(state, key, result) {
  state.runs[key] = { ...state.runs[key], status: 'done', result };
  state.usage.runs += 1;
  state.usage.calls += result.calls;
  state.usage.tokens += result.tokens;
}

/** Search limits. They bound spending; they do not promise quality. */
export function checkBudget(budget) {
  const whole = value => Number.isSafeInteger(value) && value > 0;
  for (const key of ['rounds', 'candidates', 'maxRuns', 'maxCallsPerRun', 'runTimeoutMs']) {
    if (!whole(budget[key])) throw new TypeError(`compaction-eval: budget.${key} must be a positive integer`);
  }
  if (budget.concurrency !== 1) throw new TypeError('compaction-eval: only concurrency 1 is supported');
  return budget;
}

export const DEFAULT_BUDGET = Object.freeze({
  rounds: 2, candidates: 2, concurrency: 1, maxRuns: 60, maxCallsPerRun: 30, runTimeoutMs: 900000,
});

export function withinBudget(state, budget) {
  return state.usage.runs < budget.maxRuns;
}
