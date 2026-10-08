# Task prerequisite diagnostics

Preflight checks the prerequisites selected for a task before starting its
DSH ACP process. It complements the existing Rust `rdsh doctor` wrapper/auth
inventory and reuses the version-checked CLI adapter. It does not implement
profile boot, grant permissions, repair the OS or run a model prompt.

## Requirement input

Use a separate prerequisite description, supplied by the caller from its task
contract. It is not an execution or approval contract:

```json
{
  "schema": 1,
  "cli": "dsh",
  "profile": "acp",
  "min_free_bytes": 16777216,
  "port": 38400,
  "required_files": ["build/manifest.json"]
}
```

| Requirement      | Observation                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Node             | This dashboard/adapter client requires Node 22 or newer                                   |
| cwd              | Existing canonical directory, never created by the diagnostic                             |
| CLI / profile    | Explicit original executable, supported version and ACP profile                           |
| `min_free_bytes` | Available bytes on the cwd filesystem; absent means not required                          |
| `port`           | A loopback bind test; an observation, not a port reservation                              |
| `required_files` | Project-contained dependency files; traversal is rejected                                 |
| `wsl`            | Optional `{ "distribution": "FlashNext" }`; checks that distribution responds             |
| `gpu`            | Optional `{ "min_free_mib": 8192 }`; checks NVIDIA driver inventory and visibility        |
| `auth`           | Optional `{ "provider": "openai" }` or `deepseek`; requires selected API-key verification |

Unselected GPU, WSL, CLI and auth checks return `not_required` without invoking
them. Other CLI adapters and non-ACP profiles remain explicitly unsupported.
NVIDIA inventory establishes driver-visible free memory, without proving CUDA
workload compatibility. WSL probing uses the specified existing distribution
and never creates or replaces one.

## Run and interpret

```sh
node dashboard/preflight.mjs --project /workspace/project \
  --requirements /workspace/task-prerequisites.json \
  --executable /absolute/path/to/original-dsh
node dashboard/cli.mjs preflight --project /workspace/project \
  --requirements /workspace/task-prerequisites.json \
  --executable /absolute/path/to/original-dsh
```

The standalone entrypoint uses Node built-ins before CLI-specific checks, so
it can report missing dashboard dependencies before `npm ci`. Node entrypoints
can additionally specify `--entrypoint /absolute/path/to/bin.js`.

Each item records status, observation time, stage (`existence`, `configuration`
or `communication`), a reason and the smallest relevant fix. The JSON report
is suitable for copying: credential values, arbitrary peer output, response
bodies and the original task JSON are not echoed. A blocked report exits 1.
`ready` concerns only the declared prerequisites at the observation time.
It does not claim execution authority, model access, quota, routing or approval.

To gate session creation or resume, pass the same requirements explicitly:

```sh
node dashboard/cli.mjs session-ledger start --project /workspace/project \
  --requirements /workspace/task-prerequisites.json \
  --executable /absolute/path/to/original-dsh
```

`attachRecordedSession({ ledger, command, requirements })` performs a fresh
preflight before creating its pending ledger record or native CLI session.
Resume uses the recorded cwd. A failed gate carries the safe report in
`PreflightError.report`. The existing native ID/context checks still apply.

## Authentication scope

A credential's presence is a configuration observation, never authentication
success. Required auth stays blocked until explicit verification. Adding
`--verify-auth` makes exactly one selected-provider GET request to
[OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list)
or [DeepSeek models](https://api-docs.deepseek.com/api/list-models/), using only
`OPENAI_API_KEY` or `DEEPSEEK_API_KEY`, respectively. Endpoints are fixed and
redirects are refused. The request sends no model prompt. Timeout, invalid
credentials, malformed responses and unreachable providers remain blocked.

Success is scoped to model-list access. It does not verify a DSH provider route
or model execution. OAuth/subscription credentials need a provider-specific
verification path and are not scanned, imported or silently substituted.
No network verification or credential import occurs by default.

See [captured commands and validation](evidence/task-preflight.md) for real
local observations and fixture-only authentication/failure cases.
