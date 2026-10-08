const labels = {
  saved: "保存済み · 次ターン待ち",
  read: "対象が読取済み · 適用待ち",
  started: "入力の送信を開始 · 処理結果待ち",
  succeeded: "入力処理完了 · ACP応答を確認",
  failed: "入力処理が中断・拒否・上限到達 · ACP応答を確認",
  unknown: "入力結果は不明 · 再送を保留",
  unapplied: "対象sessionが終了 · 未適用",
};
const modes = {
  next_turn: "次ターンへ追加",
  steer: "現ターンへsteer（非対応時は次ターン）",
  interrupt: "現在の入力を明示中断して変更",
};
const actorLabels = {
  human: "人間",
  management_agent: "管理エージェント",
  administrator: "ローカル管理者",
};
const at = (v) => (v ? new Date(v).toLocaleString("ja-JP") : "未確認");
const resultLabels = {
  native_prompt_completed: "元のCLIがこの入力の処理完了を返しました",
  native_prompt_cancelled: "元のCLIがこの入力の取消しを返しました",
  native_prompt_refused: "元のCLIがこの入力を拒否しました",
  native_prompt_limit: "元のCLIが入力処理の上限到達を返しました",
  native_result_missing: "対応する入力処理の結果を確認できません",
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
    text = node("textarea"),
    timing = node("select");
  const status = node("p", "対象sessionを選んで追指示を保存します。", "sub"),
    interrupt = node("input"),
    interruptLabel = node("label"),
    targetNote = node("p", "", "sub");
  const submit = node("button", "追指示を保存"),
    clear = node("button", "別の追指示を作る"),
    cards = node("div", undefined, "decision-grid");
  select.id = "instruction-target";
  text.id = "instruction-text";
  timing.id = "instruction-timing";
  text.rows = 5;
  text.maxLength = 8000;
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
  label("追指示を送るrun / session", select);
  form.append(targetNote);
  label("追指示の内容", text);
  label("適用するタイミング", timing);
  interruptLabel.append(
    interrupt,
    node("span", " 表示した現在の入力を中断することを確認しました"),
  );
  form.append(interruptLabel, submit, clear, status);
  root.append(form, cards);
  function save() {
    if (key && draft) {
      try {
        sessionStorage.setItem(key, JSON.stringify(draft));
      } catch {
        status.textContent =
          "この端末で下書きを保存できません。ページを閉じる前に内容を控えてください。";
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
    draft.text = text.value;
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
    text.value = draft?.text || "";
    timing.value = draft?.mode || "next_turn";
    interrupt.checked = false;
    confirmedActiveId = null;
    status.textContent = draft?.submission
      ? "前の保存結果は未確認です。同じIDで保存を確認できます。"
      : draft
        ? "この端末の下書きを復元しました。"
        : "対象sessionを選んで追指示を保存します。";
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
    text.readOnly = frozen;
    timing.disabled = frozen;
    interruptLabel.hidden = timing.value !== "interrupt";
    targetNote.textContent = consumer
      ? `task ${consumer.task_id || "未紐付け"} · run ${consumer.run_id} · session ${consumer.session_id}${active ? ` · 現在の入力 ${active.command_id}` : " · 処理中の入力は未確認"}`
      : "接続済みの対象がありません。reply-consumerで元のsessionへ接続してください。";
    submit.disabled =
      posting ||
      !consumer ||
      !text.value.trim() ||
      (!frozen &&
        timing.value === "interrupt" &&
        (!active || !interrupt.checked));
    submit.textContent = frozen ? "同じIDで保存結果を確認" : "追指示を保存";
    clear.disabled = posting;
    return { consumer, active };
  }
  select.addEventListener("change", () => {
    target = select.value;
    load();
    renderRequests();
  });
  text.addEventListener("input", edit);
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
    text.focus();
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
      status.textContent = `${result.request.status === "review_required" ? "保存済み · 同時入力または中断の確認待ち" : "保存済み · 対象の読取・入力処理は別に確認します"} · ${result.request.command_id}`;
      draft = null;
      try {
        sessionStorage.removeItem(key);
      } catch {}
      text.value = "";
      interrupt.checked = false;
      await refreshState().catch(() => {
        status.textContent +=
          " · 一覧の更新は未確認です。ページを開き直して保存したIDを確認してください。";
      });
    } catch (error) {
      status.textContent = `保存結果を確認できません。下書きとIDを保持しました。${error.message}`;
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
        node("h3", `${actorLabels[request.actor]}からの追指示`),
        node("pre", request.text, "instruction-text"),
        node(
          "p",
          `希望: ${modes[request.mode]} · ${request.effective_mode ? `適用: ${modes[request.effective_mode]}` : "配送を保留"}`,
          "sub",
        ),
      );
      if (request.mode === "steer")
        article.append(
          node(
            "p",
            "このCLIではsteerを確認できません。次ターン待ちとして扱います。",
            "warn",
          ),
        );
      if (request.status === "review_required") {
        article.append(
          node(
            "p",
            "確認待ち · 指示を上書きせず、配送を保留しています。",
            "warn",
          ),
          node("h4", "先に入っている指示との比較"),
        );
        const existing = inputs(state, target).slice(-20);
        for (const c of existing)
          article.append(
            node("p", `${c.command_id} · ${c.phase}`, "sub"),
            node("pre", inputText(state, c), "instruction-text"),
          );
        if (!existing.length)
          article.append(
            node("p", "既存の入力はありません。中断には人間の確認が必要です。"),
          );
        article.append(
          node("h4", "新しく追加しようとしている指示"),
          node("pre", request.text, "instruction-text"),
        );
        const reviewed = node("input"),
          confirmation = node("label"),
          result = node("p", "", "sub");
        reviewed.type = "checkbox";
        confirmation.append(
          reviewed,
          node("span", " 内容と適用先を比較しました"),
        );
        article.append(confirmation);
        const choices = [
          ["append_next_turn", "確認して次ターンへ追加"],
          ...(request.mode === "interrupt"
            ? [["approve_interrupt", "確認した入力を中断して追加"]]
            : []),
          ["reject", "この追指示を取り下げる"],
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
              result.textContent =
                error.message + "。最新の内容を確認してください。";
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
        article.append(node("p", "取り下げ済み · 未配送", "sub"));
      else {
        if (command.queue_blocker)
          article.append(
            node(
              "p",
              `先の入力 ${command.queue_blocker.command_id} を待っています · ${command.queue_blocker.phase === "unknown" ? "結果不明のため配送を保留" : command.queue_blocker.phase === "started" ? "現在の入力の処理結果待ち" : "保存した順番に配送"}`,
              command.queue_blocker.phase === "unknown" ? "warn" : "sub",
            ),
          );
        article.append(
          node(
            "p",
            labels[command.display_phase] || labels[command.phase],
            command.display_phase === "unknown" ? "warn" : "reply-state",
          ),
          node(
            "p",
            `順番 ${command.queue_sequence} · 保存 ${at(command.saved_at)} · 読取 ${at(command.read_at)} · 送信 ${at(command.started_at)} · 結果 ${at(command.completed_at)}`,
            "sub",
          ),
        );
        if (resultLabels[command.result_reason])
          article.append(node("p", resultLabels[command.result_reason], "sub"));
        if (request.control)
          article.append(
            node(
              "p",
              `中断の対象: ${request.control.target_command_id} · ${request.control.phase === "confirmed" ? "元の入力のキャンセル応答を確認" : request.control.phase === "not_needed" ? "対象の入力は中断要求前に終了" : "キャンセル結果は未確認・次の入力を保留"}`,
              ["confirmed", "not_needed"].includes(request.control.phase)
                ? "sub"
                : "warn",
            ),
          );
      }
      article.append(
        node(
          "p",
          `run ${request.run_id} · session ${request.session_id} · ${request.command_id}`,
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
            `${c.task_id || "タスク未紐付け"} · ${c.run_id} · ${c.session_id}`,
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
