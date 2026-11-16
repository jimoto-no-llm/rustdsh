// The optimization flow with stand-ins for the model and for a run. These
// tests cover ordering, data separation, stopping and resuming. They say
// nothing about summary quality; that needs a real run (see README).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasks, ofSplit } from '../lib/tasks.mjs';
import { emptyState, loadState, DEFAULT_BUDGET } from '../lib/state.mjs';
import { comparisons, analysisPrompt, candidatePrompt, parseCandidates, chat } from '../lib/optimize.mjs';
import { optimize, runArm } from '../cli.mjs';

const TASKS = fileURLToPath(new URL('../tasks', import.meta.url));
const config = budget => ({ provider: { name: 'evalroute', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'RDSH_EVAL_KEY',
  model: 'm', contextWindow: 65536, outputReserve: 2048 },
thresholds: { trigger_tokens: 6000, retain_tokens: 1200, max_tokens: 4096 }, budget: { ...DEFAULT_BUDGET, ...budget } });

async function scratch(run) {
  const dir = await mkdtemp(join(tmpdir(), 'compaction-eval-flow-'));
  try { return await run(join(dir, 'state.json')); } finally { await rm(dir, { recursive: true, force: true }); }
}

// A run stand-in: `none` passes; `current` fails every task; a candidate
// passes when its text contains GOOD.
function fakeRun(log, { finalPasses = true } = {}) {
  return async ({ task, arm, instruction }) => {
    log.push(`${task.id}:${arm}`);
    const good = arm === 'none' || (arm === 'candidate' && instruction.includes('GOOD')
      && (task.split !== 'final' || finalPasses));
    return { pass: good, failed: good ? [] : ['equals:x'], tokens: arm === 'none' ? 9000 : 5000, calls: 7,
      compactions: arm === 'none' ? 0 : 1, summaries: arm === 'none' ? [] : ['a summary'], final: '' };
  };
}
const fakeAsk = prompts => async (_config, prompt) => {
  prompts.push(prompt);
  return { text: prompt.includes('"candidates"') ? '{"candidates":["GOOD keep exact values","weak"]}' : 'numbers were dropped', tokens: 10 };
};

test('only improve-split tasks are analyzed, and failures without compaction are left out', async () => {
  const tasks = ofSplit(await loadTasks(TASKS), 'improve');
  const result = (task, pass, compactions = 1) => ({ task: task.id, pass, failed: ['equals:x'], compactions, summaries: ['s'] });
  const out = comparisons(tasks, [result(tasks[0], true, 0), result(tasks[1], false, 0)],
    [result(tasks[0], false), result(tasks[1], false)]);
  assert.deepEqual(out.lost.map(item => item.task.id), [tasks[0].id]);
  assert.deepEqual(out.excluded, [tasks[1].id]);
  const select = ofSplit(await loadTasks(TASKS), 'select')[0];
  assert.throws(() => analysisPrompt({ task: select, result: result(select, false) }), /only the improve split/);
  assert.throws(() => comparisons([select], [], []), /only the improve split/);
  assert.ok(candidatePrompt('base', ['lost numbers'], 2).includes('exactly 2 strings'));
});

test('unusable candidates are dropped, not repaired', () => {
  const long = 'x'.repeat(8001);
  const reply = `noise {"candidates":["  keep paths  ","keep paths","",${JSON.stringify(long)},"bad\\u0007bell",7,"second\\nline"]} tail`;
  assert.deepEqual(parseCandidates(reply, 5), ['keep paths', 'second\nline']);
  assert.deepEqual(parseCandidates(reply, 1), ['keep paths']);
  assert.deepEqual(parseCandidates('no json here', 2), []);
  assert.deepEqual(parseCandidates('{"candidates":"text"}', 2), []);
});

