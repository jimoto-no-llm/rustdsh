const statusNames = {
  current: "現行",
  replaced: "置換済み",
  withdrawn: "撤回",
  hold: "保留",
};

export function createDecisionLogPanel(container, { node, api, refreshState }) {
  const form = node("form", undefined, "decision-card decision-compose");
  const subject = node("input");
  subject.type = "text";
  subject.required = true;
  subject.maxLength = 200;
  subject.autocomplete = "off";
  subject.setAttribute("aria-label", "決定の対象");
  const policy = node("textarea");
  policy.required = true;
  policy.maxLength = 8000;
  policy.setAttribute("aria-label", "採用する方針");
  const rationale = node("textarea");
  rationale.maxLength = 8000;
  rationale.setAttribute("aria-label", "理由");
  const changeSummary = node("textarea");
  changeSummary.maxLength = 4000;
  changeSummary.setAttribute("aria-label", "変更点");
  const question = node("select");
  question.setAttribute("aria-label", "元の質問と回答");
  const task = node("select");
  task.setAttribute("aria-label", "関連タスク");
  const supersedes = node("select");
  supersedes.setAttribute("aria-label", "置換する決定");
  let latestState = { decision_log: { records: [] }, tasks: [], questions: [] };
  function field(label, control, help) {
    const wrapper = node("label", undefined, "decision-field");
    wrapper.append(node("span", label), control);
    if (help) wrapper.append(node("span", help, "sub"));
    return wrapper;
  }
  form.append(
    node("h3", "人間が選んだ方針を記録"),
    node(
      "p",
      "理由は空欄のまま保存できます。未記録はそのまま表示します。置換する場合は同じ対象の前の決定を明示してください。",
      "sub",
    ),
    field("対象", subject),
    field("方針", policy),
    field("理由（任意）", rationale),
    field("変更点（置換時・任意）", changeSummary),
    field("元の質問と回答（任意）", question),
    field("関連タスク（任意）", task),
    field("置換元（任意）", supersedes),
  );
  const submit = node("button", "決定を保存", "primary");
  submit.type = "submit";
  const error = node("p", "", "error");
  error.setAttribute("role", "alert");
  form.append(submit, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    error.textContent = "";
    try {
      await api("decision-log", {
        action: "record",
        subject: subject.value,
        policy: policy.value,
        rationale: rationale.value,
        change_summary: changeSummary.value,
        question_id: question.value || null,
        task_id: task.value || null,
        supersedes_id: supersedes.value || null,
      });
      form.reset();
      await refreshState();
    } catch (reason) {
      error.textContent = reason.message;
    } finally {
      submit.disabled = false;
    }
  });
  const list = node("div", undefined, "decision-grid");
  container.replaceChildren(
    form,
    node("h3", "決定の履歴"),
    list,
  );

  function fill(select, options, placeholder) {
    const previous = select.value;
    const signature = JSON.stringify([
      placeholder,
      ...options.map(([value, label]) => [value, label]),
    ]);
    if (select.dataset.options === signature) return;
    select.replaceChildren(node("option", placeholder));
    select.options[0].value = "";
    for (const [value, label] of options) {
      const option = node("option", label);
      option.value = value;
      select.append(option);
    }
    select.dataset.options = signature;
    if (options.some(([value]) => value === previous)) select.value = previous;
  }
  function appendDetail(details, label, value) {
    details.append(node("dt", label), node("dd", value));
  }
  function render(state) {
    latestState = state;
    const records = state.decision_log?.records || [];
    const answered = state.questions.filter((item) => item.answer !== null);
    fill(
      question,
      answered.map((item) => [
        item.id,
        `${item.id} · ${item.question} → ${item.answer}`,
      ]),
      "質問を選ばない",
    );
    fill(
      task,
      state.tasks.map((item) => [item.id, `${item.id} · ${item.title}`]),
      "タスクを選ばない",
    );
    const subjectValue = subject.value.trim();
    const sameSubject = records.filter((item) => item.subject === subjectValue);
    const current = sameSubject.find((item) => item.status === "current");
    const candidates = sameSubject.filter((item) =>
      current
        ? item.id === current.id
        : ["hold", "withdrawn"].includes(item.status),
    );
    fill(
      supersedes,
      candidates.map((item) => [
        item.id,
        `${item.id} · ${item.policy} · ${statusNames[item.status]}`,
      ]),
      subjectValue ? "新しい対象として記録" : "対象を入力すると候補を表示",
    );
    list.replaceChildren(
      ...records
        .slice()
        .reverse()
        .map((record) => {
          const article = node("article", undefined, "decision-card");
          article.id = "decision-" + record.id;
          const heading = node("div", undefined, "decision-heading");
          heading.append(
            node("span", statusNames[record.status] || record.status),
            node("span", `${record.subject} · ${record.id}`, "sub"),
          );
          article.append(heading, node("h3", record.policy));
          const details = node("dl", undefined, "decision-details");
          appendDetail(
            details,
            "理由",
            record.rationale || "理由未記録",
          );
          appendDetail(
            details,
            "変更前",
            record.supersedes_id
              ? records.find((item) => item.id === record.supersedes_id)?.policy ||
                  `決定 ${record.supersedes_id}`
              : "なし（新規決定）",
          );
          appendDetail(
            details,
            "変更点",
            record.supersedes_id
              ? record.change_summary || "変更点未記録"
              : "該当なし",
          );
          appendDetail(details, "記録日時", new Date(record.created_at).toLocaleString("ja-JP"));
          if (record.status_changed_at)
            appendDetail(
              details,
              "状態変更",
              `${statusNames[record.status]} · ${new Date(record.status_changed_at).toLocaleString("ja-JP")}` +
                (record.status_reason
                  ? ` · ${record.status_reason}`
                  : " · 理由未記録"),
            );
          if (record.replaced_by_id) {
            const successor = records.find((item) => item.id === record.replaced_by_id);
            article.append(
              node(
                "p",
                `置換先: ${successor?.policy || record.replaced_by_id}`,
                "warn",
              ),
            );
          }
          if (record.question)
            appendDetail(
              details,
              "元の質問と回答",
              `${record.question.id}` +
                (record.question.revision
                  ? ` · 版 ${record.question.revision} · ${record.question.status}`
                  : ` · ${record.question.status}`) +
                ` · ${record.question.question}\n回答: ${record.question.answer}`,
            );
          if (record.task_id)
            appendDetail(details, "関連タスク", record.task_id);
          article.append(details);
          if (record.status === "current") {
            for (const [action, label] of [
              ["hold", "保留にする"],
              ["withdraw", "撤回する"],
            ]) {
              const button = node("button", label);
              button.type = "button";
              button.addEventListener("click", async () => {
                if (!window.confirm(`${record.subject}の方針を「${label}」にしますか？`))
                  return;
                button.disabled = true;
                try {
                  await api("decision-log", { action, id: record.id });
                  await refreshState();
                } catch (reason) {
                  error.textContent = reason.message;
                } finally {
                  button.disabled = false;
                }
              });
              article.append(button);
            }
          }
          return article;
        }),
    );
    if (!records.length) list.append(node("p", "決定ログはまだありません。", "sub"));
  }
  subject.addEventListener("input", () => {
    render(latestState);
  });
  return render;
}
