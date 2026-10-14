# Windows retry fixture investigation — 2026-10-14

## Outcome

Only `dashboard/test/retry.test.mjs` changed. The positive real-process integration fixture now supplies total_ms 30000 instead of 10000. Its requestTimeout 700, max_attempts 3, expected two attempts, counter 2, version match, durable CLI inspection and no-profile-boot assertions remain. It additionally requires exactly one execute_failed entry, attempt 1/category timeout, and prints the retry record if completion fails. No product source, deadline, fingerprint, environment setting, CLI payload or negative test changed.

## Confirmed observations

- Original Windows normal full run: 330 tests; 323 pass, 1 fail, 6 skip; the only failure was this fixture, expected completed but received budget_exhausted after 14360 ms. Log: /tmp/rdsh-languages-final-dashboard-windows.log. The discarded original fixture history prevents assigning that exact original failure to a specific event.
- Original focused actual test passed twice before editing, each approximately 2.8 seconds including test runner startup.
- Instrumented exact product probe with unchanged original 700/10000 parameters passed 2/2 when isolated: elapsed 1305–1339 ms, actual child calls total 777–790 ms, completed fingerprint streams total 465–479 ms, nine history saves total 16–18 ms. Each query hashes a 93,580,104-byte node.exe; five full scans occur for two authorized attempts. Fsync duration is included in history-save duration, not additive.
- 12 parallel isolated probe processes, two rounds each: 24/24 completed. 40 parallel processes, two rounds each: 80/80 completed; completed fingerprint streams totaled 6396–9538 ms, child calls 857–971 ms, saves 64–143 ms.
- Final 48 parallel processes, two rounds each: 96 total probe operations, 79 completed, 17 budget_exhausted. Failed operations ended with elapsed_budget_exhausted, retry elapsed around 10003–10024 ms. Actual full elapsed reached 13082 ms because initial fingerprinting precedes the retry clock. Completed fingerprint streams totaled 8394–11938 ms; child calls totaled 749–961 ms; history saves 71–145 ms. An aborted fingerprint stream is not counted as completed and therefore these stream totals can undercount failed scans.
- Example parallel-4 round-0: attempt_started(2) at 7631 ms, stopped at 10005 ms without second dispatch, counter 1: the second authorization exceeded the total budget. Example parallel-1 round-0: second dispatch at 9802 ms after repeated hashes; the second child exited successfully in 169 ms but the operation stopped at 10004 ms. This establishes a real Windows mechanism matching the reported status without a slow successful child or slow persistence.
- All observed children had exited (exit_code 0 or termination signal SIGTERM); fixtures never started ACP profile boot. All child homes and evidence belong to the isolated task root. No user setting or account file was changed.

## Interpretation and fixture correction

Full-suite contention is consistent with the original failure, but original full-run event timing was not retained. The controlled focused runs directly demonstrate repeated executable authorization consuming the 10-second positive-fixture budget. A 30-second total gives this functionality test room for genuine hashing under parallel load, while its intentionally hanging first child is still terminated at 700 ms. Existing elapsed/attempt/delay cap, cooperative abort/late-response and durable-persistence deadline negative tests remain byte-for-byte unchanged and passed in both final focused suites.

## Final verification

- macOS: node --check dashboard/test/retry.test.mjs — exit 0.
- macOS: node --test dashboard/test/retry.test.mjs — exit 0, 14 pass, 0 fail, 0 skip. Log /tmp/rdsh-retry-macos-focused-final.log.
- Windows pinned Node 24.21.0: node --check test/retry.test.mjs — exit 0.
- Windows pinned Node 24.21.0: node --test test/retry.test.mjs — exit 0, 14 pass, 0 fail, 0 skip; 4797 ms. Logs /tmp/rdsh-retry-windows-final/retry-suite-final.{stdout,stderr}.log.
- git diff --check -- dashboard/test/retry.test.mjs — exit 0.
- Parent final normal Windows `npm test`, after source SHA-256 synchronization: 336 tests, 330 pass, 0 fail, 6 platform skips, exit 0. See [the final output](dashboard-windows-final.txt).

## Evidence

Windows 11 x64; pinned Node 24.21.0. Every observer verifies the task ownership marker before writing its private evidence root.

Remote original focused/measurement evidence: test-evidence/retry-observe-562d8b61a2934614a157311c5f13a433.
Remote 48-process reproduction evidence: test-evidence/retry-observe-8fcfbe4a68a74bf6b0b5288d4dd67350.
Remote final suite evidence: test-evidence/retry-observe-bf6030d163d2414e9831966e04d89738.
Local reproduction summary: /tmp/rdsh-retry-parallel-48.log.
Local event histories: /tmp/rdsh-retry-windows-budget-reproduction/{authorization-expired,dispatch-expired}.json.
Local observation scripts: /tmp/rdsh-retry-observe.{mjs,ps1}, /tmp/rdsh-retry-parallel.{mjs,ps1}, /tmp/rdsh-retry-final.ps1. Observers delegate to actual process execution, hashing, fsync and history persistence; no production file was instrumented. The observational harness exits zero when collection completes, so its aggregate exit is not a completed-operation assertion; its per-operation JSON explicitly records the 17 exhausted budgets.
