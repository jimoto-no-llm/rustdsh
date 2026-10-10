import { createQuestionRecovery, draftReviewState, questionEditable } from "./answer-recovery.mjs";
export { draftReviewState } from "./answer-recovery.mjs";

const localRecoveries = new WeakMap();
const statusNames = {
  open: "回答待ち",
  answered: "回答を保存済み",
  expired: "期限切れ · 回答不可",
  cancelled: "取消し · 回答不可",
  superseded: "旧版 · 回答は無効",
};

export function renderQuestionCards(
  container,
  questions,
  contracts,
  options,
) {
  const { node, api, refreshState, applyState } = options;
  // Keep the existing standalone renderer API usable without a project store.
  if (!options.recovery && !localRecoveries.has(container))
    localRecoveries.set(container, { recovery: createQuestionRecovery(""), revision: 0 });
  const local = localRecoveries.get(container);
  const recovery = options.recovery || local.recovery;
  if (!options.recovery) recovery.reconcile({
    revision: ++local.revision, questions, question_contracts: contracts,
  });
  const rerender = options.rerender || (() => renderQuestionCards(container, questions, contracts, options));
  const focused = document.activeElement;
  const active = focused?.dataset?.question;
  const field = focused?.dataset?.field;
  const focusedReference = focused?.tagName === "SUMMARY" ? focused.parentElement?.dataset?.questionKey : null;
  const expandedReferences = new Set([...container.querySelectorAll("details")]
    .filter((item) => item.open && item.dataset.questionKey).map((item) => item.dataset.questionKey));
  const selection =
    focused?.tagName === "TEXTAREA"
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection]
      : null;
  container.replaceChildren(
    ...questions.map((question) => {
      const original = contracts?.cards[question.id];
      const contract =
        original &&
        original.status !== "cancelled" &&
        original.snapshot.decision.expires_at &&
        Date.parse(original.snapshot.decision.expires_at) <= Date.now()
          ? { ...original, status: "expired" }
          : original;
      const decision = contract?.snapshot.decision;
      const draft = recovery.draftFor(question, contract);
      const editable = questionEditable(contract) && draft.phase !== "conflict";
      const locked = draft.phase === "sending" || draft.phase === "checking";
      const { changedDraft, reviewRequired } = draftReviewState(
        draft,
        contract,
      );
      const article = node("article", undefined, "decision-card");
      article.id = "question-" + question.id;
      const heading = node("div", undefined, "decision-heading question-meta");
      heading.append(
        node(
          "span",
          decision?.kind === "approval" ? "承認依頼" : "相談",
          "kind" + (decision?.kind === "approval" ? " kind-approval" : ""),
        ),
        node("code", question.id, "question-id"),
        node("span", `緊急度: ${{ normal: "通常", high: "高", critical: "至急" }[question.urgency] || question.urgency}`, "sub question-urgency"),
      );
      article.append(heading, node("h3", question.question, "question-text"));
      if (contract) {
        article.append(
          node(
            "p",
            `版 ${contract.revision} · ${statusNames[contract.status]}`,
            "sub",
          ),
        );
        if (contract.changed_fields.length)
          article.append(
            node(
              "p",
              `変更: ${contract.changed_fields.join("、")}。旧版の回答は無効です。`,
              "warn",
            ),
          );
        const target = decision.target;
        const detail = node("dl", undefined, "decision-details");
        const add = (label, value) =>
          detail.append(node("dt", label), node("dd", value));
        add(
          "対象",
          target
            ? [
                target.task_id && `task ${target.task_id}`,
                target.run_id && `run ${target.run_id}`,
                target.session_id && `session ${target.session_id}`,
                target.action_id && `action ${target.action_id}`,
                `対象の版 ${target.revision}`,
              ]
                .filter(Boolean)
                .join(" · ")
            : "指定なし",
        );
        if (decision.consumer_id) add("回答consumer", decision.consumer_id);
        const previous = contract.history.at(-1)?.snapshot.decision;
        if (previous && contract.changed_fields.includes("費用上限"))
          article.append(
            node(
              "p",
              `費用上限の変更: ${previous.cost?.max == null ? "未確認" : "$" + previous.cost.max.toFixed(2)} → ${decision.cost?.max == null ? "未確認" : "$" + decision.cost.max.toFixed(2)} USD`,
              "warn",
            ),
          );
        if (previous?.target && contract.changed_fields.includes("対象・版"))
          article.append(
            node(
              "p",
              `以前の対象: ${Object.entries(previous.target)
                .filter(([, value]) => value !== null)
                .map(([key, value]) => `${key} ${value}`)
                .join(" · ")}`,
              "sub",
            ),
          );
        add("差分", decision.diff || "指定なし");
        add("影響", decision.impact || "指定なし");
        add("条件", decision.conditions || "指定なし");
        add(
          "費用上限",
          decision.cost
            ? `${decision.cost.max === null ? "未確認" : "$" + decision.cost.max.toFixed(2)} USD${decision.cost.description ? " · " + decision.cost.description : ""}`
            : "指定なし",
        );
        if (decision.recommended_choice)
          add(
            "推奨と理由",
            `${decision.choices.find((choice) => choice.id === decision.recommended_choice).label} · ${decision.recommendation_reason}`,
          );
        if (decision.expires_at)
          add("期限", new Date(decision.expires_at).toLocaleString("ja-JP"));
        if (contract.cancel_reason) add("取消し理由", contract.cancel_reason);
        article.append(detail);
      }
      if (question.default_action) {
        const reference = node("details", undefined, "question-reference");
        reference.dataset.questionKey = draft.key;
        reference.open = expandedReferences.has(draft.key);
        reference.append(node("summary", "回答前の参考情報"),
          node("p", `${question.default_action}（自動実行しません）`));
        article.append(reference);
      }
      const form = node("form", undefined, "answer-form");
      form.dataset.id = question.id;
      form.dataset.draftFingerprint =
        draft?.fingerprint || contract?.fingerprint || "";
      form.dataset.draftRevision = draft?.revision || contract?.revision || "";
      form.dataset.reviewedFingerprint = draft?.reviewed || "";
      form.dataset.reviewedRevision = draft?.reviewedRevision || "";
      const choices = decision?.choices || [];
      if (choices.length) {
        const group = node("fieldset");
        group.append(node("legend", "選択肢（自動選択しません）"));
        for (const choice of choices) {
          const label = node("label", undefined, "decision-choice");
          const radio = node("input");
          radio.type = "radio";
          radio.name = `choice-${question.id}`;
          radio.value = choice.id;
          radio.dataset.question = question.id;
          radio.dataset.field = `choice-${choice.id}`;
          radio.disabled = !editable || locked || reviewRequired;
          radio.checked = !reviewRequired && draft?.choice === choice.id;
          radio.addEventListener("change", () => {
            if (radio.checked) recovery.change(draft, { choice: choice.id });
          });
          label.append(radio, node("span", choice.label));
          if (choice.detail)
            label.append(node("span", choice.detail, "sub choice-detail"));
          group.append(label);
        }
        form.append(group);
      }
      const textarea = node("textarea");
      textarea.id = "answer-" + question.id;
      textarea.dataset.id = question.id;
      textarea.dataset.question = question.id;
      textarea.dataset.field = "answer";
      textarea.setAttribute("aria-label", `質問 ${question.id} への回答`);
      textarea.required = choices.length === 0;
      textarea.maxLength = 8000;
      textarea.disabled = !editable;
      textarea.readOnly = locked;
      textarea.value = draft?.text || "";
      textarea.addEventListener("input", () => recovery.change(draft, { text: textarea.value }));
      const answerLabel = node("label", "回答");
      answerLabel.setAttribute("for", textarea.id);
      form.append(answerLabel, textarea);
      const button = node("button", draft.phase === "sending" ? "送信中…" :
        draft.phase === "checking" ? "結果確認待ち…" : draft.phase === "retry" ? "内容を確認して再送" : "回答を返す", "primary");
      button.type = "submit";
      button.disabled = !editable || reviewRequired || locked;
      if (changedDraft) {
        form.append(
          node(
            "p",
            "質問が更新されました。下書きは保存しています。更新後の対象と条件を確認し、選択肢を選び直してください。",
            "warn",
          ),
        );
        const label = node("label", undefined, "decision-choice");
        const review = node("input");
        review.type = "checkbox";
        review.dataset.question = question.id;
        review.dataset.field = "review";
        review.checked = !reviewRequired;
        review.disabled = !editable || locked;
        review.addEventListener("change", () => {
          recovery.change(draft, { reviewed: review.checked ? contract.fingerprint : null,
            reviewedRevision: review.checked ? contract.revision : null });
          rerender();
        });
        label.append(review, node("span", "更新後の対象と条件を確認した"));
        form.append(label);
      }
      const error = node("div", draft?.error || "", "error");
      error.setAttribute("role", "alert");
      const actions = node("div", undefined, "answer-actions");
      actions.append(button);
      if (draft.phase === "checking") {
        const check = node("button", "送信結果を確認");
        check.type = "button";
        check.addEventListener("click", refreshState);
        actions.append(check);
      }
      const discard = node("button", "下書きを破棄");
      discard.type = "button";
      discard.disabled = locked;
      discard.addEventListener("click", () => { recovery.discard(draft); rerender(); });
      actions.append(discard);
      const status = node("p", draft.phase === "checking" ?
        "送信結果がまだ分かりません。接続後に保存状態を確認してください。" :
        draft.phase === "retry" ? "保存済みの回答は見つかりませんでした。内容を確認して再送できます。" : "", "sub");
      status.setAttribute("role", "status");
      form.append(actions, status, error);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!editable || button.disabled) return;
        recovery.change(draft, { text: textarea.value,
          choice: form.querySelector('input[type="radio"]:checked')?.value ?? null });
        const operation = recovery.beginSend(question, contract);
        if (!operation) {
          error.textContent = !textarea.value.trim() && !draft.choice
            ? choices.length ? "空白以外の回答を入力するか、選択肢を選んでください。" : "空白以外の回答を入力してください。"
            : "質問の対象・条件を確認し直してください。";
          textarea.focus();
          return;
        }
        rerender();
        try {
          const state = await api("update/answer", operation.payload);
          if (applyState) applyState(state);
          else {
            if (state) recovery.reconcile(state);
            await refreshState();
          }
        } catch {
          // A failed response is not proof that the answer was not saved.
        }
        if (recovery.checkResult(operation)) {
          rerender();
          await refreshState();
        }
      });
      if (contract && editable) {
        const cancel = node("button", "この質問を取消す");
        cancel.type = "button";
        cancel.disabled = locked;
        cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          try {
            await api("decision/cancel", {
              id: question.id,
              expected_revision: contract.revision,
              cancel_reason: "人間が取消しました",
            });
            await refreshState();
          } catch (e) {
            error.textContent = e.message;
            cancel.disabled = false;
          }
        });
        actions.append(cancel);
      }
      article.append(
        form,
        node("p", "回答はこの版への返答です。実行権限は発行しません。", "sub"),
      );
      if (contract?.history.some((record) => record.answer)) {
        const history = node("details");
        history.append(node("summary", "旧版の回答（無効）"));
        for (const record of contract.history.filter((item) => item.answer))
          history.append(
            node(
              "p",
              `版 ${record.revision}: ${record.answer.text} · 旧版の対象への回答です。`,
            ),
          );
        article.append(history);
      }
      return article;
    }),
  );
  if (!questions.length)
    container.append(node("p", "未回答の質問はありません", "empty"));
  if (active) {
    const element = [...container.querySelectorAll("[data-question]")].find(
      (item) =>
        item.dataset.question === active && item.dataset.field === field,
    );
    if (element && !element.disabled) {
      element.focus({ preventScroll: true });
      if (selection) element.setSelectionRange(...selection);
    }
  }
  if (focusedReference) [...container.querySelectorAll("details")]
    .find((item) => item.dataset.questionKey === focusedReference)?.querySelector("summary")?.focus({ preventScroll: true });
  renderRetainedDrafts(recovery, node, rerender);
}

function renderRetainedDrafts(recovery, node, rerender) {
  const section = document.getElementById?.("retained-drafts");
  const container = document.getElementById?.("retained-draft-list");
  if (!section || !container) return;
  const active = document.activeElement;
  const selection = active?.dataset?.draftKey ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
  const retained = recovery.retained();
  section.hidden = !retained.length;
  container.replaceChildren(...retained.map((entry) => {
    const item = node("article", undefined, "event");
    const copy = node("textarea");
    copy.dataset.draftKey = entry.key;
    copy.value = entry.text || entry.submitted?.answer || `選択肢: ${entry.choice}`;
    copy.readOnly = true;
    copy.setAttribute("aria-label", `以前の質問 ${entry.id} の下書き`);
    const discard = node("button", "下書きを破棄");
    discard.type = "button";
    discard.addEventListener("click", () => { recovery.discard(entry); rerender(); });
    item.append(node("strong", entry.id + " · " + entry.question), copy, discard);
    return item;
  }));
  if (selection) {
    const replacement = [...container.querySelectorAll("textarea")].find((item) => item.dataset.draftKey === active.dataset.draftKey);
    replacement?.focus({ preventScroll: true });
    replacement?.setSelectionRange(...selection);
  }
}
