# Managed Harness process observations

The Harness card reports the DSH service process started and owned by this
dashboard. It does not report the state of each task or model request inside
Harness. The card combines read-only observations from the owned-process
monitor, the root process exit event, the last stdout/stderr chunk time without
retaining output contents, and the aggregate interval between authenticated
dashboard polls. Five minutes without a new chunk is displayed as a quiet
process, not a failed task.

Process exit, an empty owned process scope, dashboard reconnect gaps, and task
completion are separate facts. Even when every owned process has exited, the
dashboard leaves the work outcome unassessed. A dashboard reconnect gap does
not change the recorded process state. Diagnostics never stop a process; the
existing target-confirmed stop action remains separate.

The current Harness integration does not expose task heartbeats, provider/API
wait state, or CPU/GPU activity. The panel records these signals as unavailable
at the time of inspection. `null` means not collected, not zero activity. An
operator can follow the guidance to inspect the original Harness page, but the
dashboard does not infer an API wait, resource wait, or hang from silence.

`tests/e2e/run-health.mjs` uses a local long-running child fixture and a real
browser rendering this dashboard. It has no provider, model, credential, or
external network connection. That fixture verifies the projection and browser
reconnect behavior; it does not verify upstream DSH task or provider telemetry.
