const statusLabels = {
  todo: "未着手",
  doing: "進行中",
  done: "完了報告",
  blocked: "保留",
};
const observationLabels = {
  measured: "実測",
  agent_reported: "agent報告",
  estimated: "推定",
  unavailable: "未取得",
};
const metricLabels = {
  total_cost_usd: "累計費用",
  total_budget_usd: "予算",
  session_cost_usd: "session費用",
  session_budget_usd: "session予算",
  input_tokens: "入力token",
  cached_input_tokens: "cache token",
  model_calls: "model呼出し",
  tool_calls: "tool呼出し",
  tool_errors: "tool error",
  context_misses: "context miss",
  auto_continues: "自動継続",
  refusals: "拒否",
  api_errors: "API error",
};
const changeLabels = {
  "dashboard.answer.created": "回答を保存",
  "dashboard.question.created": "判断の質問を更新",
  "dashboard.task.updated": "タスクを更新",
  "dashboard.progress.updated": "進捗報告を追加",
  "dashboard.metrics.updated": "指標を更新",
};
const validTime = (value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};
const shortText = (value, max = 220) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? text.slice(0, max) + "…" : text;
};

export function updateSummary(state, baseline) {
  if (!baseline)
    return { mode: "initial", items: [], historyGap: false, total: 0 };
  if (
    baseline.schema !== 1 ||
    !Number.isSafeInteger(baseline.revision) ||
    !Number.isSafeInteger(state.revision) ||
    typeof baseline.timestamp !== "string" ||
    !Number.isFinite(Date.parse(baseline.timestamp))
  )
    return { mode: "unavailable", items: [], historyGap: false, total: 0 };
  if (state.revision < baseline.revision)
    return { mode: "reset", items: [], historyGap: false, total: 0 };
  if (state.revision === baseline.revision)
    return { mode: "unchanged", items: [], historyGap: false, total: 0 };

  const after = (value) => {
    const time = validTime(value);
    return time !== null && time > Date.parse(baseline.timestamp);
  };
  const items = [];
  const add = (item) => items.push(item);
  const records = (Array.isArray(state.change_records)
    ? state.change_records
    : [])
    .filter((record) => Number.isSafeInteger(record.revision))
    .sort((a, b) => a.revision - b.revision);
  const recordsSince = records.filter((record) => record.revision > baseline.revision);
  const recordsByEntity = new Map();
  for (const record of recordsSince) {
    let byName = recordsByEntity.get(record.entity_id);
    if (!byName) recordsByEntity.set(record.entity_id, (byName = new Map()));
    byName.set(record.name, record);
  }
  const recordFor = (entityId, names) => {
    const byName = recordsByEntity.get(entityId);
    if (!byName) return null;
    let latest = null;
    for (const name of names) {
      const record = byName.get(name);
      if (record && (!latest || record.revision > latest.revision)) latest = record;
    }
    return latest;
  };
  const recordTarget = (record) => record?.event_id
    ? `change-${record.event_id}`
    : null;
  const recordDetail = (record) => record
    ? `元記録: ${record.event_id} · 版 ${record.revision}`
    : "";
  const hasTaskSnapshot = Object.hasOwn(baseline, "taskStates");
  for (const task of state.tasks || []) {
    const previous = baseline.taskStates?.[task.id];
    const hasBlocker = Boolean(task.blocker);
    const source = recordFor(task.id, ["dashboard.task.updated"]);
    const newTask = hasTaskSnapshot && !previous;
    const statusChanged = previous && previous.status !== task.status;
    const blockerChanged = previous && previous.hasBlocker !== hasBlocker;
    if (!after(task.updated_at) && !newTask && !statusChanged && !blockerChanged && !source)
      continue;
    const beforeStatus = statusLabels[previous?.status] || "未記録";
    const currentStatus = statusLabels[task.status] || "不明";
    const detail = [
      statusChanged
        ? `状態: ${beforeStatus} → ${currentStatus}`
        : `状態: ${currentStatus}`,
    ];
    if (blockerChanged)
      detail.push(
        `保留要因: ${previous.hasBlocker ? "あり" : "なし"} → ${hasBlocker ? "あり" : "なし"}`,
      );
    const kind = task.observation?.kind;
    if (kind) detail.push(`根拠: ${observationLabels[kind] || "未分類"}`);
    if (recordDetail(source)) detail.push(recordDetail(source));
    if ((task.status === "blocked" || hasBlocker) && !blockerChanged)
      detail.push(`現在の保留要因: ${shortText(task.blocker) || "未記載"}`);
    add({
      id: `task-${task.id}`,
      at: task.updated_at,
      title: `タスク更新: ${shortText(task.title) || task.id}`,
      detail: detail.join(" · "),
      target: recordTarget(source) || `task-${task.id}`,
      targetLabel: recordTarget(source) ? "元記録を開く" : "タスクを開く",
      sourceEventId: source?.event_id,
    });
  }
  for (const question of state.questions || []) {
    const createdSource = recordFor(question.id, ["dashboard.question.created"]);
    if (after(question.created_at) || createdSource) {
      const contract = state.question_contracts?.cards?.[question.id];
      const decisionStatus = contract?.status ||
        (question.answer === null ? "open" : "answered");
      const status = {
        open: "判断待ち",
        answered: "回答済み",
        expired: "期限切れ",
        cancelled: "取消し",
        superseded: "改訂済み",
      }[decisionStatus] || "状態未確認";
      add({
        id: `question-${question.id}-created`,
        at: question.created_at,
        title: `判断の質問: ${status}`,
        detail: [question.id, shortText(question.question), recordDetail(createdSource)]
          .filter(Boolean)
          .join(" · "),
        target: recordTarget(createdSource) || (question.answer === null
          ? `question-${question.id}`
          : `answer-${question.id}`),
        targetLabel: recordTarget(createdSource) ? "元記録を開く" : "質問を開く",
        sourceEventId: createdSource?.event_id,
      });
    }
    const answerSource = recordFor(question.id, ["dashboard.answer.created"]);
    if (after(question.answered_at) || answerSource)
      add({
        id: `question-${question.id}-answered`,
        at: question.answered_at,
        title: "質問への回答が保存されました",
        detail: [question.id, shortText(question.question), recordDetail(answerSource)]
          .filter(Boolean)
          .join(" · "),
        target: recordTarget(answerSource) || `answer-${question.id}`,
        targetLabel: recordTarget(answerSource) ? "元記録を開く" : "回答を開く",
        sourceEventId: answerSource?.event_id,
      });
    const contract = state.question_contracts?.cards?.[question.id];
    const contractSource = recordFor(question.id, ["dashboard.question.created"]);
    if (contract && (after(contract.updated_at) || contractSource) &&
      contract.updated_at !== question.created_at &&
      contract.updated_at !== question.answered_at)
      add({
        id: `question-${question.id}-contract`,
        at: contract.updated_at,
        title: `質問条件が更新されました · 版 ${contract.revision}`,
        detail: [contract.changed_fields?.length
          ? `変更: ${contract.changed_fields.join("、")}`
          : contract.status, recordDetail(contractSource)].filter(Boolean).join(" · "),
        target: recordTarget(contractSource) || `question-${question.id}`,
        targetLabel: recordTarget(contractSource) ? "元記録を開く" : "質問を開く",
        sourceEventId: contractSource?.event_id,
      });
  }
  const events = Array.isArray(state.events) ? state.events : [];
  const lastEventSequence = Number.isSafeInteger(baseline.eventSequence)
    ? baseline.eventSequence
    : 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) ||
      event.sequence <= lastEventSequence) continue;
    const kind = observationLabels[event.observation?.kind] || "根拠未分類";
    const detail = [event.type, kind, shortText(event.detail)]
      .filter(Boolean)
      .join(" · ");
    add({
      id: `event-${event.sequence}`,
      at: event.created_at,
      title: `報告: ${shortText(event.title) || "無題"}`,
      detail,
      target: `event-${event.sequence}`,
      targetLabel: "報告を開く",
    });
  }
  const metricSource = recordsSince
    .filter((record) => record.name === "dashboard.metrics.updated")
    .at(-1);
  const metricChanges = Object.entries(state.metric_observations || {})
    .filter(([key, observation]) => {
      const recorded = observation?.recorded_at || observation?.observed_at;
      return after(recorded) ||
        (recorded && recorded !== baseline.metricRecords?.[key]);
    })
    .map(([key]) => metricLabels[key] || key);
  if (metricChanges.length || metricSource)
    add({
      id: "metrics",
      at: state.updated_at,
      title: "数値レポートが更新されました",
      detail: [...new Set(metricChanges), recordDetail(metricSource)]
        .filter(Boolean)
        .join(" · "),
      target: recordTarget(metricSource) || "metrics-heading",
      targetLabel: recordTarget(metricSource) ? "元記録を開く" : "数値詳細を開く",
      sourceEventId: metricSource?.event_id,
    });

  const firstEventSequence = events[0]?.sequence;
  const changeHistoryGap = state.change_history_gap === true;
  const historyGap = changeHistoryGap || (events.length >= 1000 &&
    Number.isSafeInteger(firstEventSequence) &&
    lastEventSequence < firstEventSequence - 1);
  const mode = items.length ? "changed" : "untracked";
  items.sort((a, b) => (validTime(b.at) || 0) - (validTime(a.at) || 0));
  return { mode, items, historyGap, total: items.length };
}

