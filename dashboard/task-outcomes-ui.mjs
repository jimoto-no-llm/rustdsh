import { observationView } from "./observations.mjs";

const statusNames = {
  pass: "成功",
  fail: "失敗",
  blocked: "確認できない",
  "not-run": "未実施",
  "not-defined": "条件未定義",
  definition_changed: "条件が変更されています",
  unknown: "未確認",
};
const freshnessLabels = {
  fresh: "",
  stale: "古い情報",
  unknown: "鮮度未確認",
  unavailable: "未取得",
};
const date = (value) =>
  value ? new Date(value).toLocaleString("ja-JP") : "未申告";

function renderTaskObservation(node, status, details, task, now) {
  const view = observationView(task.status, task.observation, now);
  const statusQualifier = view.current
    ? view.kind === "estimated"
      ? "推定・"
      : ""
    : (freshnessLabels[view.freshness] || "鮮度未確認") + "・";
  status.textContent = `${task.status}（${statusQualifier}作業の申告）`;
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
    node("span", view.label, "provenance-badge " + (view.kind || "unknown")),
  );
  if (view.freshness !== "fresh")
    heading.append(
      node(
        "span",
        freshnessLabels[view.freshness] || "鮮度未確認",
        "provenance-badge " + view.freshness,
      ),
    );
  panel.append(heading);
  if (view.value != null && !view.current)
    panel.append(node("div", "前回の報告状態：" + view.value, "sub"));
  panel.append(
    node("div", "観測：" + date(observation?.observed_at), "sub"),
    node("div", "報告元：" + (observation?.source || "未申告"), "sub"),
    node("div", "参照対象：" + (observation?.reference || "未申告"), "sub"),
  );
  if (observation?.observed_at && observation.max_age_seconds) {
    const expiresAt = new Date(
      Date.parse(observation.observed_at) + observation.max_age_seconds * 1000,
    );
    panel.append(node("div", "鮮度期限：" + date(expiresAt.toISOString()), "sub"));
  }
  details.replaceChildren(panel);
}

function checkLabel(condition) {
  if (condition.verified) return "確認時点で検証済み";
  if (condition.freshness === "stale") return "対象が変わったため再検証が必要";
  if (condition.source === "operator_report")
    return "報告のみ・実行による検証は未確認";
  if (condition.status === "pass") return "成功の報告・検証は未確認";
  return statusNames[condition.status] || "未確認";
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
    const status = node("p", "現在の検証結果は未取得です", "sub");
    status.setAttribute("aria-live", "polite");
    const list = node("ul");
    const button = node("button", "受入条件と検証を確認");
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
              view ? checkLabel(condition) : "検証結果は未取得",
              condition.verified ? "doing" : "sub",
            ),
          );
          if (condition.partial_status)
            row.append(
              node(
                "p",
                `部分検査: ${statusNames[condition.partial_status] || "未確認"}（全条件の検証とは別）`,
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
            ? `固定した条件 ${view.verified_count} / ${view.condition_count} 件を確認`
            : view.status === "verified_checks"
              ? "宣言した全検査を確認時点で検証済み"
              : view.status === "unknown"
                ? "検証結果を取得できません"
                : view.conditions.length
                  ? "未充足の受入条件があります"
                  : "受入条件は未定義です";
        status.textContent = `${view.acceptance_task_id ? `受入対象 ${view.acceptance_task_id} · ` : ""}${summary} · 最終確認 ${new Date(view.observed_at).toLocaleString("ja-JP")}`;
        button.textContent = "検証結果を再確認";
      }
    }
    const previous = cached.get(key);
    if (previous?.state_revision === revision) show(previous);
    else show(null);
    button.onclick = async () => {
      button.disabled = true;
      status.textContent = "受入条件と現在の証拠を確認中…";
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
          "検証結果を取得できません。状態の更新後に再確認してください。";
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
        "確認後の変更は再確認してください。人による受入・正式採用は別に確認します。",
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
          ["目的", report.purpose],
          ["担当", report.owner],
          ["最新成果", report.latest_outcome],
          ["次の一手", report.next_step],
          ["ブロッカー", task.blocker || "申告なし"],
          ["節目", task.milestone],
          [
            "更新",
            task.updated_at &&
              new Date(task.updated_at).toLocaleString("ja-JP"),
          ],
        ])
          facts.append(node("dt", label), node("dd", value || "未申告"));
        card.append(
          facts,
          evidencePanel("task_id", task.id, state.revision, epoch),
        );
        return card;
      }),
    );
    if (!state.tasks.length)
      tasks.append(node("p", "タスクはまだ登録されていません", "empty"));
    const contracts = state.task_outcomes?.milestones || [];
    milestones.replaceChildren(
      ...contracts.map((contract) => {
        const card = node("article", undefined, "decision-card");
        card.append(
          node("h3", `${contract.id} · ${contract.title}`),
          node(
            "p",
            "終了条件はこの節目の固定リストです。作業を追加・分割しても分母は変わりません。",
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
        node("p", `${legacy.join(" / ")} · 終了条件は未定義です`, "sub"),
      );
    if (!contracts.length && !legacy.length)
      milestones.append(
        node("p", "マイルストーンはまだ登録されていません", "empty"),
      );
    scheduleObservationRefresh();
  };
}
