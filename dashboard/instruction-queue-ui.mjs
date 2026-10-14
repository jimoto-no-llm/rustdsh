import { text, formatDateTime } from "./locale.mjs";

const labels = {
  saved: text("queue.phase.saved"),
  read: text("queue.phase.read"),
  started: text("queue.phase.started"),
  succeeded: text("queue.phase.succeeded"),
  failed: text("queue.phase.failed"),
  unknown: text("queue.phase.unknown"),
  unapplied: text("queue.phase.unapplied"),
};
const modes = {
  next_turn: text("queue.mode.next_turn"),
  steer: text("queue.mode.steer"),
  interrupt: text("queue.mode.interrupt"),
};
const actorLabels = {
  human: text("queue.actor.human"),
  management_agent: text("queue.actor.management_agent"),
  administrator: text("queue.actor.administrator"),
};
const at = (v) => (v ? formatDateTime(v) : text("queue.unconfirmed"));
const resultLabels = {
  native_prompt_completed: text("queue.result.native_prompt_completed"),
  native_prompt_cancelled: text("queue.result.native_prompt_cancelled"),
  native_prompt_refused: text("queue.result.native_prompt_refused"),
  native_prompt_limit: text("queue.result.native_prompt_limit"),
  native_result_missing: text("queue.result.native_result_missing"),
};
const inputs = (state, target) =>
  [
    ...Object.values(state.answer_applications?.commands || {}),
    ...Object.values(state.instructions?.commands || {}),
  ]
    .filter((c) => c.consumer_id === target)
    .sort(
      (a, b) =>
        (a.queue_sequence ?? a.feedback_sequence) -
        (b.queue_sequence ?? b.feedback_sequence),
    );
const inputText = (state, c) =>
  c.source_kind === "instruction"
    ? state.instructions.requests[c.command_id].text
    : state.feedback.find((m) => m.sequence === c.feedback_sequence)?.answer ||
      "";