function checkpoint(state) {
  return {
    schema: 1,
    revision: state.revision,
    timestamp: state.updated_at || new Date().toISOString(),
    eventSequence: Math.max(
      0,
      ...(state.events || []).map((event) =>
        Number.isSafeInteger(event.sequence) ? event.sequence : 0,
      ),
    ),
    metricRecords: Object.fromEntries(
      Object.entries(state.metric_observations || {}).map(([key, observation]) => [
        key,
        observation?.recorded_at || observation?.observed_at || null,
      ]),
    ),
    taskStates: Object.fromEntries(
      (state.tasks || []).map((task) => [
        task.id,
        {
          status: task.status,
          hasBlocker: Boolean(task.blocker),
          updatedAt: task.updated_at,
        },
      ]),
    ),
  };
}

export function createUpdateSummary(root, {
  node,
  navigateTo,
  loadChangeRecords,
  onSourceRecords,
}) {
  let projectId = null;
  let storage = null;
  let baseline = null;
  let initialBaselineRevision = null;
  let latestState = null;
  let storageUnavailable = false;
  let changeRecords = [];
  let changeCursor = 0;
  let changeHistoryGap = false;
  let changeFetchPending = false;
  let changeFetchFailed = false;
  let failedAtRevision = null;
  let generation = 0;

  function loadBaseline(id) {
    const key = `rdsh.update-summary.v1.${id}`;
    let raw;
    try {
      raw = storage?.getItem(key);
    } catch {
      storageUnavailable = true;
      return { kind: "invalid" };
    }
    if (!raw) return { kind: "missing" };
    try {
      const value = JSON.parse(raw);
      return value?.schema === 1 && Number.isSafeInteger(value.revision) &&
        typeof value.timestamp === "string" &&
        Number.isFinite(Date.parse(value.timestamp))
        ? { kind: "valid", value }
        : { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
  }

  function saveBaseline(state) {
    baseline = checkpoint(state);
    try {
      storage?.setItem(
        `rdsh.update-summary.v1.${projectId}`,
        JSON.stringify(baseline),
      );
    } catch {
      storageUnavailable = true;
    }
  }

  function sourceEventIds(items) {
    return [...new Set(items.slice(0, 20)
      .map((item) => item.sourceEventId)
      .filter(Boolean))];
  }

  function render(state) {
    const active = root.contains(document.activeElement)
      ? document.activeElement.dataset.summaryFocus || null
      : null;
    latestState = state;
    if (projectId !== state.project?.id) {
      projectId = state.project?.id || "unknown";
      try {
        storage = window.localStorage;
      } catch {
        storage = null;
        storageUnavailable = true;
      }
      const saved = loadBaseline(projectId);
      baseline = saved.kind === "valid" ? saved.value : null;
      initialBaselineRevision = saved.kind === "missing" ? state.revision : null;
      if (initialBaselineRevision !== null) saveBaseline(state);
      else if (saved.kind === "invalid")
        baseline = { schema: 0, revision: -1, timestamp: "invalid" };
      changeRecords = [];
      changeHistoryGap = false;
      changeCursor = baseline?.schema === 1 ? baseline.revision : state.revision;
      changeFetchPending = false;
      changeFetchFailed = false;
      failedAtRevision = null;
      generation++;
    }
    const summaryState = {
      ...state,
      change_records: changeRecords,
      change_history_gap: changeHistoryGap,
    };
    let result = updateSummary(summaryState, baseline);
    if (state.revision === initialBaselineRevision) {
      result = { ...result, mode: "initial" };
    } else initialBaselineRevision = null;
    const shouldFetch = baseline?.schema === 1 &&
      typeof loadChangeRecords === "function" &&
      state.revision > changeCursor &&
      !changeFetchPending &&
      failedAtRevision !== state.revision;
    const statusText = shouldFetch || changeFetchPending
      ? `前回確認からの更新記録を取得しています（現在版 ${state.revision}）。`
      : {
      initial: "初回確認です。現在の版を基準に保存しました。次回から新しい更新だけを表示します。",
      unchanged: "前回確認した版からの変更はありません。",
      changed: `前回確認した版 ${baseline.revision} から ${result.total} 件の更新があります（現在版 ${state.revision}）。`,
      untracked: `状態は版 ${state.revision} に更新されていますが、差分を示す記録がありません。全体を確認してください。`,
      reset: `保存状態が以前の版に戻っています（${baseline.revision} → ${state.revision}）。比較を続ける前に確認位置を更新してください。`,
      unavailable: "前回の確認位置が壊れているか、未対応の形式です。現在の状態と全履歴を確認してください。",
    }[result.mode];
    const status = node("p", statusText, "sub");
    status.id = "update-summary-status";
    status.setAttribute("role", "status");
    status.tabIndex = -1;
    const list = node("ul");
    list.id = "update-summary-items";
    const visibleItems = result.items.slice(0, 20);
    for (const item of visibleItems) {
      const row = node("li");
      row.append(node("strong", item.title));
      if (item.detail) row.append(node("span", ` · ${item.detail}`));
      const time = validTime(item.at);
      if (time !== null) {
        const stamp = node(
          "time",
          new Date(time).toLocaleString("ja-JP"),
          "sub",
        );
        stamp.dateTime = new Date(time).toISOString();
        row.append(document.createTextNode(" · "), stamp);
      }
      const source = node("button", item.targetLabel || "関連記録を開く");
      source.type = "button";
      source.dataset.summaryFocus = item.id;
      source.setAttribute("aria-label", `${item.title} · ${source.textContent}`);
      source.addEventListener("click", () => navigateTo(item.target));
      row.append(document.createTextNode(" "), source);
      list.append(row);
    }
    if (result.total > visibleItems.length)
      list.append(
        node(
          "li",
          `最新 ${visibleItems.length} 件を表示中（全 ${result.total} 件）`,
        ),
      );
    if (!visibleItems.length && result.mode !== "untracked")
      list.append(node("li", "表示する更新はありません。", "empty"));
    const notes = [];
    if (result.historyGap)
      notes.push("保持上限を越えたため、前回位置からの一部記録がありません。完全な差分ではありません。");
    if (changeFetchFailed)
      notes.push("更新イベントを取得できませんでした。前回位置からの比較は未確認です。");
    if (storageUnavailable)
      notes.push("確認位置をこのブラウザーに保存できません。再読込後の比較は未確認です。");
    const note = node("p", notes.join(" "), "warn");
    note.hidden = notes.length === 0;
    const retry = changeFetchFailed ? node("button", "更新イベントを再取得") : null;
    if (retry) {
      retry.type = "button";
      retry.addEventListener("click", () => {
        changeFetchFailed = false;
        failedAtRevision = null;
        if (latestState) render(latestState);
      });
    }
    const markRead = node(
      "button",
      result.mode === "initial" ? "確認位置を保存済み" : "ここまで確認済みにする",
    );
    markRead.type = "button";
    markRead.id = "update-summary-mark-read";
    markRead.dataset.summaryFocus = "mark-read";
    const awaitingHistory = shouldFetch || changeFetchPending || changeFetchFailed;
    const alreadyCurrent = state.revision === baseline.revision &&
      result.mode !== "reset" && result.mode !== "unavailable";
    markRead.disabled = alreadyCurrent;
    markRead.setAttribute("aria-disabled", String(awaitingHistory || alreadyCurrent));
    if (awaitingHistory)
      markRead.title = "更新記録の取得が終わるまで確認位置を進められません。";
    markRead.addEventListener("click", () => {
      if (!latestState || awaitingHistory || alreadyCurrent) return;
      saveBaseline(latestState);
      changeRecords = [];
      changeCursor = latestState.revision;
      changeHistoryGap = false;
      changeFetchPending = false;
      changeFetchFailed = false;
      failedAtRevision = null;
      generation++;
      const sources = render(latestState);
      onSourceRecords?.(sources.records, sources.sourceEventIds, latestState);
    });
    root.replaceChildren(status, note, ...(retry ? [retry] : []), list, markRead);
    if (active) {
      const nextFocus = [...root.querySelectorAll("[data-summary-focus]")]
        .find((element) => element.dataset.summaryFocus === active);
      if (nextFocus && !nextFocus.disabled) nextFocus.focus();
      else status.focus();
    }
    const sources = {
      records: changeRecords.slice(),
      sourceEventIds: sourceEventIds(result.items),
    };
    if (shouldFetch) {
      changeFetchPending = true;
      const requestGeneration = generation;
      const afterRevision = changeCursor;
      const requestRevision = state.revision;
      Promise.resolve(loadChangeRecords(afterRevision)).then((snapshot) => {
        if (requestGeneration !== generation || projectId !== state.project?.id) return;
        if (!snapshot || !Number.isSafeInteger(snapshot.revision) ||
          snapshot.revision < afterRevision || !Array.isArray(snapshot.records))
          throw new Error("Invalid change-record response");
        const byId = new Map(changeRecords.map((record) => [record.event_id, record]));
        for (const record of snapshot.records)
          if (typeof record?.event_id === "string" &&
            Number.isSafeInteger(record.revision) &&
            record.revision > baseline.revision)
            byId.set(record.event_id, record);
        changeRecords = [...byId.values()].sort((a, b) => a.revision - b.revision);
        changeCursor = snapshot.revision;
        changeHistoryGap ||= snapshot.history_gap === true;
        changeFetchPending = false;
        changeFetchFailed = false;
        failedAtRevision = null;
        const current = latestState;
        const updatedSources = render(current);
        onSourceRecords?.(updatedSources.records, updatedSources.sourceEventIds, current);
      }).catch(() => {
        if (requestGeneration !== generation) return;
        changeFetchPending = false;
        changeFetchFailed = true;
        failedAtRevision = requestRevision;
        if (latestState) render(latestState);
      });
    }
    return sources;
  }
  return render;
}
