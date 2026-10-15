import { text, formatDateTime } from "./locale.mjs";
import { observationView } from "./observations.mjs";

const statusNames = {
  pass: text("outcome.pass"),
  fail: text("outcome.fail"),
  blocked: text("outcome.blocked"),
  "not-run": text("outcome.notRun"),
  "not-defined": text("outcome.undefined"),
  definition_changed: text("outcome.changed"),
  unknown: text("outcome.unknown"),
};
const freshnessLabels = {
  fresh: "",
  stale: text("outcome.stale"),
  unknown: text("outcome.freshness"),
  unavailable: text("outcome.unavailable"),
};
const date = (value) =>
  value ? formatDateTime(value) : text("outcome.undeclared");

function renderTaskObservation(node, status, details, task, now) {
  const view = observationView(task.status, task.observation, now);
  const statusQualifier = view.current
    ? view.kind === "estimated"
      ? text("outcome.estimated")
      : ""
    : text("outcome.qualifier", { freshness: freshnessLabels[view.freshness] || text("outcome.freshness") });
  status.textContent = text("outcome.reported", { status: text("task.status." + task.status), qualifier: statusQualifier });
  const tone =
    view.current && view.kind !== "estimated"
      ? task.status
      : view.freshness === "stale"
        ? "stale"
        : "";
  status.className = tone ? `status ${tone}` : "status";
  status.dataset.freshness = view.freshness;

  const observation = view.observation;
  const panel = node("div", undefined, "observation task-observation-details");
  panel.dataset.freshness = view.freshness;
  panel.dataset.kind = view.kind || "unknown";
  const heading = node("div", undefined, "observation-heading");
  heading.append(
    node("span", text("observation.kind." + (view.kind || "unknown")), "provenance-badge " + (view.kind || "unknown")),
  );
  if (view.freshness !== "fresh")
    heading.append(
      node(
        "span",
        freshnessLabels[view.freshness] || text("outcome.freshness"),
        "provenance-badge " + view.freshness,
      ),
    );
  panel.append(heading);
  if (view.value != null && !view.current)
    panel.append(node("div", text("outcome.previous") + view.value, "sub"));
  panel.append(
    node("div", text("outcome.observed") + date(observation?.observed_at), "sub"),
    node("div", text("outcome.source") + (observation?.source || text("outcome.undeclared")), "sub"),
    node("div", text("outcome.reference") + (observation?.reference || text("outcome.undeclared")), "sub"),
  );
  if (observation?.observed_at && observation.max_age_seconds) {
    const expiresAt = new Date(
      Date.parse(observation.observed_at) + observation.max_age_seconds * 1000,
    );
    panel.append(node("div", text("outcome.expires") + date(expiresAt.toISOString()), "sub"));
  }
  details.replaceChildren(panel);
}

