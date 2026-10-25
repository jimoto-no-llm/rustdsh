# Harness comparison benchmark

Runs the same coding tasks through several harnesses, with the same model and
the same prompt, and grades the result with the task tests. It measures
pass/fail and wall time only: not output style, not cost.

Five harnesses are wired up: DSH (through rdsh), Codex CLI, opencode,
Claude Code and Gemini CLI. The last two only speak their vendor API, so
`proxy.py` translates Anthropic Messages and Gemini generateContent into the
OpenAI chat endpoint under test.

## What it needs

- `dsh` on PATH (the DSH headless profile)
- `codex` on PATH (Codex CLI)
- `opencode`, `claude` and `gemini` on PATH for those harnesses
- `OPENCODE_GO_API_KEY`, used by every harness through the same endpoint

`dsh-patch.yml` points the headless profile at `opencode-go` with the model
under test; `.codex-home/config.toml` does the same for Codex, and
`opencode.json` for opencode. `run.py` starts `proxy.py` on demand for Claude
Code and Gemini CLI. `.codex-home/` is generated state and stays out of git.

The endpoint routes by session and rejects the HTTP/1.1 fingerprint urllib
presents, so `proxy.py` sends `x-opencode-session` and shells out to curl.

## Run it

```sh
export OPENCODE_GO_API_KEY=...
python3 run.py --harness dsh --harness codex --harness claude --harness gemini --out results.json
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
| Claude Code | 6 / 7 | 36.5 s | 514.1 s |
| Gemini CLI | 6 / 7 | 18.2 s | 411.3 s |
| opencode | 6 / 7 | 45.4 s | 345.0 s |

Two harnesses passed all seven; three missed one each, so the harness does
change the outcome even with the same model. Seven single runs prove no
statistic, and the site does not claim a quality win.
