// Task files: what the model is told, what must survive compaction, and how
// the outcome is checked. A task never contains the expected answer in a
// place the model can read; `expect` is only used by the scorer.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const SPLITS = ['improve', 'select', 'final'];
export const KINDS = ['constraint', 'path', 'decision_update', 'structured_output', 'tool_result', 'failure_recovery', 'denied_operation'];
const TASK_KEYS = ['id', 'split', 'kind', 'required', 'turns', 'question', 'expect', 'tools', 'files'];
const EXPECT_KEYS = ['equals', 'same_set', 'absent', 'tool_calls', 'files_absent'];
// A path inside the run's workspace: relative, no parent steps, plain characters.
const SAFE_PATH = /^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,199}$/;

function fail(id, reason) {
  throw new TypeError(`compaction-eval: task ${id}: ${reason}`);
}

function isText(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

/** Validate one task object and return it frozen. Unknown keys are errors. */
export function checkTask(task) {
  const id = typeof task?.id === 'string' ? task.id : '(no id)';
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail(id, 'must be an object');
  for (const key of Object.keys(task)) if (!TASK_KEYS.includes(key)) fail(id, `unknown key ${key}`);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) fail(id, 'id must be lower-case letters, digits and dashes');
  if (!SPLITS.includes(task.split)) fail(id, `split must be one of ${SPLITS.join(', ')}`);
  if (!KINDS.includes(task.kind)) fail(id, `kind must be one of ${KINDS.join(', ')}`);
  if (typeof task.required !== 'boolean') fail(id, 'required must be true or false');
  if (!Array.isArray(task.turns) || task.turns.length < 2 || task.turns.length > 24
    || !task.turns.every(turn => isText(turn, 16384))) fail(id, 'turns must hold 2 to 24 prompts');
  if (!isText(task.question, 16384)) fail(id, 'question must be text');
  const expect = task.expect;
  if (!expect || typeof expect !== 'object' || Array.isArray(expect)) fail(id, 'expect must be an object');
  for (const key of Object.keys(expect)) if (!EXPECT_KEYS.includes(key)) fail(id, `unknown expect key ${key}`);
  const equals = expect.equals ?? {};
  const sameSet = expect.same_set ?? {};
  const absent = expect.absent ?? [];
  if (typeof equals !== 'object' || Array.isArray(equals)) fail(id, 'expect.equals must be an object');
  if (typeof sameSet !== 'object' || Array.isArray(sameSet)
    || !Object.values(sameSet).every(Array.isArray)) fail(id, 'expect.same_set must map fields to arrays');
  if (!Array.isArray(absent) || !absent.every(text => isText(text, 256))) fail(id, 'expect.absent must list texts');
  if (Object.keys(equals).length + Object.keys(sameSet).length === 0) fail(id, 'expect needs at least one field');
  const tools = task.tools ?? false;
  if (typeof tools !== 'boolean') fail(id, 'tools must be true or false');
  const files = task.files ?? {};
  if (typeof files !== 'object' || Array.isArray(files)
    || !Object.entries(files).every(([path, body]) => SAFE_PATH.test(path) && typeof body === 'string' && body.length <= 65536)) {
    fail(id, 'files must map safe relative paths to text');
  }
  const toolCalls = expect.tool_calls ?? [];
  const whole = value => Number.isSafeInteger(value) && value >= 0;
  if (!Array.isArray(toolCalls) || !toolCalls.every(rule => rule && typeof rule.name === 'string' && /^[a-z_]{1,40}$/.test(rule.name)
    && Object.keys(rule).every(key => ['name', 'min', 'max'].includes(key))
    && (rule.min === undefined || whole(rule.min)) && (rule.max === undefined || whole(rule.max))
    && (rule.min !== undefined || rule.max !== undefined))) {
    fail(id, 'expect.tool_calls must list {name, min and/or max}');
  }
  const filesAbsent = expect.files_absent ?? [];
  if (!Array.isArray(filesAbsent) || !filesAbsent.every(path => typeof path === 'string' && SAFE_PATH.test(path))) {
    fail(id, 'expect.files_absent must list safe relative paths');
  }
  // Checks on the operation history only mean something when tools run.
  if (!tools && (Object.keys(files).length || toolCalls.length || filesAbsent.length)) {
    fail(id, 'files, tool_calls and files_absent need tools: true');
  }
  return Object.freeze({ ...task, tools, files,
    expect: { equals, same_set: sameSet, absent, tool_calls: toolCalls, files_absent: filesAbsent } });
}

/** Load every `*.json` task under `dir`, sorted by id. Duplicate ids are errors. */
export async function loadTasks(dir) {
  const names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();
  const tasks = [];
  for (const name of names) {
    let parsed;
    try { parsed = JSON.parse(await readFile(join(dir, name), 'utf8')); }
    catch { throw new TypeError(`compaction-eval: ${name} is not valid JSON`); }
    tasks.push(checkTask(parsed));
  }
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new TypeError(`compaction-eval: duplicate task id ${task.id}`);
    ids.add(task.id);
  }
  for (const split of SPLITS) {
    if (!tasks.some(task => task.split === split)) {
      throw new TypeError(`compaction-eval: no task in the ${split} split`);
    }
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

/** Tasks of one split. The splits never share a task (ids are unique). */
export function ofSplit(tasks, split) {
  if (!SPLITS.includes(split)) throw new TypeError(`compaction-eval: unknown split ${split}`);
  return tasks.filter(task => task.split === split);
}

/** Stable hash of a task's content, for result reuse. */
export function taskHash(task) {
  return createHash('sha256').update(JSON.stringify(task, Object.keys(task).sort())
    + JSON.stringify(task.expect) + JSON.stringify(task.turns) + JSON.stringify(task.files ?? {})).digest('hex');
}
