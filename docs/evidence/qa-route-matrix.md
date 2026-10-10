# QA route matrix

The browser E2E job writes `qa-matrix.json` and a filterable `qa-matrix.html`
beside its screenshots in the `browser-e2e` artifact. Each result includes the
tested source SHA, observation time, browser, viewport or connection class, and
an evidence reference. The HTML filter can show only `Not run`, `Blocked`, `Fail`,
or `Pass` rows.

The matrix distinguishes four evidence modes: automated fixture, actual browser,
physical device, and real connection. A result is current only when its SHA equals
the source SHA supplied to that browser run, and its mode matches the case. An old
result or a fixture/browser result for a device or connection case stays `Not run`
and retains the old result as stale context.

The automated browser run covers draft retention during an SSE update, a real
double-click, retry after the browser is taken offline before submit, a committed
answer whose response is dropped, persistence after process restart, and the
390×844 viewport. The browser uses synthetic questions and a loopback dashboard;
these checks do not use a real phone, WSL bridge, Tailscale network, or model.

Physical phone use, keyboard-only navigation, browser Back, decision cancellation,
mobile reply interruptions, WSL proxy recovery, and real Tailscale reconnection
remain explicitly `Not run` until matching evidence is recorded. Passing a local
fixture or a browser viewport never promotes those rows.

Reproduce the browser artifact with the commands in [the E2E README](../../tests/e2e/README.md).
