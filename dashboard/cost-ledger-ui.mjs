import { text, formatDateTime } from "./locale.mjs";
const sources = {
  provider_usage: text("cost.usage"),
  cli_report: text("cost.cli"),
  api_estimate: text("cost.estimate"),
  invoice_actual: text("cost.invoice"),
};
const certainty = {
  unknown: text("cost.unavailable"),
  reported: text("cost.reported"),
  estimated: text("cost.estimated"),
  confirmed: text("cost.confirmed"),
};
const amount = (group) =>
  group.amount === null ? text("cost.unavailable") : `${group.currency} ${group.amount}`;
function targetLabel(scope, id) {
  const target = scope.targets.find((target) => target.target_id === id);
  return target
    ? `${target.worker_id} · ${target.session_id}`
    : text("cost.unallocated");
}
export function createCostPanel(container, node) {
  let latest,
    selected = "",
    reportLimit = 100;
  const select = node("select"),
    label = node("label", text("cost.period"));
  select.id = "cost-scope";
  label.htmlFor = select.id;
  const content = node("div");
  container.append(label, select, content);
  select.onchange = () => {
    selected = select.value;
    reportLimit = 100;
    render(latest);
  };
  function render(state) {
    latest = state;
    const scopes = state.cost_ledger?.scopes || [];
    if (!scopes.length) {
      label.hidden = select.hidden = true;
      content.replaceChildren(
        node(
          "p",
          text("cost.empty"),
          "sub",
        ),
      );
      return;
    }
    label.hidden = select.hidden = false;
    if (!scopes.some((scope) => scope.scope_id === selected))
      selected = scopes[0].scope_id;
    const options = JSON.stringify(
      scopes.map((scope) => [
        scope.scope_id,
        scope.period_start,
        scope.period_end,
      ]),
    );
    if (select.dataset.options !== options) {
      select.replaceChildren(
        ...scopes.map((scope) => {
          const option = node(
            "option",
            `${scope.scope_id} · ${scope.period_start.slice(0, 10)}〜${scope.period_end.slice(0, 10)}`,
          );
          option.value = scope.scope_id;
          return option;
        }),
      );
      select.dataset.options = options;
    }
    select.value = selected;
    const scope = scopes.find((scope) => scope.scope_id === selected);
    const opened = new Set(
      [...content.querySelectorAll("details[open]")].map(
        (detail) => detail.dataset.costDetail,
      ),
    );
    content.replaceChildren(
      node(
        "p",
        text("cost.range", {start:formatDateTime(scope.period_start), end:formatDateTime(scope.period_end), count:scope.targets.length}),
        "sub",
      ),
      node(
        "p",
        scope.membership_complete
          ? text("cost.complete")
          : text("cost.incomplete"),
        "sub",
      ),
      node(
        "p",
        text("cost.basis"),
        "sub",
      ),
    );
    const grid = node("div", undefined, "cards cost-grid");
    for (const source of Object.keys(sources)) {
      const groups = scope.groups.filter(
        (group) => group.source_kind === source,
      );
      if (!groups.length) {
        const card = node("section", undefined, "card");
        card.append(
          node("div", sources[source], "label"),
          node("div", text("cost.unavailable"), "value"),
          node(
            "p",
            text("cost.missingTargets", {count:scope.targets.length}),
            "detail",
          ),
        );
        grid.append(card);
      }
      for (const group of groups) {
        const card = node("section", undefined, "card");
        card.append(
          node(
            "div",
            sources[source] +
              (group.level === "project_invoice" ? text("cost.projectSuffix") : text("cost.workerSuffix")),
            "label",
          ),
          node("div", amount(group), "value"),
          node(
            "p",
            `${group.partial ? text("cost.partial") : group.level === "project_invoice" ? text("cost.periodInvoice") : text("cost.covered")} · ${certainty[group.certainty]}`,
            "detail",
          ),
          node(
            "p",
            group.level === "project_invoice"
              ? text("cost.projectDetail")
              : text("cost.coverage", {covered:group.covered_targets.length,count:scope.targets.length}),
            "detail",
          ),
          node("p", text("cost.lastObserved") + formatDateTime(group.observed_at), "detail"),
        );
        if (group.missing_targets.length)
          card.append(
            node(
              "p",
              text("cost.missing") +
                group.missing_targets
                  .map((id) => targetLabel(scope, id))
                  .join("、"),
              "detail",
            ),
          );
        grid.append(card);
      }
    }
    content.append(grid);
    const targets = node("details", undefined, "fold");
    targets.dataset.costDetail = "targets";
    targets.open = opened.has("targets");
    targets.append(node("summary", text("cost.targets")));
    for (const target of scope.targets)
      targets.append(
        node(
          "p",
          `${target.target_id} · ${target.worker_id} · session ${target.session_id} · run ${target.run_id || text("cost.unavailable")} · provider ${target.provider || text("cost.unavailable")} · model ${target.model || text("cost.unavailable")}`,
        ),
      );
    const history = node("details", undefined, "fold");
    history.dataset.costDetail = "history";
    history.open = opened.has("history");
    history.append(
      node("summary", text("cost.history", {count:scope.reports.length})),
    );
    if (!scope.reports.length) history.append(node("p", text("cost.noDetails")));
    if (scope.reports.length > reportLimit)
      history.append(
        node(
          "p",
          text("cost.showing", {limit:reportLimit,count:scope.reports.length}),
          "sub",
        ),
      );
    for (const report of scope.reports.slice(0, reportLimit)) {
      const row = node("article", undefined, "cost-entry");
      row.append(
        node(
          "h3",
          `${sources[report.source_kind]} · ${amount(report)}${report.amount === null ? "" : " · " + certainty[report.certainty]}`,
        ),
        node("p", targetLabel(scope, report.target_id)),
        node(
          "p",
          report.included
            ? text("cost.included")
            : text("cost.excluded"),
          "sub",
        ),
        node(
          "p",
          text("cost.times", {observed:formatDateTime(report.observed_at),received:formatDateTime(report.received_at)}),
          "sub",
        ),
        node(
          "p",
          text("cost.report", {id:report.event_id,mode:report.mode === "cumulative" ? text("cost.cumulative") : text("cost.independent"),sequence:report.sequence}),
          "sub",
        ),
        node("p", text("cost.source", {source:report.source_ref})),
        node("p", text("cost.reason", {basis:report.basis})),
        node(
          "p",
          text("cost.tokens", {input:report.tokens?.input ?? text("cost.unavailable"),cached:report.tokens?.cached_input ?? text("cost.unavailable"),output:report.tokens?.output ?? text("cost.unavailable")}),
          "sub",
        ),
      );
      history.append(row);
    }
    if (scope.reports.length > reportLimit) {
      const more = node("button", text("cost.more"));
      more.type = "button";
      more.onclick = () => {
        reportLimit += 100;
        render(latest);
      };
      history.append(more);
    }
    content.append(targets, history);
  }
  return render;
}