function checkLabel(condition) {
  if (condition.verified) return text("outcome.verified");
  if (condition.freshness === "stale") return text("outcome.recheck");
  if (condition.source === "operator_report")
    return text("outcome.reportedOnly");
  if (condition.status === "pass") return text("outcome.reportedPass");
  return statusNames[condition.status] || text("outcome.unknown");
}
export function createTaskOutcomesPanel(tasks, milestones, { node, api }) {
  let generation = 0;
  let renderedRevision = -1;
  let observationTimer = null;
  const observationRows = new Map();
  const cached = new Map();

  function refreshTaskObservations(now = Date.now()) {
    for (const { status, details, task } of observationRows.values())
      renderTaskObservation(node, status, details, task, now);
  }

  function scheduleObservationRefresh() {
    if (observationTimer !== null) clearTimeout(observationTimer);
    observationTimer = null;
    const now = Date.now();
    let nextExpiry = Infinity;
    for (const { task } of observationRows.values()) {
      const view = observationView(task.status, task.observation, now);
      const observed = Date.parse(task.observation?.observed_at);
      const maxAge = task.observation?.max_age_seconds;
      if (view.current && Number.isFinite(observed) && Number.isInteger(maxAge))
        nextExpiry = Math.min(nextExpiry, observed + maxAge * 1000);
    }
    if (Number.isFinite(nextExpiry)) {
      observationTimer = setTimeout(() => {
        observationTimer = null;
        refreshTaskObservations();
        scheduleObservationRefresh();
      }, Math.max(0, nextExpiry - now));
      observationTimer.unref?.();
    }
  }

  function evidencePanel(kind, id, revision, epoch, initial) {
    const panel = node("div", undefined, "outcome-checks");
    const status = node("p", text("outcome.noCurrent"), "sub");
    status.setAttribute("aria-live", "polite");
    const list = node("ul");
    const button = node("button", text("outcome.check"));
    button.type = "button";
    const key = kind + ":" + id;
    function show(view) {
      const conditions = view?.conditions || initial || [];
      list.replaceChildren(
        ...conditions.map((condition) => {
          const row = node("li");
          row.append(
            node("strong", condition.description),
            node(
              "p",
              view ? checkLabel(condition) : text("outcome.noResults"),
              condition.verified ? "doing" : "sub",
            ),
          );
          if (condition.partial_status)
            row.append(
              node(
                "p",
                text("outcome.partial", { status: statusNames[condition.partial_status] || text("outcome.unknown") }),
                "sub",
              ),
            );
          if (condition.evidence_id)
            row.append(node("code", condition.evidence_id));
          return row;
        }),
      );
      if (view) {
        const summary =
          kind === "milestone_id"
            ? text("outcome.count", { verified: view.verified_count, total: view.condition_count })
            : view.status === "verified_checks"
              ? text("outcome.allVerified")
              : view.status === "unknown"
                ? text("outcome.getFailed")
                : view.conditions.length
                  ? text("outcome.unmet")
                  : text("outcome.notDefined");
        status.textContent = text("outcome.lastCheck", { summary: (view.acceptance_task_id ? text("outcome.target", { id: view.acceptance_task_id }) : "") + summary, time: formatDateTime(view.observed_at) });
        button.textContent = text("outcome.refresh");
      }
    }
    const previous = cached.get(key);
    if (previous?.state_revision === revision) show(previous);
    else show(null);
    button.onclick = async () => {
      button.disabled = true;
      status.textContent = text("outcome.checking");
      try {
        const view = await api(
          `task-outcomes?${kind}=${encodeURIComponent(id)}`,
        );
        if (generation !== epoch || view.state_revision !== revision) return;
        cached.set(key, view);
        show(view);
      } catch {
        if (generation !== epoch) return;
        cached.delete(key);
        show(null);
        status.textContent =
          text("outcome.retryAfterUpdate");
      } finally {
        button.disabled = false;
      }
    };
    panel.append(
      status,
      list,
      button,
      node(
        "p",
        text("outcome.reviewSeparate"),
        "sub",
      ),
    );
    return panel;
  }
  return (state) => {
    if (state.revision === renderedRevision) {
      refreshTaskObservations();
      scheduleObservationRefresh();
      return;
    }
    if (observationTimer !== null) clearTimeout(observationTimer);
    observationTimer = null;
    renderedRevision = state.revision;
    const epoch = ++generation;
    observationRows.clear();
    const reports = state.task_outcomes?.tasks || [];
    tasks.replaceChildren(
      ...state.tasks.map((task) => {
        const report = reports.find((item) => item.task_id === task.id) || {};
        const card = node("article", undefined, "decision-card outcome-card");
        card.id = "task-" + task.id;
        const link = node("a", task.id, "id");
        link.href = "#task-" + encodeURIComponent(task.id);
        link.dataset.taskId = task.id;
        const status = node("span");
        const header = node("div", undefined, "decision-heading");
        header.append(link, status);
        const observationDetails = node("div");
        renderTaskObservation(node, status, observationDetails, task, Date.now());
        observationRows.set(task.id, {
          status,
          details: observationDetails,
          task,
        });
        card.append(header, node("h3", task.title), observationDetails);
        const facts = node("dl", undefined, "decision-details");
        for (const [label, value] of [
          [text("outcome.purpose"), report.purpose],
          [text("outcome.owner"), report.owner],
          [text("outcome.latest"), report.latest_outcome],
          [text("outcome.next"), report.next_step],
          [text("outcome.blocker"), task.blocker || text("outcome.none")],
          [text("outcome.milestone"), task.milestone],
          [
            text("outcome.updated"),
            task.updated_at &&
              formatDateTime(task.updated_at),
          ],
        ])
          facts.append(node("dt", label), node("dd", value || text("outcome.undeclared")));
        card.append(
          facts,
          evidencePanel("task_id", task.id, state.revision, epoch),
        );
        return card;
      }),
    );
    if (!state.tasks.length)
      tasks.append(node("p", text("outcome.noTasks"), "empty"));
    const contracts = state.task_outcomes?.milestones || [];
    milestones.replaceChildren(
      ...contracts.map((contract) => {
        const card = node("article", undefined, "decision-card");
        card.append(
          node("h3", `${contract.id} · ${contract.title}`),
          node(
            "p",
            text("outcome.fixedCriteria"),
            "sub",
          ),
          evidencePanel(
            "milestone_id",
            contract.id,
            state.revision,
            epoch,
            contract.criteria,
          ),
        );
        return card;
      }),
    );
    const legacy = [
      ...new Set(
        state.tasks
          .map((task) => task.milestone)
          .filter((id) => id && !contracts.some((item) => item.id === id)),
      ),
    ];
    if (legacy.length)
      milestones.append(
        node("p", text("outcome.legacy", { ids: legacy.join(" / ") }), "sub"),
      );
    if (!contracts.length && !legacy.length)
      milestones.append(
        node("p", text("outcome.noMilestones"), "empty"),
      );
    scheduleObservationRefresh();
  };
}
