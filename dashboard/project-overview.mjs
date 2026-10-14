import { text, formatDateTime } from "./locale.mjs";
// A display projection of existing public evidence, never an execution control.
import { observationView } from "./observations.mjs";
const taskLabels = {
  todo: text("overview.todo"),
  doing: text("overview.doing"),
  blocked: text("overview.blocked"),
  done: text("overview.done"),
};
const times = (value) =>
  Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const at = (value) =>
  value ? formatDateTime(value) : text("overview.unavailable");
const questionTask = (state, id) =>
  state.question_contracts?.cards[id]?.snapshot.decision.target?.task_id;

export function overviewModel(state, taskId = "", now = Date.now()) {
  const task = state.tasks.find((item) => item.id === taskId);
  const pendingAll = state.questions.filter((question) => {
    if (question.answer !== null) return false;
    const card = state.question_contracts?.cards[question.id];
    return (
      !card ||
      (card.status === "open" &&
        (!card.snapshot.decision.expires_at ||
          times(card.snapshot.decision.expires_at) > now))
    );
  });
  const pending = pendingAll.filter(
    (question) => !taskId || questionTask(state, question.id) === taskId,
  );
  const unassigned = taskId
    ? pendingAll.filter((question) => !questionTask(state, question.id)).length
    : 0;
  const reviews = Object.values(state.instructions?.requests || {}).filter(
    (request) =>
      request.status === "review_required" &&
      (!taskId ||
        state.answer_applications?.consumers[request.consumer_id]?.task_id ===
          taskId),
  );
  const commands = [
    ...Object.values(state.answer_applications?.commands || {}),
    ...Object.values(state.instructions?.commands || {}),
  ].filter(
    (command) =>
      !taskId ||
      state.answer_applications.consumers[command.consumer_id]?.task_id ===
        taskId,
  );
  // Only the latest input for each target supplies its current observation.
  const latestTargets = new Map();
  for (const command of commands.sort(
    (a, b) => times(a.saved_at) - times(b.saved_at),
  ))
    latestTargets.set(command.consumer_id, command.target_observation);
  const targets = [...latestTargets.values()].filter(Boolean);
  const live = targets.filter((item) => item.status === "available").length;
  const ended = targets.filter(
    (item) => item.reason === "target_process_ended",
  ).length;
  const unknown = targets.length - live - ended;
  const observation = targets.sort(
    (a, b) => times(b.observed_at) - times(a.observed_at),
  )[0];
  let execution = text("overview.noExecution");
  if (targets.length)
    execution = text("overview.execution", {target:commands.some(c=>c.source_kind === "instruction")?text("overview.inputTarget"):text("overview.answerTarget"),live,ended,unknown});
  const reportLabel = (item) => {
    const view = observationView(item.status, item.observation, now);
    const freshness = view.freshness === "stale" ? text("overview.stale") : text("overview.unknown");
    return `${view.kind === "estimated" ? text("overview.estimate") : ""}${taskLabels[item.status] || text("overview.unavailable")}${view.current ? "" : `（${freshness}）`}`;
  };
  const taskViews = state.tasks.map((item) => ({ item, view: observationView(item.status, item.observation, now) }));
  const currentTasks = taskViews.filter(({ view }) => view.current && view.kind !== "estimated");
  const taskReport = taskId
    ? task
      ? `${task.id}: ${reportLabel(task)}`
      : text("overview.selectedMissingTask")
    : text("overview.taskReports", {doing:currentTasks.filter(({item})=>item.status === "doing").length,blocked:currentTasks.filter(({item})=>item.status === "blocked").length,done:currentTasks.filter(({item})=>item.status === "done").length,stale:taskViews.filter(({view})=>view.freshness === "stale").length,unknown:taskViews.filter(({view})=>["unknown","unavailable"].includes(view.freshness)).length,estimated:taskViews.filter(({view})=>view.current && view.kind === "estimated").length});
  const resultPhases = new Set(["succeeded", "failed", "unknown", "invalidated", "unapplied"]);
  const results = commands
    .filter((command) => resultPhases.has(command.display_phase))
    .map((command) => ({
      title: text(`overview.result.${command.source_kind === "instruction" ? "instruction" : "answer"}.${command.display_phase}`),
      detail: `${command.question_id || command.command_id} · run ${command.run_id}`,
      at: command.completed_at || command.started_at || command.saved_at,
    }));
  // Legacy progress/artifact reports have no task binding or acceptance proof.
  if (!taskId)
    for (const event of state.events) {
      const view = observationView(event.title, event.observation, now);
      results.push({
        title: text("overview.eventTitle", {estimated:view.kind === "estimated" ? text("overview.estimate") : "",title:event.title,freshness:view.current ? "" : view.freshness === "stale" ? text("overview.staleSuffix") : text("overview.unknownSuffix")}),
        detail: text("overview.eventDetail", {kind:text("observation.kind."+(view.kind||"unknown")),time:at(event.observation?.observed_at),source:event.observation?.source || text("overview.unreported")}),
        at: event.created_at,
      });
    }
  const lastResult =
    results.sort((a, b) => times(b.at) - times(a.at))[0] || null;
  return {
    context: `${state.project.name} · ${taskId ? `${taskId} ${task?.title || text("overview.orphanTask")}` : text("overview.project")}`,
    execution,
    taskReport,
    observation: observation
      ? text("overview.observed", {time:at(observation.observed_at)})
      : text("overview.noObservations"),
    reportUpdated: text("overview.updated", {time:at(state.updated_at)}),
    lastResult,
    pending,
    reviews,
    unassigned,
    decision: `${pending.length ? text("overview.pending", {count:pending.length}) : text("overview.noPending")}${reviews.length ? text("overview.review", {count:reviews.length}) : ""}${unassigned ? text("overview.unassigned", {count:unassigned}) : ""}`,
    stop: text("overview.stop"),
  };
}

export function renderOverview(container, state, taskId, node) {
  const value = overviewModel(state, taskId);
  const $ = (id) => container.querySelector("#" + id);
  $("overview-context").textContent = value.context;
  $("overview-state").textContent = value.execution;
  $("overview-task-report").textContent = value.taskReport;
  $("overview-observed").textContent = value.observation;
  $("overview-report-updated").textContent = value.reportUpdated;
  $("overview-result").textContent = value.lastResult
    ? `${value.lastResult.title} · ${at(value.lastResult.at)}`
    : text("overview.noResult");
  $("overview-result-detail").textContent =
    value.lastResult?.detail || text("overview.noCompletion");
  $("overview-decision").textContent = value.decision;
  $("overview-stop").textContent = value.stop;
  $("overview-pending").replaceChildren(
    ...value.pending.slice(0, 3).map((question) => {
      const item = node("li");
      const link = node("a", `${question.id} · ${question.question}`);
      link.href = "#question-" + encodeURIComponent(question.id);
      item.append(link);
      return item;
    }),
  );
  return value;
}
