# rdsh ↔ Harness² Python seam

This module uses Google's **actual** `harness2.core.recursion.run_parallel(k=1)`:
one baseline, independent invariant/domain proposals, two probe executions, one
composition proposal, and one final execution. It then uses upstream
`selection.trivial_selection` for the single final. It does not approximate that
schedule in a home-grown optimization loop. No reflection or cross-task library
is currently run. Holdouts receive a frozen harness from the last successful
training aggregate, and never enter improvement context. A validated,
model-authored aggregate with a delivered final can be tested on holdouts even
when an earlier proposal or probe failed. The training row, `complete`, and
`adaptationComplete` remain false; `fallbackWarnings` and `frozenHarnessOrigin`
identify the failure and aggregate provenance. A fallback aggregate is never
adopted automatically.

The source checkout must be clean under `harness2/` at
`1cfe254e8d25b15f37048c3730134686abe60335`. `compare()` verifies this before running.
Use Python 3.12 or 3.13 as declared by upstream; the integration has no additional
Python dependencies.

Upstream currently hardcodes prompt surfaces to `opencode` and `codex` in its
private `_SURFACE_TEXTS` registry. The adapter adds an `rdsh` entry using
`_SurfaceText`, without modifying upstream source, existing entries, recursion,
selection, or validation algorithms. This is a pinned compatibility shim, not a
stable upstream API. Revalidate it when upgrading Harness². `ChannelSpec` also
has a fixed built-in enum, so its metadata uses `opencode`; no OpenCode process
is launched. The actual transport and all report identity are explicitly rdsh.

```sh
PYTHONPATH=/absolute/plugin/python /absolute/harness2/.venv/bin/python \
  /absolute/plugin/python/rdsh_harness2.py \
  --suite /absolute/plugin/evaluation/small-tasks.json \
  --runner /absolute/plugin/runner.mjs \
  --provider PROVIDER --model MODEL --output /absolute/new-run-directory
```

The output directory must not already exist. `--timeout-ms` defaults to 120000,
`--max-steps` to 12; provider/model are always explicit. There is no fake provider
or fake comparison switch in the production CLI. Test doubles exist only under
`tests/`.

To evaluate an explicitly chosen prior completed harness without any new model
improvement sessions, add `--frozen-harness /absolute/prior/harness-directory`.
This mutually exclusive execution mode skips all training/adaptation and runs
baseline versus the supplied validated Markdown harness on **holdouts only**.
The report method is `frozen-only`, training session count is zero, and
`frozenHarnessSource` records the explicit input path and content fingerprint.
It never silently adopts a failed stage or fallback. Supply additional original
training/model provenance alongside the report if needed; this mode does not
infer it from the directory name. All normal path/symlink/size checks apply.

Suite schema is strict JSON:

```json
{
  "version": 1,
  "name": "my-suite",
  "tasks": [{
    "id": "safe-task-id",
    "split": "train",
    "domain": "source-analysis",
    "prompt": "Read data.json; return its value as JSON.",
    "files": {"data.json": "{\"value\":7}"},
    "expected": {"value":7}
  }]
}
```

Use `holdout` for unseen tasks; at least one `train` task is required. Expected
answers stay in Python memory and the original suite. Only `files` enter solver
workspaces; only source files, task prompts, authored answers, trajectories and
harnesses enter improvement context. Judging happens after adoption; the score
never enters improvement context. Exact canonical JSON is required; Markdown
fences and additional explanatory prose fail the JSON check.

`report.json` distinguishes task-local training and frozen-harness holdouts,
lists incomplete/fallback stages, counts every solver/improver session, reports
training overhead separately, and records token usage when available. Unknown
usage and unknown monetary cost are `null`, never fabricated zero. The native
upstream internal cost defaults are not monetary evidence and are replaced with
`null` in the exported method record. Session wall time sums and end-to-end wall
time are distinct fields.

Invalid proposal JSON/patches follow upstream's bounded stage retry. Their exact
validation message is appended to the next attempt, persisted privately as
`validation-error.json`, and included in `proposalValidationErrors` in the report.

Only `systemprompt.md`, `tool-guidance.md` and
`skills/<lowercase_name>/SKILL.md` are editable; no executable scripts, policies,
hooks, tools, permissions or auth configuration. Markdown is validated again
before materialization. No symlinks or path escapes; file and total byte caps
apply. Run roots are mode 0700, request/response/report files mode 0600. Reports
and audit artifacts can include task source text and model-authored output;
review them before sharing.

Tests with the real pinned upstream library and an explicit test double:

```sh
PYTHONPATH=/absolute/plugin/python /absolute/harness2/.venv/bin/python \
  -m unittest discover -s /absolute/plugin/python/tests -v
```

For source repair and test execution, use `rdsh_coding.py` with
`evaluation/coding-tasks.json` and the same runner/provider/model arguments.
The coding schema replaces `expected` with `editableFiles`, `testFiles`,
`hiddenTests` and optional `hiddenTestCount`; see the bundled suite and task
design document. Each rollout starts from the original source. Only declared
source files may be edited; the original public tests are immutable. The native
solver receives read/edit/fixed-public-test tools, while improvers remain
read-only. Hidden tests and scores stay outside improvement context.

For independent training rounds and balanced paired repeats, use
`rdsh_coding_repeated.py` with `evaluation/coding-expanded-tasks.json` and
`--rounds 3 --workers 2 --seed 271828`. The plugin README contains the complete
command. Run inputs and code hashes are frozen; `--resume` reuses completed
results without automatically repeating a started but interrupted model call.
The report separates native failures, grading errors, semantic eligible pairs,
task-level uncertainty, and training/solver time. The seed controls ordering and
analysis, not provider generation. See `evaluation/coding-expanded-RESULTS.md`
for the original suite's config-wording ambiguity and posthoc sensitivity.

After selection, the host grader reruns public and hidden tests in the required
macOS OS sandbox. A complete delivery requires a real edit and test action,
unchanged public tests, allowed source changes and every hidden test passing.
Source artifacts, diffs, action counts, native failures and grading failures
are recorded separately. This is a small fixture benchmark; its source policy
and manual artifact review do not establish a general hostile-JavaScript
grading boundary.
