import { performance } from "node:perf_hooks";

// Seeded fault transitions and observed I/O attempts use separate clocks.
export function createFaultTrace(seed, now = () => performance.now()) {
  const events = [], journalFailures = [], injectedBoundaries = new Set();
  const started = now();
  let tick = 0;
  const observe = (event, data = {}) => {
    tick += 1 + (seed % 7);
    events.push({ logical_time_ms: tick, event, ...data });
  };
  const journalFailure = (boundary) => {
    journalFailures.push({
      attempt: journalFailures.length + 1,
      elapsed_ms: Math.max(0, now() - started),
      boundary,
      after_event: events.at(-1)?.event ?? null,
    });
    // The full device remains faulty during cleanup. Polling the process group
    // can trigger a variable number of journal writes, not new seeded faults.
    if (!injectedBoundaries.has(boundary)) {
      injectedBoundaries.add(boundary);
      observe("injected_ENOSPC", { boundary });
    }
  };
  const clock = { now: () => tick, wait: async (ms) => { tick += ms; } };
  return { events, observe, journalFailure, clock,
    runtime_observations: { journal_failures: journalFailures } };
}
