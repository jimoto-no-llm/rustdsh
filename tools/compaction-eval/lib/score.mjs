// Scoring. The verdict comes from fixed expected values compared with the
// JSON object in the final answer, never from the model saying it succeeded.

/** The last top-level JSON object in `text`, or undefined. */
export function lastJsonObject(text) {
  if (typeof text !== 'string') return undefined;
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    let depth = 0;
    let inString = false;
    for (let start = end; start >= 0; start--) {
      const char = text[start];
      if (char === '"') {
        let slashes = 0;
        for (let k = start - 1; k >= 0 && text[k] === '\\'; k--) slashes++;
        if (slashes % 2 === 0) inString = !inString;
      } else if (!inString && char === '}') depth++;
      else if (!inString && char === '{' && --depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, end + 1));
          if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        } catch { /* keep scanning for an earlier opening brace */ }
      }
    }
  }
  return undefined;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const key = value => JSON.stringify(value);
  const left = actual.map(key).sort();
  const right = expected.map(key).sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * Checks on what was done, not on what was said: how often each tool was
 * called (from the session log) and which files must not exist afterwards.
 */
export function scoreOperations(task, evidence = {}) {
  const failed = [];
  const calls = evidence.toolCalls ?? [];
  for (const rule of task.expect.tool_calls ?? []) {
    const count = calls.filter(name => name === rule.name).length;
    if (rule.min !== undefined && count < rule.min) failed.push(`tool_calls:${rule.name}<${rule.min}`);
    if (rule.max !== undefined && count > rule.max) failed.push(`tool_calls:${rule.name}>${rule.max}`);
  }
  for (const path of task.expect.files_absent ?? []) {
    if ((evidence.existing ?? []).includes(path)) failed.push(`files_absent:${path}`);
  }
  return failed;
}

/**
 * Score one finished run.
 * @param evidence `{ toolCalls: string[], existing: string[] }` from the run
 * @returns {{pass: boolean, failed: string[]}} `failed` names each check that
 *   did not hold, so a comparison can say what was lost.
 */
export function score(task, finalText, evidence) {
  const answer = lastJsonObject(finalText);
  if (!answer) return { pass: false, failed: ['no_json_object', ...scoreOperations(task, evidence)] };
  const failed = scoreOperations(task, evidence);
  for (const [field, expected] of Object.entries(task.expect.equals)) {
    if (!sameJson(answer[field], expected)) failed.push(`equals:${field}`);
  }
  for (const [field, expected] of Object.entries(task.expect.same_set)) {
    if (!sameSet(answer[field], expected)) failed.push(`same_set:${field}`);
  }
  const flat = JSON.stringify(answer);
  for (const text of task.expect.absent) {
    if (flat.includes(text)) failed.push(`absent:${text}`);
  }
  return { pass: failed.length === 0, failed };
}
