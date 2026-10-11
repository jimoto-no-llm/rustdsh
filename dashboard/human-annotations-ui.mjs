import {
  annotationSnapshotId,
  decisionTargetId,
  eventIdentifier,
  eventTargetId,
} from "./annotation-identifiers.mjs";

export function createHumanAnnotationPanel(container, { api, node, navigateTo }) {
  const status = node("p", "人間の注釈をAI要約・event履歴と分けて保存します。", "sub");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const form = node("form");
  const taskSelect = node("select");
  const kindSelect = node("select");
  const eventSelect = node("select");
  const eventLine = node("input");
  const decisionSelect = node("select");
  const commitInput = node("input");
  const pathInput = node("input");
  const diffLine = node("input");
  const noteInput = node("textarea");
  const submit = node("button", "ブックマークを保存");
  const list = node("div", undefined, "human-annotation-list");
  const fields = new Map();
  let state = null;
  let data = { annotations: [], git_head: null };
  let stateRevision = -1;
  let loading = false;

  const option = (value, label) => {
    const element = node("option", label);
    element.value = value;
    return element;
  };
  const labeled = (label, control, hint) => {
    const wrapper = node("label", undefined, "human-annotation-field");
    wrapper.append(node("span", label), control);
    if (hint) wrapper.append(node("span", hint, "sub"));
    return wrapper;
  };
  const targetSection = (kind, title) => {
    const section = node("div", undefined, "human-annotation-target");
    section.dataset.kind = kind;
    section.append(node("h3", title));
    fields.set(kind, section);
    return section;
  };

  taskSelect.required = true;
  taskSelect.setAttribute("aria-label", "関連タスク");
  kindSelect.required = true;
  kindSelect.append(
    option("event", "ログ・event"),
    option("decision", "会話上の決定"),
    option("diff", "Git差分"),
  );
  kindSelect.setAttribute("aria-label", "参照の種類");
  eventSelect.required = true;
  eventLine.type = "number";
  eventLine.min = "1";
  eventLine.max = "1000000";
  eventLine.placeholder = "任意の行番号";
  eventLine.setAttribute("aria-label", "event detailの行番号");
  decisionSelect.required = true;
  decisionSelect.setAttribute("aria-label", "回答済みの決定");
  commitInput.type = "text";
  commitInput.maxLength = 64;
  commitInput.autocomplete = "off";
  commitInput.placeholder = "現行HEADを自動入力";
  commitInput.setAttribute("aria-label", "対象commitの完全なSHA");
  pathInput.type = "text";
  pathInput.maxLength = 1000;
  pathInput.placeholder = "src/example.rs";
  pathInput.setAttribute("aria-label", "project-relative path");
  diffLine.type = "number";
  diffLine.min = "1";
  diffLine.max = "1000000";
  diffLine.required = true;
  diffLine.placeholder = "行番号";
  diffLine.setAttribute("aria-label", "対象行番号");
  noteInput.required = true;
  noteInput.maxLength = 1200;
  noteInput.placeholder = "後から見返す理由や判断の要点";
  noteInput.setAttribute("aria-label", "人間の注釈");
  submit.type = "submit";

  const eventTarget = targetSection("event", "保存するログ参照");
  eventTarget.append(
    labeled("event", eventSelect),
    labeled("detailの行", eventLine, "空欄ならevent全体を固定します。"),
  );
  const decisionTarget = targetSection("decision", "保存する決定参照");
  decisionTarget.append(labeled("回答済みの質問", decisionSelect));
  const diffTarget = targetSection("diff", "保存するGit参照");
  diffTarget.append(
    labeled("commit SHA", commitInput, "完全なcommit IDで版を固定します。"),
    labeled("ファイルパス", pathInput, "project-relative pathを使います。"),
    labeled("行番号", diffLine),
  );
  form.append(
    labeled("関連タスク", taskSelect),
    labeled("参照の種類", kindSelect),
    eventTarget,
    decisionTarget,
    diffTarget,
    labeled("人間の注釈", noteInput),
    submit,
  );
  container.replaceChildren(status, form, list);

  function showTargetFields() {
    for (const [kind, section] of fields) section.hidden = kind !== kindSelect.value;
  }

  function renderOptions(select, values, selected, emptyLabel) {
    select.replaceChildren(option("", emptyLabel), ...values);
    select.value = selected;
  }

  function refreshSelects() {
    if (!state) return;
    const selectedTask = taskSelect.value;
    const existingTasks = [...state.tasks]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((task) => option(task.id, `${task.id} · ${task.title}`));
    const knownTaskIds = new Set(state.tasks.map((task) => task.id));
    const orphanedTaskIds = [...new Set(
      data.annotations
        .map((record) => record.task_id)
        .filter((taskId) => !knownTaskIds.has(taskId)),
    )].sort();
    renderOptions(
      taskSelect,
      [
        ...existingTasks,
        ...orphanedTaskIds.map((taskId) => option(taskId, `${taskId} · 一覧にないタスク`)),
      ],
      selectedTask,
      "関連タスクを選択",
    );
    const selectedEvent = eventSelect.value;
    renderOptions(
      eventSelect,
      [...state.events].reverse().map((event) => {
        const id = eventIdentifier(event);
        return option(id, `${event.title} · ${id}`);
      }),
      selectedEvent,
      "ログeventを選択",
    );
    const selectedDecision = decisionSelect.value;
    renderOptions(
      decisionSelect,
      [...state.questions]
        .filter((question) => typeof question.answer === "string")
        .reverse()
        .map((question) => option(question.id, `${question.id} · ${question.question}`)),
      selectedDecision,
      "回答済みの決定を選択",
    );
  }

  function renderRecord(record) {
    const article = node("article", undefined, "human-annotation-card");
    const target = record.target;
    const code = record.reference_status?.code || "missing";
    article.append(
      node(
        "p",
        record.reference_status?.label || "参照状態を確認できません",
        `human-annotation-status ${code}`,
      ),
    );
    let liveTargetId = null;
    let label = "";
    if (target.kind === "event") {
      label = `${target.title} · ${target.event_id}${target.line ? ` · detail行 ${target.line}` : ""}`;
      liveTargetId = eventTargetId(target.event_id);
    } else if (target.kind === "decision") {
      label = `決定 ${target.question_id}${target.revision == null ? "" : ` · 版 ${target.revision}`}`;
      liveTargetId = decisionTargetId(target.question_id);
    } else {
      label = `${target.commit.slice(0, 12)} · ${target.path}:${target.line}`;
    }
    article.append(node("p", label, "sub"), node("p", record.note));
    const snapshot = node("details", undefined, "human-annotation-source");
    snapshot.id = annotationSnapshotId(record.id);
    snapshot.append(node("summary", "保存時の参照内容（変更後の行へ付け替えません）"));
    if (target.kind === "decision") {
      snapshot.append(
        node("p", `質問: ${target.question_excerpt}`),
        node("pre", target.answer_excerpt),
      );
    } else snapshot.append(node("pre", target.excerpt));
    article.append(
      node(
        "p",
        `作成者: 人間 · 出所: ブラウザ · ${new Date(record.created_at).toLocaleString("ja-JP")}`,
        "sub",
      ),
    );
    const actions = node("div", undefined, "human-annotation-actions");
    const destination = code === "current" && liveTargetId
      ? liveTargetId
      : annotationSnapshotId(record.id);
    const navigate = node(
      "button",
      code === "current" && liveTargetId ? "参照先へ移動" : "保存した参照を見る",
    );
    navigate.type = "button";
    navigate.addEventListener("click", () => navigateTo(destination));
    const remove = node("button", "削除");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!globalThis.confirm?.("この人間のブックマークを削除しますか？")) return;
      remove.disabled = true;
      try {
        await api("annotations", { action: "delete", id: record.id });
        await refresh();
        status.textContent = "人間のブックマークを削除しました。";
      } catch (error) {
        status.textContent = error.message;
        remove.disabled = false;
      }
    });
    actions.append(navigate, remove);
    article.append(actions, snapshot);
    return article;
  }

  function renderList() {
    const records = data.annotations
      .filter((record) => record.task_id === taskSelect.value)
      .slice()
      .reverse();
    if (!taskSelect.value) {
      list.replaceChildren(node("p", "タスクを選ぶと、そのタスクのブックマークを表示します。", "empty"));
      return;
    }
    if (!records.length) {
      list.replaceChildren(node("p", "このタスクの人間のブックマークはありません。", "empty"));
      return;
    }
    list.replaceChildren(...records.map(renderRecord));
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const previousHead = data.git_head;
      data = await api("annotations");
      if (data.git_head && (!commitInput.value || commitInput.value === previousHead))
        commitInput.value = data.git_head;
      refreshSelects();
      renderList();
    } catch (error) {
      status.textContent = `人間のブックマークを読み込めません: ${error.message}`;
    } finally {
      loading = false;
    }
  }

  kindSelect.addEventListener("change", showTargetFields);
  taskSelect.addEventListener("change", renderList);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = {
      action: "create",
      kind: kindSelect.value,
      task_id: taskSelect.value,
      note: noteInput.value,
    };
    if (input.kind === "event") {
      input.event_id = eventSelect.value;
      input.line = eventLine.value ? Number(eventLine.value) : null;
    } else if (input.kind === "decision") {
      input.question_id = decisionSelect.value;
    } else {
      input.commit = commitInput.value;
      input.path = pathInput.value;
      input.line = Number(diffLine.value);
    }
    submit.disabled = true;
    try {
      await api("annotations", input);
      noteInput.value = "";
      status.textContent = "人間のブックマークを別ファイルへ保存しました。";
      await refresh();
    } catch (error) {
      status.textContent = `保存できません: ${error.message}`;
    } finally {
      submit.disabled = false;
    }
  });
  showTargetFields();

  return (nextState) => {
    const changed = nextState.revision !== stateRevision;
    state = nextState;
    stateRevision = nextState.revision;
    refreshSelects();
    renderList();
    if (changed) void refresh();
  };
}
