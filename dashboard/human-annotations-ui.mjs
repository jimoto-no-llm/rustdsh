import { text, formatDateTime } from "./locale.mjs";
import {
  annotationSnapshotId,
  decisionTargetId,
  eventIdentifier,
  eventTargetId,
} from "./annotation-identifiers.mjs";

export function createHumanAnnotationPanel(container, { api, node, navigateTo }) {
  const status = node("p", text("annotation.intro"), "sub");
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
  const submit = node("button", text("annotation.save"));
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
  taskSelect.setAttribute("aria-label", text("annotation.task"));
  kindSelect.required = true;
  kindSelect.append(
    option("event", text("annotation.event")),
    option("decision", text("annotation.decision")),
    option("diff", text("annotation.diff")),
  );
  kindSelect.setAttribute("aria-label", text("annotation.kind"));
  eventSelect.required = true;
  eventLine.type = "number";
  eventLine.min = "1";
  eventLine.max = "1000000";
  eventLine.placeholder = text("annotation.optionalLine");
  eventLine.setAttribute("aria-label", text("annotation.eventLine"));
  decisionSelect.required = true;
  decisionSelect.setAttribute("aria-label", text("annotation.answered"));
  commitInput.type = "text";
  commitInput.maxLength = 64;
  commitInput.autocomplete = "off";
  commitInput.placeholder = text("annotation.head");
  commitInput.setAttribute("aria-label", text("annotation.sha"));
  pathInput.type = "text";
  pathInput.maxLength = 1000;
  pathInput.placeholder = "src/example.rs";
  pathInput.setAttribute("aria-label", text("annotation.path"));
  diffLine.type = "number";
  diffLine.min = "1";
  diffLine.max = "1000000";
  diffLine.required = true;
  diffLine.placeholder = text("annotation.line");
  diffLine.setAttribute("aria-label", text("annotation.targetLine"));
  noteInput.required = true;
  noteInput.maxLength = 1200;
  noteInput.placeholder = text("annotation.noteHint");
  noteInput.setAttribute("aria-label", text("annotation.note"));
  submit.type = "submit";

  const eventTarget = targetSection("event", text("annotation.eventTarget"));
  eventTarget.append(
    labeled("event", eventSelect),
    labeled(text("annotation.detailLine"), eventLine, text("annotation.whole")),
  );
  const decisionTarget = targetSection("decision", text("annotation.decisionTarget"));
  decisionTarget.append(labeled(text("annotation.question"), decisionSelect));
  const diffTarget = targetSection("diff", text("annotation.gitTarget"));
  diffTarget.append(
    labeled("commit SHA", commitInput, text("annotation.pinCommit")),
    labeled(text("annotation.file"), pathInput, text("annotation.relativeHint")),
    labeled(text("annotation.line"), diffLine),
  );
  form.append(
    labeled(text("annotation.task"), taskSelect),
    labeled(text("annotation.kind"), kindSelect),
    eventTarget,
    decisionTarget,
    diffTarget,
    labeled(text("annotation.note"), noteInput),
    submit,
  );
  container.replaceChildren(status, form, list);

  function showTargetFields() {
    for (const [kind, section] of fields) {
      const active = kind === kindSelect.value;
      section.hidden = !active;
      for (const control of section.querySelectorAll(
        "input, select, textarea",
      ))
        control.disabled = !active;
    }
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
        ...orphanedTaskIds.map((taskId) => option(taskId, text("annotation.orphan", {id:taskId}))),
      ],
      selectedTask,
      text("annotation.selectTask"),
    );
    const selectedEvent = eventSelect.value;
    renderOptions(
      eventSelect,
      [...state.events].reverse().map((event) => {
        const id = eventIdentifier(event);
        return option(id, `${event.title} · ${id}`);
      }),
      selectedEvent,
      text("annotation.selectEvent"),
    );
    const selectedDecision = decisionSelect.value;
    renderOptions(
      decisionSelect,
      [...state.questions]
        .filter((question) => typeof question.answer === "string")
        .reverse()
        .map((question) => option(question.id, `${question.id} · ${question.question}`)),
      selectedDecision,
      text("annotation.selectDecision"),
    );
  }

  function renderRecord(record) {
    const article = node("article", undefined, "human-annotation-card");
    const target = record.target;
    const code = record.reference_status?.code || "missing";
    article.append(
      node(
        "p",
        record.reference_status?.label || text("annotation.unknown"),
        `human-annotation-status ${code}`,
      ),
    );
    let liveTargetId = null;
    let label = "";
    if (target.kind === "event") {
      label = `${target.title} · ${target.event_id}${target.line ? text("annotation.detail", {line:target.line}) : ""}`;
      liveTargetId = eventTargetId(target.event_id);
    } else if (target.kind === "decision") {
      label = text("annotation.decisionLabel", {id:target.question_id,revision:target.revision == null ? "" : text("annotation.revision", {revision:target.revision})});
      liveTargetId = decisionTargetId(target.question_id);
    } else {
      label = `${target.commit.slice(0, 12)} · ${target.path}:${target.line}`;
    }
    article.append(node("p", label, "sub"), node("p", record.note));
    const snapshot = node("details", undefined, "human-annotation-source");
    snapshot.id = annotationSnapshotId(record.id);
    snapshot.append(node("summary", text("annotation.snapshot")));
    if (target.kind === "decision") {
      snapshot.append(
        node("p", text("annotation.questionLabel", {question:target.question_excerpt})),
        node("pre", target.answer_excerpt),
      );
    } else snapshot.append(node("pre", target.excerpt));
    article.append(
      node(
        "p",
        text("annotation.author", {time:formatDateTime(record.created_at)}),
        "sub",
      ),
    );
    const actions = node("div", undefined, "human-annotation-actions");
    const destination = code === "current" && liveTargetId
      ? liveTargetId
      : annotationSnapshotId(record.id);
    const navigate = node(
      "button",
      code === "current" && liveTargetId ? text("annotation.navigate") : text("annotation.savedReference"),
    );
    navigate.type = "button";
    navigate.addEventListener("click", () => navigateTo(destination));
    const remove = node("button", text("annotation.delete"));
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!globalThis.confirm?.(text("annotation.confirmDelete"))) return;
      remove.disabled = true;
      try {
        await api("annotations", { action: "delete", id: record.id });
        await refresh();
        status.textContent = text("annotation.deleted");
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
      list.replaceChildren(node("p", text("annotation.chooseTask"), "empty"));
      return;
    }
    if (!records.length) {
      list.replaceChildren(node("p", text("annotation.empty"), "empty"));
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
      status.textContent = text("annotation.loadFailed", {error:error.message});
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
      status.textContent = text("annotation.saved");
      await refresh();
    } catch (error) {
      status.textContent = text("annotation.saveFailed", {error:error.message});
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
