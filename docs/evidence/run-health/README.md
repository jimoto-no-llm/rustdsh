# Managed Harness process health evidence

These are real Chromium captures of the local Harness dashboard at 1365×900.
The fixture starts an isolated local child process and uses loopback only.

- `before.png` is a capture-only run on main `4f63db1c815cf9f969558f4ba0e3f20f2f7c943f`.
- `after.png` is the verified flow on source commit
  `525fa97aa875c0a96bb45e7890391b4521b7703b`. It shows the owned-process
  state, last-output time, root-process exit observation, authenticated
  dashboard-poll interval, unavailable upstream signals, and guidance that
  separates the DSH service process from task state.
- `after.json` records the local fixture scope. The browser test checks the
  process remains running during a forced dashboard disconnect and recovers
  without changing the process diagnosis.

No provider, model, credential, or external network is used. The screenshots
do not establish DSH task heartbeat, provider/API wait, or CPU/GPU telemetry;
those signals remain unavailable and Issue #49 stays open.
