# Scoped stop evidence

The complete 115-test Windows suite also passes on Node 22.23.3. The public
checkpoint CLI test has a 60-second outer fixture budget, allowing the explicit
probe/resume/stop sequence to finish on a loaded runner; operation deadlines
remain bounded independently. Stop-history failures retain their original
error as `cause`, alongside the independently observed process result.

Issue: [#35](https://github.com/sahenjp/rustdsh/issues/35).
Contract: [scoped staged stop](../SCOPED-STOP.md).

## Before and after

Baseline ACP adapter entrypoint: ccd60824a255fc19a1bb8645a93b71b7689b150d,
evaluated with the current common dependencies and fixture. An outer owned kernel
group safely cleans up the deliberately surviving baseline descendants after
observation. This comparison does not kill an independent live DSH.

| Observation                                       | Before      | After                           |
| ------------------------------------------------- | ----------- | ------------------------------- |
| Parent stop returned confirmed                    | true        | true                            |
| Child/grandchild heartbeat continued after return | true        | false                           |
| Descendant exit proof                             | unavailable | kernel group empty, 0 remaining |

Actual outputs: [Windows](scoped-stop/before-after-win32.json),
[WSL Linux](scoped-stop/before-after-linux.json). The 150 ms graceful budget is a
fixture deadline, not a performance benchmark.

## Actual browser captures

Before uses baseline HTML/app source with the current isolated fixture backend;
it compares the entry-page UI, not the complete baseline control plane. After
uses the current server, browser authentication and an owned Windows Job fixture.
Five visible PIDs include the three fixture processes and Windows console helpers,
all owned by the Job. This is desktop QA, not physical phone/Tailscale testing.

![Before: no scoped status](scoped-stop/before.png)

![After: running](scoped-stop/after-running.png)

![Stop requested](scoped-stop/after-stopping.png)

![Descendants confirmed empty](scoped-stop/after-confirmed.png)

![Separate run with monitor loss](scoped-stop/after-unverifiable.png)

The [transition GIF](scoped-stop/stop-flow.gif) assembles actual running, requesting
and confirmed captures. Playback timing is illustrative, not measured stop latency.
The unverifiable capture comes from a separate run.

## Process, API and native checks

Seven dedicated tests cover cooperative exit, ignored EOF/TERM, detached
grandchildren, root exit with surviving descendants, another concurrent run,
an independent canary, duplicate requests, deterministic reused-PID fault,
real monitor disconnection and durable history. The PID fault changes the exposed
root PID to the live canary: the retained kernel handle still targets the original
group. It does not claim to force an OS PID recycle. Other-run/canary heartbeats
continue without TERM trace entries.

Actual authenticated HTTP tests observe two human 202 requests, one forced-stop
stage, one durable stop command and subsequent zero-descendant confirmation.
Unauthenticated/MCP requests are refused; administrator-only shutdown is retained.
A lost monitor returns unverifiable; shutdown returns 409, leaving HTTP and the
instance lock available. Test teardown closes that exact server after known
supervisor cleanup and does not reconstruct a persisted PID authority.

[Windows-to-WSL evidence](scoped-stop/wsl-bridge.json) observes byte-identical
Japanese/literal shell characters on native stdio, then confirms the Linux group
empty and resources released. Its target is a Node fixture, not a model invocation.

[Native Web evidence](scoped-stop/native-web-linux.json) uses installed original
DSH 0.2.0-rc.2 with empty HOME/DSH_HOME, disposable state and a free loopback port.
Web startup and the managed group becoming empty are observed. No prompt is sent;
authentication, actual model/tool execution and conversation continuation are
not established by this lifecycle check.

[Independent native process evidence](scoped-stop/independent-native-linux.json)
starts an original DSH Web process outside the managed group and a separate bash
terminal fixture. After the managed tree stops, the original DSH retains the same
birth/scope identity and still answers local HTTP; bash heartbeats continue with
zero TERM observations. Those independently started QA processes are then cleaned
up through their own live child references, separately from the stop under test.

Validation: dashboard 115/115 on Windows and WSL Linux; Rust release 62/62,
regression 41/41, fmt, release Clippy with warnings denied, release build, npm ci,
and 36 Markdown files pass. The Windows installer is exercised with a disposable
launcher directory and correctly co-installs the WSL native prebuilt. The seven
scope/API tests also pass inside a systemd 255 delegated service running as uid
65534, covering the non-root delegation topology used by CI. A final resource
release adjustment is rechecked by all 24 scope/ACP tests on Windows and the seven
non-root Linux scope/API tests.
