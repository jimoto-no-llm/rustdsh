// Adoption rule. It is fixed before any candidate is evaluated and takes only
// counted outcomes, so a candidate cannot be adopted on impressions.

/**
 * @param results rows `{ task, required, pass, tokens, compactions }` of one arm
 */
export function summarize(results) {
  return {
    runs: results.length,
    passes: results.filter(row => row.pass).length,
    tokens: results.reduce((sum, row) => sum + row.tokens, 0),
    compacted: results.filter(row => row.compactions > 0).length,
    failedRequired: results.filter(row => row.required && !row.pass).map(row => row.task).sort(),
  };
}

/**
 * Decide whether `candidate` replaces `current`. Both arms must cover the same
 * tasks, and compaction must actually have happened in every candidate run:
 * a run that never compacted says nothing about the instruction.
 *
 * Adopt when no required task newly fails and either
 *   - the candidate keeps the pass count and uses fewer tokens, or
 *   - it passes more tasks within `tokenCap` (when a cap is given).
 */
export function decide(current, candidate, { tokenCap } = {}) {
  const tasks = rows => rows.map(row => row.task).sort().join('\n');
  if (current.length === 0 || tasks(current) !== tasks(candidate)) {
    return { adopt: false, reason: 'arms_cover_different_tasks' };
  }
  const now = summarize(current);
  const next = summarize(candidate);
  if (next.compacted !== next.runs) return { adopt: false, reason: 'compaction_did_not_happen' };
  const newlyFailed = next.failedRequired.filter(task => !now.failedRequired.includes(task));
  if (newlyFailed.length > 0) return { adopt: false, reason: 'required_task_newly_fails', tasks: newlyFailed };
  if (next.passes < now.passes) return { adopt: false, reason: 'fewer_passes' };
  if (next.passes === now.passes) {
    return next.tokens < now.tokens
      ? { adopt: true, reason: 'same_passes_fewer_tokens' }
      : { adopt: false, reason: 'no_improvement' };
  }
  if (tokenCap !== undefined && next.tokens > tokenCap) return { adopt: false, reason: 'over_token_cap' };
  return { adopt: true, reason: 'more_passes' };
}

/** The best adoptable candidate, or undefined. Ties keep the earlier one. */
export function pick(current, candidates, options) {
  let best;
  for (const candidate of candidates) {
    const verdict = decide(current, candidate.results, options);
    if (!verdict.adopt) continue;
    const stats = summarize(candidate.results);
    if (!best || stats.passes > best.stats.passes
      || (stats.passes === best.stats.passes && stats.tokens < best.stats.tokens)) {
      best = { candidate, verdict, stats };
    }
  }
  return best;
}
