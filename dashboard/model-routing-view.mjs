import { SessionLedger } from "./session-ledger.mjs";
import { ModelRouting } from "./model-routing.mjs";

// Human read surface only: no prompts, home paths, launch argv, credentials,
// native setter, fallback selection, or model-call authorization endpoint.
export async function modelRoutingViews(project) {
  const ledger = await SessionLedger.open(project);
  const routing = ModelRouting.open(ledger.project);
  const runs = (await ledger.list())
    .filter((run) => run.cli === "dsh" && run.binding === "confirmed")
    .slice(-100);
  return Promise.all(
    runs.map(async (run) => {
      try {
        const view = await routing.inspect(run);
        const latest = view.native_calls?.at(-1) ?? null;
        return {
          run_id: run.run_id,
          task_id: run.task_id,
          requested: view.requested ?? null,
          active_route: view.active_route ?? null,
          source: view.provenance?.source ?? null,
          role: view.provenance?.role ?? null,
          native_dispatch_required: view.native_dispatch_required === true,
          latest_native_call: latest,
          native_call_count: (view.native_calls ?? []).filter(
            (call) => call.phase !== "finished",
          ).length,
          configuration: view.observation?.selection ?? null,
          configuration_comparison: view.comparison?.status ?? "unknown",
          authorization: view.active_authorization
            ? {
                id: view.active_authorization.authorization_id,
                source: view.active_authorization.source,
                from: view.active_authorization.from,
                to: view.active_authorization.to,
                expires_at: view.active_authorization.expires_at,
                expired: view.authorization_expired,
              }
            : null,
          error: null,
          actual_model_execution_verified: false,
        };
      } catch {
        return {
          run_id: run.run_id,
          task_id: run.task_id,
          error: "route_history_unavailable",
          actual_model_execution_verified: false,
        };
      }
    }),
  );
}
