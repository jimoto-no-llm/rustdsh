import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasks, checkTask, ofSplit, taskHash, SPLITS } from '../lib/tasks.mjs';
import { lastJsonObject, score, scoreOperations } from '../lib/score.mjs';
import { decide, pick, summarize } from '../lib/judge.mjs';
import { runKey, plan, markStarted, markDone, emptyState, loadState, saveState, checkBudget,
  withinBudget, DEFAULT_BUDGET } from '../lib/state.mjs';
import zlib from 'node:zlib';
import { settings, profilePatch, parseTurn, readLog, checkConditions, conditions, zstd, TOOL_ROWS, FILE_TOOL_ROWS } from '../lib/runner.mjs';

const TASKS = fileURLToPath(new URL('../tasks', import.meta.url));
const config = () => ({ provider: { name: 'evalroute', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'RDSH_EVAL_KEY',
  model: "it's-a-model", contextWindow: 65536, outputReserve: 2048 },
thresholds: { trigger_tokens: 6000, retain_tokens: 1200, max_tokens: 4096 } });
const base = { id: 'a-task', split: 'improve', kind: 'constraint', required: true,
  turns: ['fact', 'filler'], question: 'q', expect: { equals: { port: 1 } } };

test('shipped tasks load, cover every split and never share a task between splits', async () => {
  const tasks = await loadTasks(TASKS);
  const ids = SPLITS.flatMap(split => ofSplit(tasks, split).map(task => task.id));
  assert.equal(ids.length, tasks.length);
  assert.equal(new Set(ids).size, tasks.length);
  for (const split of SPLITS) assert.ok(ofSplit(tasks, split).length >= 2, split);
  // The expected values are never part of what the model is told.
  for (const task of tasks) assert.ok(!JSON.stringify([task.turns, task.question]).includes('"expect"'));
});

test('a task with an unknown key, split or empty expectation is refused', () => {
  assert.throws(() => checkTask({ ...base, note: 'x' }), /unknown key note/);
  assert.throws(() => checkTask({ ...base, split: 'train' }), /split must be/);
  assert.throws(() => checkTask({ ...base, expect: {} }), /at least one field/);
  assert.throws(() => checkTask({ ...base, expect: { equals: { a: 1 }, hint: 1 } }), /unknown expect key/);
  assert.throws(() => checkTask({ ...base, turns: ['only one'] }), /2 to 24/);
  assert.notEqual(taskHash(checkTask(base)), taskHash(checkTask({ ...base, question: 'other' })));
});

test('the verdict comes from the last JSON object, not from what the model claims', () => {
  assert.deepEqual(lastJsonObject('first {"a":1} then {"b":"}"} done'), { b: '}' });
  assert.equal(lastJsonObject('I succeeded, all values are correct.'), undefined);
  const task = checkTask({ ...base, expect: { equals: { port: 8443, tag: 'SVC-7' },
    same_set: { paths: ['a', 'b'] }, absent: ['Redis'] } });
  assert.deepEqual(score(task, 'ok {"port":8443,"tag":"SVC-7","paths":["b","a"]}'), { pass: true, failed: [] });
  assert.deepEqual(score(task, '{"port":"8443","tag":"SVC-7","paths":["a"],"old":"Redis"}'),
    { pass: false, failed: ['equals:port', 'same_set:paths', 'absent:Redis'] });
  assert.deepEqual(score(task, 'The task passed.'), { pass: false, failed: ['no_json_object'] });
});

const row = (task, pass, tokens, extra = {}) => ({ task, required: true, pass, tokens, compactions: 1, ...extra });

test('a candidate is adopted only on counted improvement with compaction in every run', () => {
  const current = [row('a', true, 1000), row('b', false, 1000)];
  assert.deepEqual(decide(current, [row('a', true, 900), row('b', false, 900)]),
    { adopt: true, reason: 'same_passes_fewer_tokens' });
  assert.deepEqual(decide(current, [row('a', true, 1500), row('b', true, 1500)]),
    { adopt: true, reason: 'more_passes' });
  assert.equal(decide(current, [row('a', true, 1500), row('b', true, 1500)], { tokenCap: 2500 }).reason, 'over_token_cap');
  assert.equal(decide(current, [row('a', true, 1000), row('b', false, 1000)]).reason, 'no_improvement');
  assert.deepEqual(decide(current, [row('a', false, 10), row('b', true, 10)]),
    { adopt: false, reason: 'required_task_newly_fails', tasks: ['a'] });
  assert.equal(decide(current, [row('a', true, 10), row('b', true, 10, { compactions: 0 })]).reason,
    'compaction_did_not_happen');
  assert.equal(decide(current, [row('a', true, 10)]).reason, 'arms_cover_different_tasks');
  assert.equal(decide([], []).reason, 'arms_cover_different_tasks');
  const chosen = pick(current, [
    { instruction: 'x', results: [row('a', true, 900), row('b', false, 900)] },
    { instruction: 'y', results: [row('a', true, 1200), row('b', true, 1200)] },
    { instruction: 'z', results: [row('a', false, 1), row('b', true, 1)] },
  ]);
  assert.equal(chosen.candidate.instruction, 'y');
  assert.equal(pick(current, [{ instruction: 'z', results: [row('a', false, 1), row('b', true, 1)] }]), undefined);
  assert.deepEqual(summarize(current).failedRequired, ['b']);
});

