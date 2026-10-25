# Harness comparison benchmark

Runs the same coding tasks through more than one harness, with the same model
and the same prompt, and grades the result with the task tests. It measures
pass/fail and wall time only: not output style, not cost.

## What it needs

- `dsh` on PATH (the DSH headless profile)
- `codex` on PATH (Codex CLI)
- `OPENCODE_GO_API_KEY`, used by both harnesses through the same endpoint

`dsh-patch.yml` points the headless profile at `opencode-go` with the model
under test; `.codex-home/config.toml` does the same for Codex. Both are
generated state, so `.codex-home/` stays out of git.

## Run it

```sh
export OPENCODE_GO_API_KEY=...
python3 run.py --harness dsh --harness codex --out results.json
```

`--task <name>` limits the run to one task, `--timeout` changes the per-task
budget. Grading is `grade.py`, a dependency-free test runner, because pytest is
not guaranteed on the host.

## Tasks

Each directory holds a stub `solution.py` and a `tests/` directory. The agent
gets one prompt: make the tests pass, only edit `solution.py`. Seven tasks:
`parse-duration`, `merge-intervals`, `top-k-words`, `fix-binary-search`,
`dedupe-rows`, `lru-cache`, `token-bucket`.

## Result on 2026-10-25

`results-2026-10-25.json`, model `deepseek-v4.1-flash`, Fedora 44 x86_64:

| Harness | Passed | Median | Total |
| --- | ---: | ---: | ---: |
| DSH via rdsh | 7 / 7 | 24.6 s | 229.6 s |
| Codex CLI | 7 / 7 | 28.0 s | 200.6 s |

Seven small tasks do not separate two harnesses driving the same model. That
is the honest reading, and it is why the site does not claim a quality win.
