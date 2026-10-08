// A display projection of existing public evidence, never an execution control.
const taskLabels = {
  todo: "未着手",
  doing: "進行中",
  blocked: "保留",
  done: "完了の申告",
};
const times = (value) =>
  Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const at = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "未取得";
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
  const commands = Object.values(
    state.answer_applications?.commands || {},
  ).filter(
    (command) =>
      !taskId ||
      state.answer_applications.consumers[command.consumer_id]?.task_id ===
        taskId,
  );
  // Only the latest reply for each target supplies its current observation.
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
  let execution = "実行状態は未取得";
  if (targets.length)
    execution = `回答対象: 接続確認 ${live} · 終了観測 ${ended} · 不明 ${unknown}。作業の完了は未確認`;
  const taskReport = taskId
    ? task
      ? `${task.id}: ${taskLabels[task.status] || "未取得"}`
      : "選択タスクは現在の一覧にありません"
    : `タスク申告: 進行中 ${state.tasks.filter((item) => item.status === "doing").length} · 保留 ${state.tasks.filter((item) => item.status === "blocked").length} · 完了 ${state.tasks.filter((item) => item.status === "done").length}`;
  const resultNames = {
    succeeded: "回答入力の処理完了（ACP応答）",
    failed: "回答入力が中断（ACP応答）",
    unknown: "回答入力の結果は不明",
    invalidated: "旧版の回答結果（現行版には使えません）",
    unapplied: "回答は未適用（対象が終了）",
  };
  const results = commands
    .filter((command) => resultNames[command.display_phase])
    .map((command) => ({
      title: resultNames[command.display_phase],
      detail: `${command.question_id} · run ${command.run_id}`,
      at: command.completed_at || command.started_at || command.saved_at,
    }));
  // Legacy progress/artifact reports have no task binding or acceptance proof.
  if (!taskId)
    for (const event of state.events)
      results.push({
        title: `報告: ${event.title}`,
        detail: "プロジェクトへの申告（受入検証は別）",
        at: event.created_at,
      });
  const lastResult =
    results.sort((a, b) => times(b.at) - times(a.at))[0] || null;
  return {
    context: `${state.project.name} · ${taskId ? `${taskId} ${task?.title || "一覧にないタスク"}` : "プロジェクト全体"}`,
    execution,
    taskReport,
    observation: observation
      ? `${at(observation.observed_at)} · 回答対象の観測`
      : "実行の観測記録なし",
    reportUpdated: `申告更新: ${at(state.updated_at)}`,
    lastResult,
    pending,
    unassigned,
    decision: `${pending.length ? `判断待ち ${pending.length} 件` : "この範囲の判断待ちは0件"}${unassigned ? ` · タスク未指定 ${unassigned} 件は全体で確認` : ""}`,
    stop: "この画面からの停止は非対応。元のCLIで対象を確認してください",
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
    : "この範囲の結果は未取得";
  $("overview-result-detail").textContent =
    value.lastResult?.detail || "完了を確認した記録はありません";
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