test('finished runs are reused, changed inputs are not, interrupted runs are never re-sent unasked', async () => {
  const input = { taskHash: 'h', arm: 'candidate', instruction: 'keep paths', conditions: conditions(config()) };
  const key = runKey(input);
  assert.equal(key, runKey({ ...input, conditions: { ...input.conditions } }));
  for (const changed of [{ taskHash: 'i' }, { arm: 'current' }, { instruction: 'keep paths.' },
    { conditions: { ...input.conditions, trigger_tokens: 6001 } }, { conditions: { ...input.conditions, model: 'm2' } }]) {
    assert.notEqual(key, runKey({ ...input, ...changed }));
  }
  const state = emptyState();
  assert.equal(plan(state, key), 'run');
  markStarted(state, key, { task: 't', arm: 'candidate' });
  assert.equal(plan(state, key), 'blocked');
  assert.equal(plan(state, key, { retryInterrupted: true }), 'run');
  markDone(state, key, { pass: true, calls: 7, tokens: 9000 });
  assert.equal(plan(state, key), 'reuse');
  assert.deepEqual(state.usage, { runs: 1, calls: 7, tokens: 9000 });
  const dir = await mkdtemp(join(tmpdir(), 'compaction-eval-test-'));
  try {
    const path = join(dir, 'nested', 'state.json');
    assert.deepEqual(await loadState(path), emptyState());
    await saveState(path, state);
    assert.deepEqual(await loadState(path), state);
    await writeFile(path, '{"schema":2,"runs":{}}');
    await assert.rejects(loadState(path), /another schema/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  assert.throws(() => checkBudget({ ...DEFAULT_BUDGET, concurrency: 2 }), /concurrency 1/);
  assert.throws(() => checkBudget({ ...DEFAULT_BUDGET, rounds: 0 }), /budget.rounds/);
  assert.equal(withinBudget({ usage: { runs: 60 } }, DEFAULT_BUDGET), false);
});

test('arms differ only in routes and instructions; tools are off in the profile', () => {
  const c = config();
  const policies = settings(c, 'current').policies;
  assert.deepEqual(policies, [{ provider: 'evalroute', model: "it's-a-model", context_window: 65536,
    output_reserve: 2048, trigger_tokens: 6000, retain_tokens: 1200, max_tokens: 4096 }]);
  assert.deepEqual(settings(c, 'current'), { schema: 1, policies });
  assert.deepEqual(settings(c, 'none'), { schema: 1, policies,
    routes: [{ provider: 'evalroute', model: "it's-a-model", method: 'off' }] });
  assert.deepEqual(settings(c, 'candidate', 'Keep paths.'), { schema: 1, policies, instructions: 'Keep paths.' });
  assert.throws(() => settings(c, 'current', 'x'), /only the candidate arm/);
  assert.throws(() => settings(c, 'candidate'), /only the candidate arm/);
  const patch = profilePatch(c);
  assert.ok(patch.includes("          - id: 'it''s-a-model'\n"));
  assert.ok(patch.includes('        apiKeyEnv: RDSH_EVAL_KEY\n'));
  for (const id of TOOL_ROWS) assert.ok(patch.includes(`- id: ${id}\n  disabled: true\n`), id);
  assert.throws(() => checkConditions({ ...c, thresholds: { ...c.thresholds, retain_tokens: 6000 } }), /below trigger/);
  assert.throws(() => checkConditions({ ...c, provider: { ...c.provider, apiKeyEnv: 'sk-secret' } }), /environment variable/);
  assert.throws(() => checkConditions({ ...c, thresholds: { ...c.thresholds, trigger_tokens: 70000 } }), /does not fit/);
});

test('headless events and session-log rows are reduced to counts', () => {
  const stdout = ['{"type":"session","sessionId":"session-1","cwd":"/w"}',
    '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}', 'not json',
    '{"type":"final","text":"{\\"ok\\":true}"}', ''].join('\n');
  assert.deepEqual(parseTurn(stdout), { sessionId: 'session-1', final: '{"ok":true}', ended: 'completed' });
  assert.equal(parseTurn('{"type":"status","phase":"turn_end","reason":{"kind":"error"}}').ended, 'error');
  const log = [
    { type: 'assistant/message', data: { usage: { inputTokens: 733, outputTokens: 766, cacheReadTokens: 8782 } } },
    { type: 'compaction/start', data: {} },
    { type: 'compaction/summary', data: { summary: [{ type: 'text', text: 'kept facts' }],
      usage: { inputTokens: 395, outputTokens: 793, cacheReadTokens: 10317 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 2601, outputTokens: 788, cacheReadTokens: 8460 } } },
    { type: 'user/message', data: {} },
  ].map(row => JSON.stringify(row));
  assert.deepEqual(readLog([...log, '', '{broken']), { calls: 3, tokens: 733 + 766 + 8782 + 395 + 793 + 10317 + 2601 + 788 + 8460,
    compactions: 1, summaries: ['kept facts'], toolCalls: [] });
});

test('a session log written as several zstd frames is decoded whole', {
  skip: typeof zlib.zstdCompressSync === 'function' ? false : 'this Node has no zstd',
}, () => {
  const frames = ['{"type":"session"}\n', '{"type":"assistant/message"}\n', '{"type":"turn/end"}\n'];
  const log = Buffer.concat(frames.map(text => zlib.zstdCompressSync(Buffer.from(text))));
  assert.equal(zstd(log), frames.join(''));
});

test('a tool task is scored on what was done: tool calls from the log and files in the workspace', () => {
  const task = checkTask({ ...base, tools: true, files: { 'data/config.txt': 'token = A\n' },
    expect: { equals: { created: false }, tool_calls: [{ name: 'write', min: 1, max: 1 }, { name: 'read', min: 1 }], files_absent: ['out.txt'] } });
  assert.deepEqual(score(task, '{"created":false}', { toolCalls: ['read', 'write'], existing: [] }), { pass: true, failed: [] });
  // Saying the right thing does not pass when the operations say otherwise.
  assert.deepEqual(score(task, '{"created":false}', { toolCalls: ['write', 'write'], existing: ['out.txt'] }),
    { pass: false, failed: ['tool_calls:write>1', 'tool_calls:read<1', 'files_absent:out.txt'] });
  assert.deepEqual(scoreOperations(task, {}), ['tool_calls:write<1', 'tool_calls:read<1']);
  assert.deepEqual(score(task, 'no json', { toolCalls: ['read', 'write'] }), { pass: false, failed: ['no_json_object'] });
  assert.throws(() => checkTask({ ...base, files: { 'a.txt': 'x' } }), /need tools: true/);
  assert.throws(() => checkTask({ ...base, expect: { equals: { a: 1 }, tool_calls: [{ name: 'read', min: 1 }] } }), /need tools: true/);
  for (const path of ['../escape.txt', '/etc/passwd', 'a/../b', './a', 'a b.txt', '']) {
    assert.throws(() => checkTask({ ...base, tools: true, files: { [path]: 'x' } }), /safe relative paths/, path);
    assert.throws(() => checkTask({ ...base, tools: true, expect: { equals: { a: 1 }, files_absent: [path] } }), /safe relative paths/, path);
  }
  assert.throws(() => checkTask({ ...base, tools: true, expect: { equals: { a: 1 }, tool_calls: [{ name: 'read' }] } }), /min and\/or max/);
});

test('file tools are on only for a tool task; shell, web and subagent tools stay off; tool calls are counted', () => {
  const c = config();
  const plain = profilePatch(c);
  const tooled = profilePatch(c, { tools: true });
  for (const id of FILE_TOOL_ROWS) {
    assert.ok(plain.includes(`- id: ${id}\n  disabled: true\n`), id);
    assert.ok(!tooled.includes(`- id: ${id}\n`), id);
  }
  for (const id of TOOL_ROWS.filter(id => !FILE_TOOL_ROWS.includes(id))) {
    assert.ok(tooled.includes(`- id: ${id}\n  disabled: true\n`), id);
  }
  const log = [{ type: 'tool/call', data: { name: 'read', arguments: '{}' } }, { type: 'tool/result', data: {} },
    { type: 'tool/call', data: { name: 'write' } }, { type: 'tool/call', data: {} }].map(row => JSON.stringify(row));
  assert.deepEqual(readLog(log).toolCalls, ['read', 'write']);
});
