const retentionChoices = [7, 30, 90];
const formatTime = (milliseconds) => {
  if (milliseconds == null) return "未計測";
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
};

export function createHumanMetricsPanel(root, { api, node, confirm }) {
  const intro = node(
    "p",
    "明示的に有効にした後、この端末のプロジェクト領域だけに記録します。質問・指示・タスクの本文やIDは保存せず、外部送信もしません。判断タイマーは離席時に一時停止し、復旧はブロック開始からの壁時計時間として測ります。",
    "sub",
  );
  const enabled = node("input");
  enabled.type = "checkbox";
  const enabledLabel = node("label");
  enabledLabel.append(enabled, node("span", " ローカル指標を計測する"));
  const retention = node("select");
  for (const days of retentionChoices) {
    const option = node("option", `${days}日`);
    option.value = String(days);
    retention.append(option);
  }
  const retentionLabel = node("label", "保存期間 ");
  retentionLabel.append(retention);
  const settings = node("div", undefined, "human-metrics-settings");
  settings.append(enabledLabel, retentionLabel);
  const status = node("p", "ローカル指標を読み込み中…", "sub");
  status.setAttribute("role", "status");
  const summary = node("div", undefined, "cards");
  const controls = node("div", undefined, "human-metrics-controls");
  const timerStatus = node("p", "判断・復旧タイマーは稼働していません。", "sub");
  timerStatus.setAttribute("role", "status");
  const questionForTimer = node("select");
  const startDecision = node("button", "判断時間を計測開始");
  startDecision.type = "button";
  const taskForTimer = node("select");
  const startRecovery = node("button", "ブロック復旧の計測開始");
  startRecovery.type = "button";
  const timerActions = node("div");
  const pause = node("button", "一時停止");
  const resume = node("button", "再開");
  const finish = node("button", "計測を終了");
  for (const button of [pause, resume, finish]) button.type = "button";
  timerActions.append(pause, resume, finish);

  const questionForRepeat = node("select");
  const markRepeat = node("button", "質問の再発として記録");
  markRepeat.type = "button";
  const commandForResend = node("select");
  const markResend = node("button", "指示の再送として記録");
  markResend.type = "button";
  for (const [labelText, select, button] of [
    ["未回答の質問", questionForTimer, startDecision],
    ["ブロック中のタスク", taskForTimer, startRecovery],
    ["再発した質問", questionForRepeat, markRepeat],
    ["再送した指示", commandForResend, markResend],
  ]) {
    const group = node("div", undefined, "human-metrics-control");
    const label = node("label", labelText);
    label.append(select);
    group.append(label, button);
    controls.append(group);
  }
  const timerGroup = node("div", undefined, "human-metrics-control");
  timerGroup.append(node("strong", "計測中のタイマー"), timerStatus, timerActions);
  controls.append(timerGroup);
  const actions = node("div", undefined, "human-metrics-actions");
  const exportButton = node("button", "集計JSONを保存");
  exportButton.type = "button";
  const clearButton = node("button", "記録を削除");
  clearButton.type = "button";
  actions.append(exportButton, clearButton);
  root.replaceChildren(
    intro,
    settings,
    status,
    summary,
    controls,
    actions,
  );

  let state = null;
  let metrics = null;
  let timerReadAt = 0;
  let pending = false;
  let optionsSignature = "";
  const setDisabled = () => {
    const active = Boolean(metrics?.enabled);
    enabled.disabled = pending || metrics == null;
    retention.disabled = pending || metrics == null;
    for (const control of [
      questionForTimer,
      startDecision,
      taskForTimer,
      startRecovery,
      questionForRepeat,
      markRepeat,
      commandForResend,
      markResend,
      pause,
      resume,
      finish,
    ])
      control.disabled = pending || !active;
    exportButton.disabled = pending || metrics == null;
    clearButton.disabled = pending || metrics == null;
    startDecision.disabled ||= !questionForTimer.value;
    startRecovery.disabled ||= !taskForTimer.value;
    markRepeat.disabled ||= !questionForRepeat.value;
    markResend.disabled ||= !commandForResend.value;
  };
  const addOptions = (select, items, placeholder, describe) => {
    const previous = select.value;
    const signature = JSON.stringify(items.map((item) => [item.id, describe(item)]));
    if (select.dataset.signature === signature) return;
    select.replaceChildren();
    const empty = node("option", placeholder);
    empty.value = "";
    select.append(empty);
    for (const item of items) {
      const option = node("option", describe(item));
      option.value = item.id;
      select.append(option);
    }
    select.dataset.signature = signature;
    select.value = items.some((item) => item.id === previous) ? previous : "";
  };
  const metricCard = (title, detail) => {
    const card = node("article", undefined, "card");
    card.append(node("h3", title), node("p", detail, "value"));
    return card;
  };
  const countLabel = (metric, suffix) =>
    metric?.count == null
      ? "未取得"
      : `${metric.count}${suffix}${metric.status === "partial" ? " · 一部のみ" : metric.status === "observed" ? " · 計測範囲内" : ""}`;
  function render() {
    if (!metrics) return;
    enabled.checked = metrics.enabled;
    if (retentionChoices.includes(metrics.retention_days))
      retention.value = String(metrics.retention_days);
    status.textContent = metrics.warning ||
      (metrics.enabled
        ? `計測中 · ${metrics.retention_days}日保持。集計はローカルのみです。`
        : metrics.coverage.status === "stopped"
          ? `計測停止中 · 過去${metrics.retention_days}日以内の集計を保持しています。`
          : "計測OFF · まだデータはありません。未計測を0件とは扱いません。");
    const decision = metrics.decision_time;
    const recovery = metrics.recovery_time;
    summary.replaceChildren(
      metricCard(
        "判断時間",
        decision?.sample_count
          ? `${formatTime(decision.median_ms)} 中央値 · ${decision.sample_count}回 · 合計 ${formatTime(decision.total_ms)}${decision.status === "partial" ? " · 一部のみ" : ""}`
          : `未計測${decision?.pending_count ? ` · 計測中${decision.pending_count}件` : ""}${decision?.unpaired_count ? ` · 未完了${decision.unpaired_count}件` : ""}`,
      ),
      metricCard("質問の再発", countLabel(metrics.question_recurrence, "回")),
      metricCard("指示の再送", countLabel(metrics.instruction_resend, "回")),
      metricCard(
        "ブロック復旧時間",
        recovery?.sample_count
          ? `${formatTime(recovery.median_ms)} 中央値 · ${recovery.sample_count}回 · 合計 ${formatTime(recovery.total_ms)}${recovery.status === "partial" ? " · 一部のみ" : ""}`
          : `未計測${recovery?.pending_count ? " · 計測中1件" : ""}${recovery?.unpaired_count ? ` · 未完了${recovery.unpaired_count}件` : ""}`,
      ),
      metricCard(
        "queue revision競合",
        countLabel(metrics.queue_revision_conflicts, "件"),
      ),
    );
    const coverage = metrics.coverage;
    if (coverage?.from)
      status.textContent += ` 記録範囲: ${new Date(coverage.from).toLocaleDateString("ja-JP")}〜${new Date(coverage.to).toLocaleDateString("ja-JP")}`;
    if (coverage?.partial)
      status.textContent += " 保存上限により、この期間の集計は一部のみです。";
    const timer = metrics.active_timer;
    if (timer) {
      const elapsed =
        timer.elapsed_ms +
        (timer.state === "running" ? Math.max(0, Date.now() - timerReadAt) : 0);
      timerStatus.textContent =
        `${timer.kind === "decision" ? "判断時間" : "ブロック復旧時間"}を計測中 · ${formatTime(elapsed)}` +
        (timer.kind === "decision" && timer.state === "paused" ? " · 一時停止中" : "");
      timerActions.hidden = false;
      pause.hidden = timer.kind !== "decision" || timer.state !== "running";
      resume.hidden = timer.kind !== "decision" || timer.state !== "paused";
      finish.hidden = false;
    } else {
      timerStatus.textContent = "判断・復旧タイマーは稼働していません。";
      timerActions.hidden = true;
    }
    setDisabled();
  }
  function refreshOptions(nextState) {
    state = nextState;
    const questions = state?.questions || [];
    const questionItems = questions.map((question) => ({
      id: question.id,
      text: question.question,
      pending: question.answer === null,
    }));
    const blockedTasks = (state?.tasks || [])
      .filter((task) => task.status === "blocked")
      .map((task) => ({ id: task.id, title: task.title }));
    const requests = Object.values(state?.instructions?.requests || {}).map(
      (request) => ({
        id: request.command_id,
        text: request.text,
        mode: request.mode,
        created_at: request.created_at,
      }),
    );
    const signature = JSON.stringify([
      questionItems,
      blockedTasks,
      requests,
    ]);
    if (optionsSignature === signature) return;
    optionsSignature = signature;
    addOptions(
      questionForTimer,
      questionItems.filter((question) => question.pending),
      "計測対象を選択",
      (question) => `${question.id} · ${question.text.slice(0, 100)}`,
    );
    addOptions(
      questionForRepeat,
      questionItems,
      "再発した質問を選択",
      (question) => `${question.id} · ${question.text.slice(0, 100)}`,
    );
    addOptions(
      taskForTimer,
      blockedTasks,
      "ブロック中のタスクを選択",
      (task) => `${task.id} · ${task.title.slice(0, 100)}`,
    );
    addOptions(
      commandForResend,
      requests,
      "再送した指示を選択",
      (request) => `${request.created_at} · ${request.mode} · ${request.text.slice(0, 100)}`,
    );
    setDisabled();
  }
  async function load() {
    try {
      metrics = await api("human-metrics");
      timerReadAt = Date.now();
      render();
      return true;
    } catch (error) {
      status.textContent = `ローカル指標を読み込めません: ${error.message}`;
      return false;
    }
  }
  async function act(input, message) {
    if (pending) return;
    pending = true;
    setDisabled();
    status.textContent = message;
    try {
      metrics = await api("human-metrics", input);
      timerReadAt = Date.now();
      render();
      status.textContent = "ローカル指標を更新しました。";
    } catch (error) {
      status.textContent = error.message;
      await load();
      status.textContent = error.message;
    } finally {
      pending = false;
      setDisabled();
    }
  }
  const saveSettings = () =>
    act(
      {
        action: "configure",
        enabled: enabled.checked,
        retention_days: Number(retention.value),
      },
      "設定を保存中…",
    );
  enabled.addEventListener("change", saveSettings);
  retention.addEventListener("change", saveSettings);
  startDecision.addEventListener("click", () =>
    act(
      { action: "start_decision_timer", question_id: questionForTimer.value },
      "判断時間の計測を開始中…",
    ),
  );
  startRecovery.addEventListener("click", () =>
    act(
      { action: "start_recovery_timer", task_id: taskForTimer.value },
      "復旧時間の計測を開始中…",
    ),
  );
  pause.addEventListener("click", () => act({ action: "pause_timer" }, "一時停止中…"));
  resume.addEventListener("click", () => act({ action: "resume_timer" }, "計測を再開中…"));
  finish.addEventListener("click", () => act({ action: "finish_timer" }, "計測を保存中…"));
  markRepeat.addEventListener("click", () =>
    act(
      { action: "mark_question_recurrence", question_id: questionForRepeat.value },
      "再発記録を保存中…",
    ),
  );
  markResend.addEventListener("click", () =>
    act(
      { action: "mark_instruction_resend", command_id: commandForResend.value },
      "再送記録を保存中…",
    ),
  );
  exportButton.addEventListener("click", async () => {
    if (!(await load())) return;
    const tokenValue = state?.metrics?.input_tokens;
    const tokenObservation = state?.metric_observations?.input_tokens;
    const tokenKinds = ["measured", "agent_reported", "estimated", "unavailable"];
    const payload = {
      format: "rdsh-human-metrics-v1",
      exported_at: new Date().toISOString(),
      metrics,
      token_snapshot: {
        status:
          tokenValue == null
            ? "unavailable"
            : tokenKinds.includes(tokenObservation?.kind)
              ? tokenObservation.kind
              : "unknown",
        value: typeof tokenValue === "number" ? tokenValue : null,
        observed_at: tokenObservation?.observed_at || null,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = node("a");
    link.href = url;
    link.download = "rdsh-human-metrics.json";
    link.click();
    URL.revokeObjectURL(url);
    status.textContent =
      "集計のみをJSONに保存しました。同じsessionのtoken報告値と、人の指標を個別に比較してください。";
  });
  clearButton.addEventListener("click", () => {
    if (!confirm("保存したローカル指標と計測中のタイマーをすべて削除しますか？"))
      return;
    void act({ action: "clear" }, "ローカル記録を削除中…");
  });
  setInterval(() => {
    if (metrics?.active_timer?.state === "running") render();
  }, 1000);
  return {
    render: refreshOptions,
    reload: load,
  };
}
