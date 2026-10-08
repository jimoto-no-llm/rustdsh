// Reported observations only. No billing scrape, price lookup or model call.
export const costSources = [
  "provider_usage",
  "cli_report",
  "api_estimate",
  "invoice_actual",
];
const certaintyFor = {
  provider_usage: "reported",
  cli_report: "reported",
  api_estimate: "estimated",
  invoice_actual: "confirmed",
};
const scale = 1000000000n;
const scopeKeys = [
  "scope_id",
  "project_id",
  "period_start",
  "period_end",
  "membership_complete",
  "targets",
];
const targetKeys = [
  "target_id",
  "worker_id",
  "session_id",
  "run_id",
  "provider",
  "model",
];
const reportKeys = [
  "event_id",
  "scope_id",
  "target_id",
  "source_kind",
  "source_ref",
  "observed_at",
  "mode",
  "sequence",
  "currency",
  "amount",
  "certainty",
  "tokens",
  "basis",
];
const tokenKeys = ["input", "cached_input", "output"];
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
function check(ok, reason, status = 400) {
  if (ok) return;
  const error = new Error(`Cost ledger: ${reason}`);
  error.status = status;
  throw error;
}
function shape(value, keys) {
  check(
    object(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    "unexpected or missing fields",
  );
}
function id(value) {
  check(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) &&
      !["constructor", "prototype", "__proto__"].includes(value),
    "invalid identifier",
  );
  return value;
}
function text(value, max = 1000) {
  check(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= max &&
      !/[\x00-\x1f\x7f]/.test(value),
    "invalid source text",
  );
  return value;
}
function optional(value) {
  return value === null ? null : text(value, 160);
}
function time(value) {
  check(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "UTC timestamp required",
  );
  const canonical = new Date(value).toISOString();
  check(
    canonical === (value.length === 20 ? value.slice(0, -1) + ".000Z" : value),
    "invalid UTC timestamp",
  );
  return canonical;
}
function units(value) {
  check(
    typeof value === "string" &&
      /^(?:0|[1-9]\d{0,15})(?:\.\d{1,9})?$/.test(value),
    "amount must be a nonnegative decimal string with at most 9 fractional digits",
  );
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * scale + BigInt(fraction.padEnd(9, "0"));
}
function decimal(value) {
  const fraction = (value % scale)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return (value / scale).toString() + (fraction ? "." + fraction : "");
}
function scopeInput(input, projectId) {
  shape(input, scopeKeys);
  check(input.project_id === projectId, "scope belongs to another project");
  const start = time(input.period_start),
    end = time(input.period_end);
  check(start < end, "period must have a positive duration");
  check(
    typeof input.membership_complete === "boolean",
    "membership_complete must be explicit",
  );
  check(
    Array.isArray(input.targets) &&
      input.targets.length > 0 &&
      input.targets.length <= 100,
    "declare 1 to 100 expected targets",
  );
  const ids = new Set(),
    identities = new Set();
  const targets = input.targets
    .map((target) => {
      shape(target, targetKeys);
      const value = {
        target_id: id(target.target_id),
        worker_id: id(target.worker_id),
        session_id: text(target.session_id, 160),
        run_id: optional(target.run_id),
        provider: optional(target.provider),
        model: optional(target.model),
      };
      const identity = JSON.stringify([
        value.worker_id,
        value.session_id,
        value.provider,
        value.model,
      ]);
      check(
        !ids.has(value.target_id) && !identities.has(identity),
        "duplicate target identity",
      );
      ids.add(value.target_id);
      identities.add(identity);
      return value;
    })
    .sort((a, b) =>
      a.target_id < b.target_id ? -1 : a.target_id > b.target_id ? 1 : 0,
    );
  return {
    scope_id: id(input.scope_id),
    project_id: projectId,
    period_start: start,
    period_end: end,
    membership_complete: input.membership_complete,
    targets,
  };
}
function reportInput(input, scope) {
  shape(input, reportKeys);
  check(costSources.includes(input.source_kind), "unknown source kind");
  check(input.scope_id === scope.scope_id, "unknown scope");
  check(
    input.target_id === null
      ? input.source_kind === "invoice_actual"
      : scope.targets.some((target) => target.target_id === input.target_id),
    "unknown target; only an unallocated invoice may use null",
  );
  check(["event", "cumulative"].includes(input.mode), "invalid report mode");
  check(
    Number.isSafeInteger(input.sequence) && input.sequence >= 1,
    "positive stable sequence required",
  );
  check(
    typeof input.currency === "string" && /^[A-Z]{3}$/.test(input.currency),
    "currency must be an explicit three-letter code",
  );
  check(
    input.amount === null
      ? input.certainty === "unknown"
      : input.certainty === certaintyFor[input.source_kind],
    "certainty must match the amount and source",
  );
  const amount = input.amount === null ? null : decimal(units(input.amount));
  let tokens = null;
  if (input.tokens !== null) {
    shape(input.tokens, tokenKeys);
    check(
      tokenKeys.every(
        (key) =>
          input.tokens[key] === null ||
          (Number.isSafeInteger(input.tokens[key]) && input.tokens[key] >= 0),
      ),
      "invalid reported token counter",
    );
    check(
      input.tokens.input === null ||
        input.tokens.cached_input === null ||
        input.tokens.cached_input <= input.tokens.input,
      "cached input exceeds input",
    );
    tokens = Object.fromEntries(
      tokenKeys.map((key) => [key, input.tokens[key]]),
    );
  }
  const observed = time(input.observed_at);
  check(observed >= scope.period_start, "observation precedes its period");
  return {
    event_id: id(input.event_id),
    scope_id: scope.scope_id,
    target_id: input.target_id,
    source_kind: input.source_kind,
    source_ref: text(input.source_ref),
    observed_at: observed,
    mode: input.mode,
    sequence: input.sequence,
    currency: input.currency,
    amount,
    certainty: input.certainty,
    tokens,
    basis: text(input.basis, 2000),
  };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const laneKey = (report) =>
  JSON.stringify([report.scope_id, report.target_id, report.source_kind]);
function reportIndex(reports) {
  const lanes = new Map();
  for (const report of reports) {
    const key = laneKey(report);
    if (!lanes.has(key)) lanes.set(key, new Map());
    const lane = lanes.get(key),
      first = lane.values().next().value;
    check(
      !first ||
        (first.mode === report.mode && first.currency === report.currency),
      "do not mix event/cumulative modes or currencies in one source stream",
      409,
    );
    const prior = lane.get(report.sequence);
    check(
      !prior ||
        equal(
          { ...prior, event_id: null, received_at: null },
          { ...report, event_id: null, received_at: null },
        ),
      "sequence already refers to a different observation",
      409,
    );
    if (!prior) lane.set(report.sequence, report);
  }
  for (const lane of lanes.values()) {
    const sorted = [...lane.values()].sort((a, b) => a.sequence - b.sequence);
    if (sorted[0].mode !== "cumulative") continue;
    const known = {};
    let previousTime = null;
    for (const report of sorted) {
      check(
        previousTime === null || report.observed_at >= previousTime,
        "cumulative observation time moved backwards",
        409,
      );
      previousTime = report.observed_at;
      const values = {
        amount: report.amount === null ? null : units(report.amount),
        ...Object.fromEntries(
          tokenKeys.map((key) => [
            key,
            report.tokens?.[key] == null ? null : BigInt(report.tokens[key]),
          ]),
        ),
      };
      for (const [key, value] of Object.entries(values)) {
        if (value === null) continue;
        check(
          known[key] === undefined || value >= known[key],
          "cumulative counter decreased; declare a new period for a meter reset",
          409,
        );
        known[key] = value;
      }
    }
  }
  return lanes;
}
function registry(state) {
  state.cost_ledger ||= {
    schema: 1,
    project_id: state.project.id,
    scopes: {},
    reports: {},
  };
  return state.cost_ledger;
}
export function declareCostScope(state, input) {
  const scope = scopeInput(input, state.project.id),
    ledger = registry(state);
  if (Object.hasOwn(ledger.scopes, scope.scope_id)) {
    const { declared_at, ...prior } = ledger.scopes[scope.scope_id];
    check(equal(prior, scope), "scope identity is immutable", 409);
    return;
  }
  check(
    Object.keys(ledger.scopes).length < 100,
    "scope retention limit reached",
  );
  ledger.scopes[scope.scope_id] = {
    ...scope,
    declared_at: new Date().toISOString(),
  };
}
export function recordCostReport(state, input) {
  const ledger = state.cost_ledger;
  check(
    object(input) && ledger && Object.hasOwn(ledger.scopes, input.scope_id),
    "declare the exact scope before reporting",
  );
  const report = reportInput(input, ledger.scopes[input.scope_id]);
  if (Object.hasOwn(ledger.reports, report.event_id)) {
    const { received_at, ...prior } = ledger.reports[report.event_id];
    check(
      equal(prior, report),
      "event ID already refers to different data",
      409,
    );
    return;
  }
  check(
    Object.keys(ledger.reports).length < 10000,
    "report retention limit reached",
  );
  const stored = { ...report, received_at: new Date().toISOString() };
  reportIndex([...Object.values(ledger.reports), stored]);
  ledger.reports[report.event_id] = stored;
}
export function validateCostLedger(state) {
  if (state.cost_ledger === undefined) return;
  const ledger = state.cost_ledger;
  shape(ledger, ["schema", "project_id", "scopes", "reports"]);
  check(
    ledger.schema === 1 &&
      ledger.project_id === state.project.id &&
      object(ledger.scopes) &&
      object(ledger.reports),
    "invalid ledger identity",
  );
  check(
    Object.keys(ledger.scopes).length <= 100 &&
      Object.keys(ledger.reports).length <= 10000,
    "retention limit exceeded",
  );
  for (const [key, scope] of Object.entries(ledger.scopes)) {
    shape(scope, [...scopeKeys, "declared_at"]);
    const { declared_at, ...input } = scope;
    check(
      key === scope.scope_id &&
        time(declared_at) === declared_at &&
        equal(input, scopeInput(input, state.project.id)),
      "invalid stored scope",
    );
  }
  for (const [key, report] of Object.entries(ledger.reports)) {
    shape(report, [...reportKeys, "received_at"]);
    const { received_at, ...input } = report;
    check(
      Object.hasOwn(ledger.scopes, input.scope_id),
      "stored report scope missing",
    );
    check(
      key === report.event_id &&
        time(received_at) === received_at &&
        equal(input, reportInput(input, ledger.scopes[input.scope_id])),
      "invalid stored report",
    );
  }
  reportIndex(Object.values(ledger.reports));
}
export function publicCostLedger(state) {
  if (!state.cost_ledger) return null;
  const ledger = state.cost_ledger,
    reports = Object.values(ledger.reports);
  const lanes = reportIndex(reports),
    selected = new Set();
  for (const lane of lanes.values()) {
    const values = [...lane.values()].sort((a, b) => a.sequence - b.sequence);
    for (const report of values[0].mode === "cumulative"
      ? values.slice(-1)
      : values)
      selected.add(report.event_id);
  }
  const byScope = new Map();
  for (const report of reports) {
    if (!byScope.has(report.scope_id)) byScope.set(report.scope_id, []);
    byScope
      .get(report.scope_id)
      .push({ ...report, included: selected.has(report.event_id) });
  }
  const scopes = Object.values(ledger.scopes)
    .map((scope) => {
      const entries = (byScope.get(scope.scope_id) || []).sort(
        (a, b) =>
          b.observed_at.localeCompare(a.observed_at) ||
          b.sequence - a.sequence ||
          a.event_id.localeCompare(b.event_id),
      );
      const groups = new Map();
      for (const report of entries.filter((entry) => entry.included)) {
        const level = report.target_id === null ? "project_invoice" : "targets";
        const key = JSON.stringify([
          report.source_kind,
          report.currency,
          level,
        ]);
        if (!groups.has(key))
          groups.set(key, {
            source_kind: report.source_kind,
            currency: report.currency,
            level,
            rows: [],
          });
        groups.get(key).rows.push(report);
      }
      const totals = [...groups.values()]
        .map(({ rows, ...group }) => {
          const known = rows.filter((row) => row.amount !== null);
          const missing =
            group.level === "project_invoice"
              ? []
              : scope.targets
                  .filter(
                    (target) =>
                      !rows.some(
                        (row) =>
                          row.target_id === target.target_id &&
                          row.amount !== null,
                      ) ||
                      rows.some(
                        (row) =>
                          row.target_id === target.target_id &&
                          row.amount === null,
                      ),
                  )
                  .map((target) => target.target_id);
          const partial =
            !scope.membership_complete ||
            missing.length > 0 ||
            rows.some((row) => row.amount === null);
          const tokens = Object.fromEntries(
            tokenKeys.map((key) => {
              const counters = rows.map((row) => row.tokens?.[key]);
              const valid = counters.filter((value) => value != null);
              return [
                key,
                {
                  value: valid.length
                    ? valid
                        .reduce((sum, value) => sum + BigInt(value), 0n)
                        .toString()
                    : null,
                  partial: valid.length < rows.length || partial,
                },
              ];
            }),
          );
          return {
            ...group,
            amount: known.length
              ? decimal(known.reduce((sum, row) => sum + units(row.amount), 0n))
              : null,
            certainty: known.length
              ? certaintyFor[group.source_kind]
              : "unknown",
            partial,
            missing_targets: missing,
            covered_targets: [
              ...new Set(
                known
                  .map((row) => row.target_id)
                  .filter((id) => id !== null && !missing.includes(id)),
              ),
            ],
            included_reports: rows.length,
            observed_at: rows.reduce(
              (latest, row) =>
                row.observed_at > latest ? row.observed_at : latest,
              "",
            ),
            tokens,
          };
        })
        .sort(
          (a, b) =>
            costSources.indexOf(a.source_kind) -
              costSources.indexOf(b.source_kind) ||
            a.currency.localeCompare(b.currency) ||
            a.level.localeCompare(b.level),
        );
      return {
        ...scope,
        groups: totals,
        unreported_sources: costSources.filter(
          (source) => !totals.some((group) => group.source_kind === source),
        ),
        reports: entries,
      };
    })
    .sort(
      (a, b) =>
        b.period_start.localeCompare(a.period_start) ||
        a.scope_id.localeCompare(b.scope_id),
    );
  return { schema: 1, project_id: ledger.project_id, scopes };
}

// The six existing MCP tools remain the only tools. Extend measured metrics
// with optional explicit ledger inputs; authoritative validation is above.
const str = { type: "string", minLength: 1, maxLength: 160 };
const nullable = { type: ["string", "null"], minLength: 1, maxLength: 160 };
const timestamp = { type: "string", format: "date-time" };
const schema = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const costScopeSchema = schema({
  scope_id: str,
  project_id: str,
  period_start: timestamp,
  period_end: timestamp,
  membership_complete: { type: "boolean" },
  targets: {
    type: "array",
    minItems: 1,
    maxItems: 100,
    items: schema({
      target_id: str,
      worker_id: str,
      session_id: str,
      run_id: nullable,
      provider: nullable,
      model: nullable,
    }),
  },
});
export const costReportSchema = schema({
  event_id: str,
  scope_id: str,
  target_id: nullable,
  source_kind: { enum: costSources },
  source_ref: { type: "string", minLength: 1, maxLength: 1000 },
  observed_at: timestamp,
  mode: { enum: ["event", "cumulative"] },
  sequence: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  currency: { type: "string", pattern: "^[A-Z]{3}$" },
  amount: {
    type: ["string", "null"],
    pattern: "^(?:0|[1-9]\\d{0,15})(?:\\.\\d{1,9})?$",
  },
  certainty: { enum: ["unknown", "reported", "estimated", "confirmed"] },
  tokens: {
    ...schema(
      Object.fromEntries(
        tokenKeys.map((key) => [
          key,
          {
            type: ["integer", "null"],
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        ]),
      ),
    ),
    type: ["object", "null"],
  },
  basis: { type: "string", minLength: 1, maxLength: 2000 },
});
