import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const counterNames = ['http200', 'usable', 'rateLimited', 'serverUnknown',
  'transportUnknown', 'notSent', 'interruptedUnknown', 'notStarted', 'modelMismatch',
  'missingCost', 'knownCostUsd', 'unknownReserveUsd'];

function emptyCounters() {
  return { ...Object.fromEntries(counterNames.map((name) => [name, 0])),
    httpErrors: {}, transportErrors: {}, failurePhases: {} };
}

// Each worker owns one append-only journal. Process crashes cannot erase earlier
// completed requests. A corrupt/truncated journal is explicitly incomplete.
export function summarizeJournals(manifest, exits = [], { workersStopped = false } = {}) {
  const aggregate = emptyCounters();
  const events = [];
  const sentEvents = [];
  const successfulEvents = [];
  const byModel = {};
  let completeWorkers = 0;
  let recordedStarts = 0;
  let journalsIncomplete = false;
  for (const [index, plan] of manifest.plans.entries()) {
    const starts = new Map();
    const results = new Map();
    let journalComplete = true;
    let workerDone = false;
    let headerSeen = false;
    let records = [];
    try { records = readFileSync(join(manifest.journalDir, `${index}.jsonl`), 'utf8').split('\n'); }
    catch { journalComplete = false; }
    for (const line of records) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.type === 'header') {
          if (headerSeen || item.model !== plan.model || item.count !== plan.count)
            throw new Error('Journal identity mismatch');
          headerSeen = true;
        } else if (item.type === 'done') workerDone = true;
        else {
          if (!headerSeen || !Number.isSafeInteger(item.id) || item.id < 0 || item.id >= plan.count)
            throw new Error('Invalid request identity');
          if (item.type === 'start' && Number.isFinite(item.started) && !starts.has(item.id))
            starts.set(item.id, item.started);
          else if (item.type === 'result' && starts.has(item.id) && !results.has(item.id) &&
              Number.isFinite(item.ended) && item.ended >= starts.get(item.id) &&
              ['http200', 'rateLimited', 'serverUnknown', 'transportUnknown', 'notSent',
                'modelMismatch', 'missingCost', 'httpError'].includes(item.outcome)) {
            if (item.outcome === 'http200' && (!Number.isFinite(item.costUsd) || item.costUsd < 0))
              throw new Error('Invalid cost');
            results.set(item.id, item);
          } else throw new Error('Invalid journal event');
        }
      } catch { journalComplete = false; }
    }
    if (!headerSeen) journalComplete = false;
    const counts = emptyCounters();
    for (const [id, start] of starts) {
      const result = results.get(id);
      if (!result) {
        counts.interruptedUnknown++;
        counts.unknownReserveUsd += plan.reserveUsd;
        continue;
      }
      events.push([start, 1], [result.ended, -1]);
      if (Number.isFinite(result.sent)) {
        sentEvents.push([result.sent, 1], [result.ended, -1]);
        if (result.outcome === 'http200') successfulEvents.push([result.sent, 1], [result.ended, -1]);
      }
      if (result.outcome !== 'httpError') counts[result.outcome]++;
      if (result.outcome === 'http200') {
        counts.knownCostUsd += result.costUsd;
        if (result.usable) counts.usable++;
      }
      if (['serverUnknown', 'transportUnknown', 'modelMismatch', 'missingCost'].includes(result.outcome))
        counts.unknownReserveUsd += plan.reserveUsd;
      if (result.status >= 300) counts.httpErrors[result.status] = (counts.httpErrors[result.status] || 0) + 1;
      if (result.error) {
        counts.transportErrors[result.error] = (counts.transportErrors[result.error] || 0) + 1;
        counts.failurePhases[result.phase] = (counts.failurePhases[result.phase] || 0) + 1;
      }
    }
    const unrecorded = plan.count - starts.size;
    if (journalComplete && workersStopped) counts.notStarted = unrecorded;
    else {
      counts.interruptedUnknown += unrecorded;
      counts.unknownReserveUsd += unrecorded * plan.reserveUsd;
    }
    const complete = journalComplete && workerDone && results.size === plan.count;
    if (complete) completeWorkers++;
    if (!journalComplete) journalsIncomplete = true;
    recordedStarts += starts.size;
    const group = plan.provider ? `${plan.provider}:${plan.model}` : plan.model;
    byModel[group] = { ...counts, recordedStarts: starts.size, resultsRecorded: results.size,
      resultMissing: !complete, journalComplete,
      exitCode: exits[index]?.exitCode ?? manifest.byModel?.[group]?.exitCode ?? null,
      exitSignal: exits[index]?.exitSignal ?? manifest.byModel?.[group]?.exitSignal ?? null };
    for (const name of counterNames) aggregate[name] += counts[name];
    for (const name of ['httpErrors', 'transportErrors', 'failurePhases']) {
      for (const [key, count] of Object.entries(counts[name]))
        aggregate[name][key] = (aggregate[name][key] || 0) + count;
    }
  }
  const peak = (items) => {
    // End before start at equal millisecond: do not inflate overlap by timestamp ties.
    items.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let active = 0;
    let maximum = 0;
    for (const [, delta] of items) { active += delta; maximum = Math.max(maximum, active); }
    return maximum;
  };
  return { phase: completeWorkers === manifest.plans.length ? 'complete' : 'partial',
    completeWorkers, recordedStarts, peakClientInFlight: peak(events),
    peakSentInFlight: peak(sentEvents), peakSuccessfulRequestsInFlight: peak(successfulEvents),
    peakClientInFlightIsLowerBound: journalsIncomplete || aggregate.interruptedUnknown > 0,
    serverSideConcurrencyMeasured: false, ...aggregate, byModel };
}
