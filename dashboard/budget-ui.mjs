import { text, formatDateTime } from "./locale.mjs";
const statuses = {
  within_budget: text("budget.within"),
  warning: text("budget.warning"),
  blocked: text("budget.blocked"),
  paused: text("budget.paused"),
  unknown: text("budget.unknown"),
  period_closed: text("budget.closed"),
  inactive: text("budget.inactive"),
};
const sources = {
  provider_usage: text("budget.usage"),
  cli_report: text("budget.cli"),
  api_estimate: text("budget.estimate"),
  invoice_actual: text("budget.invoice"),
};
export function renderBudget(root, state, node) {
  const callsOpen = root.querySelector("#budget-call-history")?.open || false;
  const historyOpen =
    root.querySelector("#budget-decision-history")?.open || false;
  root.replaceChildren(node("h2", text("budget.heading")));
  root.append(
    node(
      "p",
      text("budget.scope"),
      "detail",
    ),
  );
  const book = state.budget_admission;
  if (!book?.policies.length) {
    root.append(
      node(
        "p",
        text("budget.unset"),
        "detail",
      ),
    );
    return;
  }
  const grid = node("div", undefined, "cards budget-grid");
  for (const p of book.policies) {
    const card = node("section", undefined, "card");
    card.append(
      node("h3", p.run_id ? `run ${p.run_id}` : text("budget.project")),
      node(
        "strong",
        statuses[p.status],
        ["blocked", "warning", "unknown"].includes(p.status) ? "warn" : "",
      ),
      node(
        "div",
        `${p.currency} ${p.effective ?? text("budget.unconfirmed")} / ${p.hard_limit}`,
        "value",
      ),
      node(
        "p",
        text("budget.limits", {soft:p.soft_limit, hard:p.hard_limit, reservation:p.call_reservation}),
        "detail",
      ),
      node(
        "p",
        text("budget.totals", {spent:p.spent ?? text("budget.unconfirmed"), reserved:p.reserved, executing:p.executing, awaiting:p.awaiting_usage}),
        "detail",
      ),
      node(
        "p",
        p.next_call_fits
          ? text("budget.fits")
          : text("budget.noFit"),
        "detail",
      ),
      node(
        "p",
        text("budget.source", {source:sources[p.source_kind], baseline:p.baseline ?? text("budget.unconfirmed"), basis:p.baseline_basis}),
        "detail",
      ),
      node("p", `${p.period_start} ～ ${p.period_end}`, "detail"),
    );
    if (p.overspend !== "0")
      card.append(
        node("p", text("budget.overspend", {currency:p.currency, amount:p.overspend}), "warn"),
      );
    grid.append(card);
  }
  root.append(grid);
  root.append(
    node(
      "p",
      text("budget.support"),
      "detail",
    ),
  );
  for (const job of book.jobs.slice(-20).reverse())
    root.append(
      node(
        "p",
        `${job.worker_id} · ${job.run_id} · ${job.enforcement === "guard_registered" ? text("budget.registered") : job.enforcement === "stopped" ? text("budget.ended") : text("budget.hookUnknown")}`,
        "detail",
      ),
    );
  const history = node("details");
  const calls = node("details");
  calls.id = "budget-call-history";
  calls.open = callsOpen;
  history.id = "budget-decision-history";
  history.open = historyOpen;
  calls.append(
    node("summary", text("budget.calls", {count:book.calls.length})),
  );
  for (const call of book.calls.slice(-50).reverse()) {
    calls.append(
      node(
        "p",
        `${call.worker_id} · ${call.session_id || text("budget.aux")} · ${call.provider} / ${call.model} · ${call.currency} ${call.amount === null ? text("budget.reservation", {amount:call.reservation}) : text("budget.reported", {amount:call.amount})} · ${call.finished_at === null ? text("budget.executing") : text("budget.nativeEnd")} · ${call.call_id}`,
        "detail",
      ),
    );
  }
  root.append(calls);
  history.append(
    node("summary", text("budget.history", {count:book.decisions.length})),
  );
  for (const d of book.decisions.slice(-50).reverse()) {
    history.append(
      node(
        "p",
        `${formatDateTime(d.recorded_at)} · ${d.kind} · ${d.allowed === true ? text("budget.admit") : d.allowed === false ? text("budget.reject") : text("budget.record")} ${d.reason || ""} ${d.call_id || d.job_id || d.policy?.policy_id || ""}${d.kind === "usage" ? ` · ${d.currency} ${d.amount ?? text("budget.unconfirmed")} · ${d.source_ref} · ${d.basis}` : ""}`,
        "detail",
      ),
    );
  }
  root.append(history);
}
