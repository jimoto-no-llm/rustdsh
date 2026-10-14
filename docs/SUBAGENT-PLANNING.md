# Subagent dispatch planning

`rdsh subagents plan` turns a declared piece of work into a deterministic plan
for delegated subagents: which role, which model tier, how many items per
agent, and in which waves. It is the step before
[worker workspaces](WORKER-WORKSPACES.md): the plan says *what* to delegate,
`workers prepare` allocates the checkout for it.

The planner lives in `src/subagent_plan.rs`; the dashboard JavaScript module it
was ported from is gone, so this command is the single source of truth. It
starts no agent, calls no provider and writes nothing. It reads one local
request file and prints JSON.

## Request

```json
{
  "use_case": "review",
  "tiers": {
    "fast": { "provider": "example-provider", "model": "example-small", "effort": "low" },
    "balanced": { "provider": "example-provider", "model": "example-mid", "effort": "medium" },
    "deep": { "provider": "example-provider", "model": "example-large", "effort": "high" }
  },
  "limits": {
    "max_parallel": 2,
    "max_items_per_agent": 2,
    "max_weight_per_agent": 6,
    "budget_units": 40
  },
  "items": [
    { "id": "pr-460", "weight": 4, "signals": { "files": 30, "risk": "security" } },
    { "id": "pr-458", "weight": 2, "signals": { "files": 12 } }
  ]
}
```

- `use_case` picks the role and the baseline tier: `research` and `review`
  (read-only), `audit` (read-only, deep), `implement`, `fix` and `migrate`.
- `tiers` are the routes the operator is willing to pay for: `fast`,
  `balanced` and `deep`, each `{provider, model, effort}` where `effort`
  is null or a label. A tier the plan wants but the request does not declare is
  never invented: the plan falls back to the closest declared tier and reports
  `tier-missing`.
- `items` describe the work (1-200 unique ids of 1-128 characters). `weight`
  (1-64) is relative effort, `signals.files` the touched-file count,
  `signals.risk` one of `low`/`normal`/`high`/`security`, and
  `signals.unknown` marks work whose scope is not yet known.
- `limits` bound parallelism, items and weight per agent, and an optional
  budget in cost units (fast 1, balanced 3, deep 9, multiplied by weight).

```sh
rdsh subagents plan --input-file subagents.json
```

`--json` is accepted for scripts; JSON is always the output format. A request
that cannot produce a plan exits 1 with the error code on stderr, for example
`Subagent plan: duplicate-item:pr-460`. The input must be a regular JSON file
of at most 256 KiB.

## Plan

The output groups items by tier so one agent always runs one model, packs each
tier's items into agents without exceeding the weight or item limits, and splits
the agents into waves of at most `max_parallel`. Totals and warnings close the
report:

- `tier-missing` — the wanted tier was not declared; `used` names the fallback.
- `item-too-large` — a single item exceeds `max_weight_per_agent`. The plan
  keeps it (a planner never splits work silently) and asks the operator to
  split it or raise the limit.
- `budget-exceeded` — the plan costs more than `budget_units`.

Warnings are sorted by `code` and then by `item`, using the ordering the
JavaScript planner produced with `localeCompare`. Malformed requests are
refused by name (`invalid-item-signals`, `duplicate-item`,
`invalid-limits`, ...) rather than repaired. The same request always produces
the same plan.
