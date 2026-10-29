# Expanded maintenance tasks B

Two new holdout tasks, each with two editable source modules, two public tests,
and ten hidden tests. `coding-extra-b.json` is a `{tasks:[...]}` fragment for the
expanded suite. The public tests expose one failure in each initial fixture.
Hidden tests are never included in the solver workspace.

| Task | Repair dimensions | Initial public | Initial hidden | Independent reference |
| --- | --- | --- | --- | --- |
| `retry-backoff` | One-based attempts; capped exponential delay including zero/overflow; synchronous and asynchronous failures; awaited retry decisions and waits; callback error identity; exhaustion; validation | 1/2 | 4/10 | Public 2/2; hidden 10/10 |
| `csv-roundtrip` | CSV quote state; escaped quotes; mixed and embedded record delimiters; blank document/record/field distinctions; strict malformed syntax; serialization and roundtrip; validation and immutability | 1/2 | 0/10 | Public 2/2; hidden 10/10 |

Every hidden test has a flat `node:test` declaration, matching `hiddenTestCount`.
Promises are controlled by injected callbacks, with no wall-clock sleeps or
real network requests. Retry semantics explicitly define when decisions and
waits occur, their argument values, and which failure identity propagates.
CSV semantics explicitly define each boundary tested, including the otherwise
ambiguous empty-document case, all record delimiters, strict characters after
a closing quote, and quoted empty fields on serialization.

The references were independently written from the stated contract, stored
only under `.local/harness2/expanded-fixtures-b/<task>/reference/`, and were not
embedded in the suite. The validation driver and machine-readable results are
in `.local/harness2/expanded-fixtures-b/validate.mjs` and `validation.json`.
Validation used production `gradeCoding`, the macOS `sandbox-exec` runner,
and the `pure-esm-fixture-v1` source policy. All eight grader invocations
completed without a timeout or output limit. Initial fixtures failed as
expected; references passed all 4 public and 20 hidden assertions.

The source policy is a narrow fixture policy, not a hostile-code isolation
claim. In particular, the CSV reference uses string membership to recognize
special characters because the policy rejects the `test` token even when
used as a regular-expression method. This is a runner constraint shared by
both comparison arms.

No live model calls, credentials, commits, or pushes were performed for this
task construction and fixture validation.
