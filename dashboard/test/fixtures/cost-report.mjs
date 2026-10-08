export function costScope(projectId, patch = {}) {
  return {
    scope_id: "october-workers",
    project_id: projectId,
    period_start: "2026-10-06T00:00:00Z",
    period_end: "2026-10-07T00:00:00Z",
    membership_complete: true,
    targets: [1, 2].map((index) => ({
      target_id: `target-${index}`,
      worker_id: `worker-${index}`,
      session_id: `native-session-${index}`,
      run_id: `run-${index}`,
      provider: "fixture-provider",
      model: "fixture-model",
    })),
    ...patch,
  };
}
export function costReport(patch = {}) {
  return {
    event_id: "usage-1",
    scope_id: "october-workers",
    target_id: "target-1",
    source_kind: "provider_usage",
    source_ref: "fixture provider report / meter-1",
    observed_at: "2026-10-06T01:00:00Z",
    mode: "cumulative",
    sequence: 1,
    currency: "USD",
    amount: "0.1",
    certainty: "reported",
    tokens: { input: 10, cached_input: 2, output: 5 },
    basis:
      "Fixture provider-reported amount; no price lookup or actual billing.",
    ...patch,
  };
}