test('a candidate that wins selection and the final check is adopted; later splits never reach the prompts', async () => {
  const tasks = await loadTasks(TASKS);
  await scratch(async statePath => {
    const log = [];
    const prompts = [];
    const report = await optimize({ config: config(), tasks, state: emptyState(), statePath,
      run: fakeRun(log), ask: fakeAsk(prompts) });
    assert.equal(report.reason, 'adopted');
    assert.equal(report.adopted, 'GOOD keep exact values');
    assert.equal(report.final.verdict.reason, 'more_passes');
    // The final split runs last, after selection is over.
    const firstFinal = log.findIndex(entry => entry.startsWith('final-'));
    assert.ok(firstFinal > 0 && log.slice(firstFinal).every(entry => entry.startsWith('final-')));
    for (const task of [...ofSplit(tasks, 'select'), ...ofSplit(tasks, 'final')]) {
      for (const prompt of prompts) assert.ok(!prompt.includes(task.question) && !prompt.includes(task.turns[0]), task.id);
    }
    // The report holds counts and the adopted text, no summaries or answers.
    assert.ok(!JSON.stringify(report).includes('a summary'));
  });
});

test('a failed final check, a spent budget or no loss keeps the existing instruction', async () => {
  const tasks = await loadTasks(TASKS);
  await scratch(async statePath => {
    const report = await optimize({ config: config(), tasks, state: emptyState(), statePath,
      run: fakeRun([], { finalPasses: false }), ask: fakeAsk([]) });
    assert.equal(report.adopted, null);
    assert.equal(report.reason, 'final_check:no_improvement');
  });
  await scratch(async statePath => {
    const report = await optimize({ config: config({ maxRuns: 3 }), tasks, state: emptyState(), statePath,
      run: fakeRun([]), ask: fakeAsk([]) });
    assert.deepEqual([report.adopted, report.reason], [null, 'budget_exhausted']);
  });
  await scratch(async statePath => {
    const allPass = async ({ arm }) => ({ pass: true, failed: [], tokens: 1, calls: 1, compactions: arm === 'none' ? 0 : 1, summaries: [], final: '' });
    const prompts = [];
    const report = await optimize({ config: config(), tasks, state: emptyState(), statePath, run: allPass, ask: fakeAsk(prompts) });
    assert.deepEqual([report.adopted, report.reason, prompts.length], [null, 'nothing_lost_on_improve_split', 0]);
  });
  await scratch(async statePath => {
    const neverCompacts = async () => ({ pass: true, failed: [], tokens: 1, calls: 1, compactions: 0, summaries: [], final: '' });
    const report = await optimize({ config: config(), tasks, state: emptyState(), statePath, run: neverCompacts, ask: fakeAsk([]) });
    assert.equal(report.reason, 'compaction_did_not_happen_in_baseline');
  });
});

test('a restart reuses finished runs and refuses to re-send an interrupted one', async () => {
  const tasks = ofSplit(await loadTasks(TASKS), 'improve');
  await scratch(async statePath => {
    const log = [];
    const state = emptyState();
    const crash = async ({ task }) => {
      log.push(task.id);
      if (log.length === 2) throw new Error('killed');
      return { pass: true, failed: [], tokens: 1, calls: 1, compactions: 1, summaries: [], final: '' };
    };
    await assert.rejects(runArm({ tasks, arm: 'current', config: config(), state, statePath, run: crash }), /killed/);
    const resumed = await loadState(statePath);
    const again = await runArm({ tasks, arm: 'current', config: config(), state: resumed, statePath, run: crash });
    assert.equal(again.stopped, 'interrupted_run_needs_retry_flag');
    assert.equal(again.results.length, 1);
    assert.equal(log.length, 2);
    const retried = await runArm({ tasks, arm: 'current', config: config(), state: resumed, statePath, run: crash,
      retryInterrupted: true });
    assert.equal(retried.results.length, tasks.length);
    // The finished first run was not repeated; the interrupted one and the rest ran.
    assert.equal(log.length, tasks.length + 1);
  });
});

test('the model call sends the key only in the header and rejects empty replies', async () => {
  process.env.RDSH_EVAL_KEY = 'synthetic-key';
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) }; };
  assert.deepEqual(await chat(config(), 'prompt', { fetchImpl: ok }), { text: 'hi', tokens: 5 });
  assert.equal(seen.url, 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer synthetic-key');
  assert.ok(!seen.init.body.includes('synthetic-key'));
  await assert.rejects(chat(config(), 'p', { fetchImpl: async () => ({ ok: false, status: 500 }) }), /HTTP 500/);
  await assert.rejects(chat(config(), 'p', { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }) }), /no text/);
  delete process.env.RDSH_EVAL_KEY;
});
