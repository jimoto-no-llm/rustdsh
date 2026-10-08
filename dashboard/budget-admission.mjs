import { costSources } from "./cost-ledger.mjs";

const scale = 1000000000n;
export class BudgetError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.status = code.endsWith("conflict") ? 409 : 400;
  }
}
function fail(code) {
  throw new BudgetError(code);
}
function object(input, keys) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    fail("budget_invalid_input");
}
function id(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ||
    Object.hasOwn(Object.prototype, value)
  )
    fail("budget_invalid_id");
  return value;
}
function text(value, max = 1000) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f]/.test(value)
  )
    fail("budget_invalid_text");
  return value;
}
function time(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail("budget_invalid_time");
  const canonical = new Date(value).toISOString();
  const expected = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_, part = "") => `.${part.padEnd(3, "0")}Z`,
  );
  if (canonical !== expected) fail("budget_invalid_time");
  return canonical;
}
function units(value) {
  if (typeof value !== "string" || !/^\d{1,16}(?:\.\d{1,9})?$/.test(value))
    fail("budget_invalid_amount");
  const [whole, part = ""] = value.split(".");
  return BigInt(whole) * scale + BigInt(part.padEnd(9, "0"));
}
function money(value) {
  const whole = value / scale;
  const fraction = String(value % scale)
    .padStart(9, "0")
    .replace(/0+$/, "");
  return String(whole) + (fraction ? "." + fraction : "");
}
function amount(value) {
  return value === null ? null : money(units(value));
}
function ledger(state) {
  return (state.budget_admission ||= {
    schema: 1,
    project_id: state.project.id,
    policies: {},
    jobs: {},
    calls: {},
    receipts: {},
    decisions: [],
    operations: [],
  });
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function decision(book, kind, data, now) {
  if (book.decisions.length >= 10000) fail("budget_audit_full");
  const entry = {
    sequence: book.decisions.length + 1,
    kind,
    ...data,
    recorded_at: now,
  };
  book.decisions.push(entry);
  return entry;
}
function totals(book, policy) {
  let spent = policy.baseline === null ? null : units(policy.baseline);
  let reserved = 0n,
    executing = 0,
    awaiting = 0;
  for (const call of Object.values(book.calls)) {
    if (!call.policy_ids.includes(policy.policy_id)) continue;
    if (call.amount !== null) {
      if (spent !== null) spent += units(call.amount);
    } else {
      reserved += units(call.reservation);
      if (call.finished_at === null) executing++;
      else awaiting++;
    }
  }
  const effective = spent === null ? null : spent + reserved;
  return { spent, reserved, effective, executing, awaiting };
}
function matched(book, runId) {
  return Object.values(book.policies).filter(
    (p) => p.active && (p.run_id === null || p.run_id === runId),
  );
}
function assess(book, runId, now, reserve = false) {
  const policies = matched(book, runId);
  let reason = policies.length ? null : "budget_policy_missing";
  let warning = false;
  const pending = reserve
    ? policies.reduce(
        (max, p) =>
          units(p.call_reservation) > max ? units(p.call_reservation) : max,
        0n,
      )
    : 0n;
  for (const p of policies) {
    const t = totals(book, p);
    warning ||=
      t.effective !== null && t.effective + pending >= units(p.soft_limit);
    if (p.paused) reason ||= "budget_paused";
    else if (now < p.period_start || now >= p.period_end)
      reason ||= "budget_period_closed";
    else if (t.effective === null) reason ||= "budget_spend_unknown";
    else if (
      t.effective >= units(p.hard_limit) ||
      t.effective + pending > units(p.hard_limit)
    )
      reason ||= "budget_hard_limit";
  }
  const contexts = new Set(
    policies.map((p) =>
      JSON.stringify([p.source_kind, p.currency, p.period_start, p.period_end]),
    ),
  );
  if (contexts.size > 1) reason ||= "budget_accounting_mismatch";
  return {
    allowed: reason === null,
    warning,
    reason,
    policy_ids: policies.map((p) => p.policy_id).sort(),
  };
}

export function applyBudgetOperation(
  state,
  operation,
  input,
  now = new Date().toISOString(),
) {
  now = time(now);
  const book = ledger(state);
  if (book.operations.length >= 10000) fail("budget_audit_full");
  const result = operate(state, operation, input, now);
  book.operations.push({
    operation,
    input: structuredClone(input),
    recorded_at: now,
  });
  return result;
}
function operate(state, operation, input, now) {
  const book = ledger(state);
  if (operation === "policy") {
    object(input, [
      "policy_id",
      "expected_revision",
      "run_id",
      "period_start",
      "period_end",
      "currency",
      "source_kind",
      "baseline",
      "baseline_basis",
      "soft_limit",
      "hard_limit",
      "call_reservation",
      "paused",
      "active",
      "reason",
    ]);
    const policyId = id(input.policy_id),
      previous = book.policies[policyId];
    if (
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision !== (previous?.revision || 0)
    )
      fail("budget_policy_revision_conflict");
    const p = {
      policy_id: policyId,
      revision: input.expected_revision + 1,
      run_id: input.run_id === null ? null : id(input.run_id),
      period_start: time(input.period_start),
      period_end: time(input.period_end),
      currency: input.currency,
      source_kind: input.source_kind,
      baseline: amount(input.baseline),
      baseline_basis: text(input.baseline_basis),
      soft_limit: amount(input.soft_limit),
      hard_limit: amount(input.hard_limit),
      call_reservation: amount(input.call_reservation),
      paused: input.paused,
      active: input.active,
    };
    const reason = text(input.reason);
    if (
      !/^[A-Z]{3}$/.test(p.currency) ||
      !costSources.includes(p.source_kind) ||
      typeof p.paused !== "boolean" ||
      typeof p.active !== "boolean" ||
      p.period_start >= p.period_end ||
      p.soft_limit === null ||
      p.hard_limit === null ||
      p.call_reservation === null ||
      units(p.soft_limit) > units(p.hard_limit) ||
      units(p.call_reservation) === 0n
    )
      fail("budget_invalid_policy");
    if (previous) {
      for (const key of [
        "run_id",
        "period_start",
        "period_end",
        "currency",
        "source_kind",
        "baseline",
        "baseline_basis",
      ])
        if (p[key] !== previous[key])
          fail("budget_accounting_immutable_conflict");
      if (
        !p.active &&
        Object.values(book.calls).some(
          (call) => call.policy_ids.includes(policyId) && call.amount === null,
        )
      )
        fail("budget_unconfirmed_calls_conflict");
    } else if (Object.keys(book.policies).length >= 100)
      fail("budget_policies_full");
    book.policies[policyId] = p;
    decision(
      book,
      "policy",
      { policy: structuredClone(p), reason, actor: "local_administrator" },
      now,
    );
    return p;
  }
  if (operation === "job") {
    object(input, ["job_id", "run_id", "worker_id"]);
    const jobId = id(input.job_id),
      runId = id(input.run_id),
      workerId = id(input.worker_id);
    if (book.jobs[jobId]) fail("budget_job_replay_conflict");
    if (Object.keys(book.jobs).length >= 10000) fail("budget_jobs_full");
    const result = assess(book, runId, now);
    decision(
      book,
      "job",
      { job_id: jobId, run_id: runId, worker_id: workerId, ...result },
      now,
    );
    if (result.allowed)
      book.jobs[jobId] = {
        job_id: jobId,
        run_id: runId,
        worker_id: workerId,
        admitted_at: now,
        registered_at: null,
        closed_at: null,
      };
    return { job_id: jobId, ...result };
  }
  if (operation === "ready" || operation === "close") {
    object(input, ["job_id"]);
    const job = book.jobs[id(input.job_id)];
    if (!job || job.closed_at !== null) fail("budget_job_unavailable");
    if (operation === "ready") {
      if (job.registered_at !== null) fail("budget_hook_replay_conflict");
      job.registered_at = now;
    } else job.closed_at = now;
    decision(book, operation, { job_id: job.job_id }, now);
    return job;
  }
  if (operation === "call") {
    object(input, [
      "job_id",
      "call_id",
      "session_id",
      "provider",
      "model",
      "purpose",
    ]);
    const job = book.jobs[id(input.job_id)],
      callId = id(input.call_id);
    if (!job || job.closed_at !== null || job.registered_at === null)
      fail("budget_hook_unavailable");
    if (book.calls[callId])
      return { allowed: false, reason: "budget_call_replay", call_id: callId };
    if (Object.keys(book.calls).length >= 10000) fail("budget_calls_full");
    const sessionId =
      input.session_id === null ? null : text(input.session_id, 160);
    const provider = text(input.provider, 160),
      model = text(input.model, 160);
    const purpose = input.purpose === null ? null : text(input.purpose, 80);
    const result = assess(book, job.run_id, now, true);
    decision(
      book,
      "call",
      {
        call_id: callId,
        job_id: job.job_id,
        provider,
        model,
        session_id: sessionId,
        ...result,
      },
      now,
    );
    if (!result.allowed) return { call_id: callId, ...result };
    const policies = result.policy_ids.map((pid) => book.policies[pid]);
    const reservation = policies.reduce(
      (max, p) =>
        units(p.call_reservation) > max ? units(p.call_reservation) : max,
      0n,
    );
    const p = policies[0];
    book.calls[callId] = {
      call_id: callId,
      job_id: job.job_id,
      run_id: job.run_id,
      worker_id: job.worker_id,
      session_id: sessionId,
      provider,
      model,
      purpose,
      policy_ids: result.policy_ids,
      currency: p.currency,
      source_kind: p.source_kind,
      reservation: money(reservation),
      admitted_at: now,
      finished_at: null,
      outcome: null,
      tokens: null,
      amount: null,
      receipt_id: null,
    };
    return {
      call_id: callId,
      reservation: money(reservation),
      currency: p.currency,
      ...result,
    };
  }
  if (operation === "finish") {
    object(input, ["job_id", "call_id", "outcome", "tokens"]);
    const call = book.calls[id(input.call_id)];
    if (!call || call.job_id !== id(input.job_id)) fail("budget_call_missing");
    if (!["finished", "interrupted", "failed"].includes(input.outcome))
      fail("budget_invalid_outcome");
    let tokens = null;
    if (input.tokens !== null) {
      object(input.tokens, ["input", "cached_input", "cache_write", "output"]);
      tokens = {};
      for (const key of ["input", "cached_input", "cache_write", "output"]) {
        const value = input.tokens[key];
        if (value !== null && (!Number.isSafeInteger(value) || value < 0))
          fail("budget_invalid_tokens");
        tokens[key] = value;
      }
    }
    if (call.finished_at !== null) {
      if (call.outcome !== input.outcome || !same(call.tokens, tokens))
        fail("budget_finish_conflict");
      return call;
    }
    call.finished_at = now;
    call.outcome = input.outcome;
    call.tokens = tokens;
    decision(
      book,
      "finish",
      { call_id: call.call_id, outcome: input.outcome },
      now,
    );
    return call;
  }
  if (operation === "usage") {
    object(input, [
      "event_id",
      "call_id",
      "amount",
      "currency",
      "source_kind",
      "source_ref",
      "observed_at",
      "basis",
    ]);
    const receipt = {
      event_id: id(input.event_id),
      call_id: id(input.call_id),
      amount: amount(input.amount),
      currency: input.currency,
      source_kind: input.source_kind,
      source_ref: text(input.source_ref),
      observed_at: time(input.observed_at),
      basis: text(input.basis),
    };
    const old = book.receipts[receipt.event_id];
    if (old) {
      if (!same(old, receipt)) fail("budget_receipt_conflict");
      return old;
    }
    const call = book.calls[receipt.call_id];
    if (!call || call.finished_at === null) fail("budget_call_not_finished");
    if (
      receipt.currency !== call.currency ||
      receipt.source_kind !== call.source_kind ||
      receipt.observed_at < call.finished_at ||
      receipt.observed_at > now
    )
      fail("budget_receipt_context_conflict");
    if (call.receipt_id !== null && receipt.amount !== call.amount)
      fail("budget_settlement_conflict");
    if (Object.keys(book.receipts).length >= 10000)
      fail("budget_receipts_full");
    book.receipts[receipt.event_id] = receipt;
    if (receipt.amount !== null) {
      call.amount = receipt.amount;
      call.receipt_id ||= receipt.event_id;
    }
    decision(book, "usage", { ...receipt, actor: "local_administrator" }, now);
    return receipt;
  }
  fail("budget_unknown_operation");
}

export function validateBudgetAdmission(state) {
  const book = state.budget_admission;
  if (book === undefined) return;
  if (
    !book ||
    book.schema !== 1 ||
    book.project_id !== state.project.id ||
    !Array.isArray(book.operations) ||
    book.operations.length > 10000
  )
    fail("budget_invalid_store");
  // Replay canonical records, so damaged amounts, policy revisions and scope IDs
  // cannot quietly turn into a zero-spend admission after a restart.
  const replay = { project: state.project };
  for (const op of book.operations)
    applyBudgetOperation(replay, op.operation, op.input, op.recorded_at);
  if (!same(replay.budget_admission, book)) fail("budget_invalid_audit");
}

export function publicBudgetAdmission(state, liveJobs = {}) {
  const book = state.budget_admission;
  if (!book) return null;
  const now = new Date().toISOString();
  return {
    schema: 1,
    project_id: book.project_id,
    policies: Object.values(book.policies).map((p) => {
      const t = totals(book, p);
      return {
        ...p,
        spent: t.spent === null ? null : money(t.spent),
        reserved: money(t.reserved),
        effective: t.effective === null ? null : money(t.effective),
        executing: t.executing,
        awaiting_usage: t.awaiting,
        next_call_fits:
          p.active &&
          !p.paused &&
          now >= p.period_start &&
          now < p.period_end &&
          t.effective !== null &&
          t.effective < units(p.hard_limit) &&
          t.effective + units(p.call_reservation) <= units(p.hard_limit),
        status: !p.active
          ? "inactive"
          : p.paused
            ? "paused"
            : now < p.period_start || now >= p.period_end
              ? "period_closed"
              : t.effective === null
                ? "unknown"
                : t.effective >= units(p.hard_limit)
                  ? "blocked"
                  : t.effective >= units(p.soft_limit)
                    ? "warning"
                    : "within_budget",
        overspend:
          t.spent !== null && t.spent > units(p.hard_limit)
            ? money(t.spent - units(p.hard_limit))
            : "0",
      };
    }),
    jobs: Object.values(book.jobs).map((job) => ({
      ...job,
      enforcement:
        job.closed_at !== null
          ? "stopped"
          : liveJobs[job.job_id] === true
            ? "guard_registered"
            : "unknown",
    })),
    calls: Object.values(book.calls).map((call) => ({
      ...call,
      accounting: call.amount === null ? "unconfirmed" : "source_reported",
    })),
    decisions: structuredClone(book.decisions),
  };
}
