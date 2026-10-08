export function budgetPolicy(patch = {}) {
  return {
    policy_id: "project-budget",
    expected_revision: 0,
    run_id: null,
    period_start: new Date(Date.now() - 86400000).toISOString(),
    period_end: new Date(Date.now() + 86400000).toISOString(),
    currency: "USD",
    source_kind: "provider_usage",
    baseline: "0.3",
    baseline_basis:
      "Fixture: explicit pre-period spend; no real billing request",
    soft_limit: "0.6",
    hard_limit: "1",
    call_reservation: "0.3",
    paused: false,
    active: true,
    reason: "Fixture administrator sets the admission budget",
    ...patch,
  };
}
