# Windows startup observations

This records the local source at `8785f2f26a71d3e4720efc692912da64ae5d41b1`
against the original `fdaded938cf6b434929027e083a01747ec1ee229` helper.
[Raw results](windows.json) retain three alternating real NotifyIcon process
startups per version, source hashes and observed normal helper exits. Dummy
labels were used; no browser, model or provider API was opened.

| Local Windows / Node 22.23.3           | Original | CLR delegate and diagnostics |
| -------------------------------------- | -------: | ---------------------------: |
| Ready median, ms                       |   759.80 |                       461.86 |
| Start through observed exit median, ms |   980.99 |                       629.17 |

The helper uses a direct CLR `Console.ReadLine` delegate on the thread pool
instead of compiling a new C# type on each startup. The native menu fixture
compiles its screenshot helper only when evidence capture is requested.
The production ready deadline remains 15 seconds, launcher deadline 60 seconds,
and native fixture deadline 25 seconds. The external routing fixture allows its
existing owned-process cleanup to finish, as in the author's icon PR.

The parent records bounded elapsed times for spawn, PowerShell start, assembly
load, stdin reader, ready and exit. Node/PowerShell versions, exit code/signal,
and cleanup exit observation are included. Stderr is drained but only its first
16 KiB hash, byte count and truncation flag are retained. No raw stderr, URL,
credentials or label enters these observations. CLI startup failures forward
this same diagnostic through the private launcher IPC channel; successful
launches retain the ordinary user output. Routing fixtures emit elapsed phase,
exit/signal and byte-count diagnostics without prompt contents.

All 25 focused Windows routing/launcher/tray tests passed, including the actual
menu actions, another project's liveness, normal NotifyIcon disposal, bounded
diagnostic privacy, and a virtual deadline applied to a real never-ready helper.
That timeout test observed the exact helper's SIGTERM exit rather than treating
the elapsed deadline as proof. Native fixture cancellation also kills and waits
for only its captured child, with a fresh bounded exit wait.

These local process samples do not reproduce or establish the root cause of the
hosted runner's intermittent timeout in Issue #209. Subsequent CI logs include
the real stage timings and failure observations needed for that investigation.
The issue remains open until its actual acceptance is satisfied after merge.

From `dashboard`, reproduce the focused checks with:

```powershell
node --test --test-concurrency=1 test/windows-tray.test.mjs test/windows-launcher.test.mjs test/model-routing.test.mjs
```

## Integration with the merged icon

The observations above retain the original `8785f2f` measurement. A second
series compares actual main `93b3bcaa7759fb27461b02f1dd0b0012e946b329` with
source `81c4efeed56cafb5fa34ae8a7b185bb29526ba54`; both helpers load the merged
brand icon. [Current main comparison](windows-main93.json) retains all six
normal helper exits, alternating samples and each measured file's hash.

| Local Windows / Node 22.23.3           | Main 93b3bca | Current helper |
| -------------------------------------- | -----------: | -------------: |
| Ready median, ms                       |       827.51 |         490.88 |
| Start through observed exit median, ms |     1,054.90 |         666.48 |

The current source passed all 46 Windows process-scope, checkpoint, routing,
launcher and tray checks without failure, cancellation or skip. Earlier source
`2283ac1` passed all 198 dashboard tests; this is separate evidence rather than
a claim that the whole suite ran on `81c4efe`.

The integration also fixes a distinct owned-process observation race seen in
the Windows `answer-applications` CI: the Job PID list and accounting query can
disagree while a child exits or spawns. Both must be empty before an
`exit_confirmed` proof is returned. Contradictions remain `running`, preserving
the existing stop verification and journal checks. The regression covers both
query orders without relaxing any startup or stop deadline. Full-suite and
hosted runner results must still be checked on the final PR head.

## Verification after main 492bae4

The latest Windows run used Node 24.18.0 and PowerShell 7.6.6. All 50 targeted
routing, launcher, tray, adapter and process-scope tests passed after the
main sync. The routing fixture kept its original 20-second outer deadline and
recorded bind at 295 ms, probe at 1,663 ms and inspect at 272 ms. A normal tray
helper reported ready at 708 ms and exited normally at 890 ms. The virtual
timeout case observed readiness timeout at 498 ms and the same helper's
SIGTERM exit at 511 ms, with cleanup confirmation.

This run does not reproduce the hosted runner's intermittent timeout, so it
does not establish Issue #209's root cause. The CI failure boundary remains
open for evidence from a recurrence. Reproduce the complete targeted set from
the repository root with:

```powershell
node --test dashboard/test/model-routing.test.mjs dashboard/test/windows-launcher.test.mjs dashboard/test/windows-tray.test.mjs dashboard/test/adapters.test.mjs dashboard/test/process-scope.test.mjs
```