export function createInstructionPanel(root, { node, api, refreshState }) {
  let confirmedActiveId = null,
    posting = false;
  let state,
    target = "",
    draft,
    key = "",
    signature = "";
  const form = node("form"),
    select = node("select"),
    area = node("textarea"),
    timing = node("select");
  const status = node("p", text("queue.intro"), "sub"),
    interrupt = node("input"),
    interruptLabel = node("label"),
    targetNote = node("p", "", "sub");
  const submit = node("button", text("queue.submit")),
    clear = node("button", text("queue.clear")),
    cards = node("div", undefined, "decision-grid");
  select.id = "instruction-target";
  area.id = "instruction-text";
  timing.id = "instruction-timing";
  area.rows = 5;
  area.maxLength = 8000;
  interrupt.type = "checkbox";
  interrupt.id = "instruction-interrupt-confirm";
  status.id = "instruction-submit-status";
  status.setAttribute("role", "status");
  submit.type = "submit";
  clear.type = "button";
  for (const [value, title] of Object.entries(modes)) {
    const option = node("option", title);
    option.value = value;
    timing.append(option);
  }
  const label = (title, control) => {
    const el = node("label", title);
    el.htmlFor = control.id;
    form.append(el, control);
  };
  label(text("queue.target"), select);
  form.append(targetNote);
  label(text("queue.content"), area);
  label(text("queue.timing"), timing);
  interruptLabel.append(
    interrupt,
    node("span", text("queue.confirmInterrupt")),
  );
  form.append(interruptLabel, submit, clear, status);
  root.append(form, cards);
  function save() {
    if (key && draft) {
      try {
        sessionStorage.setItem(key, JSON.stringify(draft));
      } catch {
        status.textContent = text("queue.draftFailed");
      }
    }
  }
  function edit() {
    if (draft?.submission) return;
    if (!draft)
      draft = {
        command_id: "input_" + crypto.randomUUID(),
        expected_queue_revision: state.input_queue_revision,
        text: "",
        mode: "next_turn",
      };
    draft.text = area.value;
    draft.mode = timing.value;
    save();
    updateForm();
  }
  function load() {
    key = `rdsh_instruction_draft:${state.project.id}:${target}`;
    draft = null;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || "null");
      if (
        saved &&
        typeof saved.text === "string" &&
        typeof saved.command_id === "string" &&
        Number.isSafeInteger(saved.expected_queue_revision) &&
        Object.hasOwn(modes, saved.mode)
      )
        draft = saved;
    } catch {}
    area.value = draft?.text || "";
    timing.value = draft?.mode || "next_turn";
    interrupt.checked = false;
    confirmedActiveId = null;
    status.textContent = draft?.submission
      ? text("queue.retryDraft")
      : draft
        ? text("queue.restored")
        : text("queue.intro");
    updateForm();
  }
  function updateForm() {
    const consumer = state?.answer_applications?.consumers[target],
      active = state
        ? inputs(state, target).find((c) => c.phase === "started")
        : null;
    const frozen = !!draft?.submission;
    if (interrupt.checked && confirmedActiveId !== active?.command_id) {
      interrupt.checked = false;
      confirmedActiveId = null;
    }
    select.disabled = frozen || posting;
    area.readOnly = frozen;
    timing.disabled = frozen;
    interruptLabel.hidden = timing.value !== "interrupt";
    targetNote.textContent = consumer
      ? text("queue.targetSummary", {
          task: consumer.task_id || text("queue.unlinked"),
          run: consumer.run_id,
          session: consumer.session_id,
          active: active
            ? text("queue.active", { id: active.command_id })
            : text("queue.noActive"),
        })
      : text("queue.noTarget");
    submit.disabled =
      posting ||
      !consumer ||
      !area.value.trim() ||
      (!frozen &&
        timing.value === "interrupt" &&
        (!active || !interrupt.checked));
    submit.textContent = frozen
      ? text("queue.verifySave")
      : text("queue.submit");
    clear.disabled = posting;
    return { consumer, active };
  }
  select.addEventListener("change", () => {
    target = select.value;
    load();
    renderRequests();
  });
  area.addEventListener("input", edit);
  timing.addEventListener("change", () => {
    interrupt.checked = false;
    confirmedActiveId = null;
    edit();
  });
  interrupt.addEventListener("change", () => {
    confirmedActiveId = interrupt.checked
      ? inputs(state, target).find((c) => c.phase === "started")?.command_id ||
        null
      : null;
    updateForm();
  });
  clear.onclick = () => {
    draft = null;
    try {
      sessionStorage.removeItem(key);
    } catch {}
    load();
    area.focus();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (posting) return;
    const { consumer } = updateForm();
    if (submit.disabled) return;
    edit();
    if (!draft.submission)
      draft.submission = {
        command_id: draft.command_id,
        consumer_id: target,
        run_id: consumer.run_id,
        session_id: consumer.session_id,
        text: draft.text,
        mode: draft.mode,
        expected_queue_revision: draft.expected_queue_revision,
        ...(draft.mode === "interrupt"
          ? { active_command_id: confirmedActiveId }
          : {}),
      };
    save();
    posting = true;
    updateForm();
    submit.disabled = true;
    clear.disabled = true;
    try {
      const result = await api("instructions/submit", draft.submission);
      status.textContent = `${result.request.status === "review_required" ? text("queue.savedReview") : text("queue.saved")} · ${result.request.command_id}`;
      draft = null;
      try {
        sessionStorage.removeItem(key);
      } catch {}
      area.value = "";
      interrupt.checked = false;
      await refreshState().catch(() => {
        status.textContent += text("queue.refreshFailed");
      });
    } catch (error) {
      status.textContent = text("queue.saveFailed", { error: error.message });
    } finally {
      posting = false;
      clear.disabled = false;
      updateForm();
    }
  };
  function renderRequests() {
    cards.replaceChildren();
    const requests = Object.values(state.instructions?.requests || {})
      .filter((r) => r.consumer_id === target)
      .reverse()
      .slice(0, 20);
    for (const request of requests) {
      const command = state.instructions.commands[request.command_id],
        article = node("article", undefined, "decision-card");
      article.dataset.commandId = request.command_id;
      article.append(
        node(
          "h3",
          text("queue.heading", {
            actor: actorLabels[request.actor] || request.actor,
          }),
        ),
        node("pre", request.text, "instruction-text"),
        node(
          "p",
          text("queue.modes", {
            requested: modes[request.mode] || request.mode,
            effective: request.effective_mode
              ? text("queue.effective", {
                  mode: modes[request.effective_mode] || request.effective_mode,
                })
              : text("queue.held"),
          }),
          "sub",
        ),
      );
      if (request.mode === "steer")
        article.append(node("p", text("queue.steerUnsupported"), "warn"));
      if (request.status === "review_required") {
        article.append(
          node("p", text("queue.reviewPending"), "warn"),
          node("h4", text("queue.compare")),
        );
        const existing = inputs(state, target).slice(-20);
        for (const c of existing)
          article.append(
            node("p", `${c.command_id} · ${labels[c.phase] || c.phase}`, "sub"),
            node("pre", inputText(state, c), "instruction-text"),
          );
        if (!existing.length)
          article.append(node("p", text("queue.noExisting")));
        article.append(
          node("h4", text("queue.newInstruction")),
          node("pre", request.text, "instruction-text"),
        );
        const reviewed = node("input"),
          confirmation = node("label"),
          result = node("p", "", "sub");
        reviewed.type = "checkbox";
        confirmation.append(reviewed, node("span", text("queue.reviewed")));
        article.append(confirmation);
        const choices = [
          ["append_next_turn", text("queue.append")],
          ...(request.mode === "interrupt"
            ? [["approve_interrupt", text("queue.interruptAdd")]]
            : []),
          ["reject", text("queue.reject")],
        ];
        const buttons = choices.map(([decision, title]) => {
          const button = node("button", title);
          button.type = "button";
          button.disabled = true;
          button.onclick = async () => {
            const revision = state.input_queue_revision;
            buttons.forEach((b) => (b.disabled = true));
            try {
              await api("instructions/resolve", {
                command_id: request.command_id,
                expected_queue_revision: revision,
                decision,
              });
              await refreshState();
            } catch (error) {
              result.textContent = text("queue.resolveFailed", {
                error: error.message,
              });
              reviewed.checked = false;
              await refreshState().catch(() => {});
            }
          };
          article.append(button);
          return button;
        });
        reviewed.onchange = () =>
          buttons.forEach((button) => (button.disabled = !reviewed.checked));
        article.append(result);
      } else if (request.status === "rejected")
        article.append(node("p", text("queue.rejected"), "sub"));
      else {
        if (command.queue_blocker)
          article.append(
            node(
              "p",
              text("queue.blocker", {
                id: command.queue_blocker.command_id,
                reason:
                  command.queue_blocker.phase === "unknown"
                    ? text("queue.blocker.unknown")
                    : command.queue_blocker.phase === "started"
                      ? text("queue.blocker.started")
                      : ["saved", "read"].includes(command.queue_blocker.phase)
                        ? text("queue.blocker.ordered")
                        : command.queue_blocker.phase,
              }),
              command.queue_blocker.phase === "unknown" ? "warn" : "sub",
            ),
          );
        article.append(
          node(
            "p",
            labels[command.display_phase] ||
              labels[command.phase] ||
              command.display_phase ||
              command.phase,
            command.display_phase === "unknown" ? "warn" : "reply-state",
          ),
          node(
            "p",
            text("queue.times", {
              sequence: command.queue_sequence,
              saved: at(command.saved_at),
              read: at(command.read_at),
              started: at(command.started_at),
              completed: at(command.completed_at),
            }),
            "sub",
          ),
        );
        if (command.result_reason)
          article.append(
            node(
              "p",
              resultLabels[command.result_reason] || command.result_reason,
              "sub",
            ),
          );
        if (request.control)
          article.append(
            node(
              "p",
              text("queue.control", {
                id: request.control.target_command_id,
                status:
                  request.control.phase === "confirmed"
                    ? text("queue.control.confirmed")
                    : request.control.phase === "not_needed"
                      ? text("queue.control.not_needed")
                      : [
                            "pending",
                            "claimed",
                            "notification_sent",
                            "unknown",
                          ].includes(request.control.phase)
                        ? text("queue.control.pending")
                        : request.control.phase,
              }),
              ["confirmed", "not_needed"].includes(request.control.phase)
                ? "sub"
                : "warn",
            ),
          );
      }
      article.append(
        node(
          "p",
          text("queue.identifiers", {
            run: request.run_id,
            session: request.session_id,
            id: request.command_id,
          }),
          "sub",
        ),
      );
      cards.append(article);
    }
  }
  const render = (next) => {
    state = next;
    const consumers = Object.values(state.answer_applications?.consumers || {}),
      options = JSON.stringify(consumers.map((c) => c.consumer_id));
    if (signature !== options) {
      signature = options;
      select.replaceChildren(
        ...consumers.map((c) => {
          const option = node(
            "option",
            `${c.task_id || text("queue.unlinkedTask")} · ${c.run_id} · ${c.session_id}`,
          );
          option.value = c.consumer_id;
          return option;
        }),
      );
      if (!consumers.some((c) => c.consumer_id === target)) {
        target = consumers[0]?.consumer_id || "";
        select.value = target;
        load();
      } else select.value = target;
    }
    updateForm();
    renderRequests();
  };
  render.selectTarget = (id) => {
    if (posting || !state.answer_applications?.consumers[id] || id === target)
      return;
    target = id;
    select.value = target;
    load();
    renderRequests();
  };
  return render;
}
