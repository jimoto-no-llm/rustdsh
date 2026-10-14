import { text, formatDateTime } from "./locale.mjs";

const targetFieldNames = Object.fromEntries(
  ["task_id", "run_id", "session_id", "action_id", "revision"].map((value) => [
    value,
    text(`question.targetField.${value}`),
  ]),
);

const changedFieldNames = {
  費用上限: text("question.field.費用上限"),
  "対象・版": text("question.field.対象・版"),
  差分: text("question.field.差分"),
  影響: text("question.field.影響"),
  条件: text("question.field.条件"),
  選択肢: text("question.field.選択肢"),
  推奨: text("question.field.推奨"),
  期限: text("question.field.期限"),
  質問: text("question.field.質問"),
  問い: text("question.field.問い"),
  緊急度: text("question.field.緊急度"),
  参考の行動: text("question.field.参考の行動"),
  質問の型: text("question.field.質問の型"),
  推奨理由: text("question.field.推奨理由"),
  回答consumer: text("question.field.回答consumer"),
};

const urgencyNames = Object.fromEntries(
  ["normal", "high", "critical"].map((value) => [
    value,
    text(`question.urgency.${value}`),
  ]),
);

const statusNames = {
  open: text("question.status.open"),
  answered: text("question.status.answered"),
  expired: text("question.status.expired"),
  cancelled: text("question.status.cancelled"),
  superseded: text("question.status.superseded"),
};

export function draftReviewState(draft, contract) {
  const changedDraft = Boolean(
    draft?.fingerprint &&
      (draft.fingerprint !== contract?.fingerprint ||
        draft.revision !== contract?.revision),
  );
  return {
    changedDraft,
    reviewRequired:
      changedDraft &&
      (draft.reviewed !== contract?.fingerprint ||
        draft.reviewedRevision !== contract?.revision),
  };
}

export function renderQuestionCards(
  container,
  questions,
  contracts,
  { node, api, refreshState },
) {
  const drafts = new Map(
    [...container.querySelectorAll("form")].map((form) => {
      const area = form.querySelector("textarea");
      return [
        form.dataset.id,
        {
          text: area.value,
          choice: form.querySelector('input[type="radio"]:checked')?.value,
          fingerprint: form.dataset.draftFingerprint,
          revision: Number(form.dataset.draftRevision) || null,
          reviewed: form.dataset.reviewedFingerprint,
          reviewedRevision: Number(form.dataset.reviewedRevision) || null,
          error: form.querySelector('[role="alert"]').textContent,
        },
      ];
    }),
  );
  const focused = document.activeElement;
  const active = focused?.dataset?.question;
  const field = focused?.dataset?.field;
  const selection =
    focused?.tagName === "TEXTAREA"
      ? [focused.selectionStart, focused.selectionEnd]
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
      const draft = drafts.get(question.id);
      const editable = !contract || contract.status === "open";
      const { changedDraft, reviewRequired } = draftReviewState(
        draft,
        contract,
      );
      const article = node("article", undefined, "decision-card");
      article.id = "question-" + question.id;
      const heading = node("div", undefined, "decision-heading");
      heading.append(
        node(
          "span",
          decision?.kind === "approval"
            ? text("question.approval")
            : decision?.kind && decision.kind !== "consultation"
              ? decision.kind
              : text("question.consultation"),
          "kind" + (decision?.kind === "approval" ? " kind-approval" : ""),
        ),
        node(
          "span",
          `${question.id} · ${urgencyNames[question.urgency] || question.urgency}`,
          "sub",
        ),
      );
      article.append(heading, node("h3", question.question));
      if (contract) {
        article.append(
          node(
            "p",
            text("question.version", {
              revision: contract.revision,
              status: statusNames[contract.status] || contract.status,
            }),
            "sub",
          ),
        );
        if (contract.changed_fields.length)
          article.append(
            node(
              "p",
              text("question.changed", {
                fields: contract.changed_fields
                  .map((field) => changedFieldNames[field] || field)
                  .join(text("question.separator")),
              }),
              "warn",
            ),
          );
        const target = decision.target;
        const detail = node("dl", undefined, "decision-details");
        const add = (label, value) =>
          detail.append(node("dt", label), node("dd", value));
        add(
          text("question.target"),
          target
            ? [
                target.task_id &&
                  text("question.target.task", { id: target.task_id }),
                target.run_id &&
                  text("question.target.run", { id: target.run_id }),
                target.session_id &&
                  text("question.target.session", { id: target.session_id }),
                target.action_id &&
                  text("question.target.action", { id: target.action_id }),
                text("question.targetVersion", { revision: target.revision }),
              ]
                .filter(Boolean)
                .join(" · ")
            : text("question.unspecified"),
        );
        if (decision.consumer_id)
          add(text("question.consumer"), decision.consumer_id);
        const previous = contract.history.at(-1)?.snapshot.decision;
        if (previous && contract.changed_fields.includes("費用上限"))
          article.append(
            node(
              "p",
              text("question.costChanged", {
                previous:
                  previous.cost?.max == null
                    ? text("question.unconfirmed")
                    : "$" + previous.cost.max.toFixed(2),
                current:
                  decision.cost?.max == null
                    ? text("question.unconfirmed")
                    : "$" + decision.cost.max.toFixed(2),
              }),
              "warn",
            ),
          );
        if (previous?.target && contract.changed_fields.includes("対象・版"))
          article.append(
            node(
              "p",
              text("question.previousTarget", {
                target: Object.entries(previous.target)
                  .filter(([, value]) => value !== null)
                  .map(
                    ([key, value]) =>
                      `${targetFieldNames[key] || key} ${value}`,
                  )
                  .join(" · "),
              }),
              "sub",
            ),
          );
        add(
          text("question.diff"),
          decision.diff || text("question.unspecified"),
        );
        add(
          text("question.impact"),
          decision.impact || text("question.unspecified"),
        );
        add(
          text("question.conditions"),
          decision.conditions || text("question.unspecified"),
        );
        add(
          text("question.cost"),
          decision.cost
            ? `${decision.cost.max === null ? text("question.unconfirmed") : "$" + decision.cost.max.toFixed(2)} USD${decision.cost.description ? " · " + decision.cost.description : ""}`
            : text("question.unspecified"),
        );
        if (decision.recommended_choice)
          add(
            text("question.recommended"),
            `${decision.choices.find((choice) => choice.id === decision.recommended_choice).label} · ${decision.recommendation_reason}`,
          );
        if (decision.expires_at)
          add(text("question.expires"), formatDateTime(decision.expires_at));
        if (contract.cancel_reason)
          add(text("question.cancelReason"), contract.cancel_reason);
        article.append(detail);
      }
      if (question.default_action)
        article.append(
          node(
            "p",
            text("question.defaultAction", { action: question.default_action }),
            "sub",
          ),
        );
      const form = node("form");
      form.dataset.id = question.id;
      form.dataset.draftFingerprint =
        draft?.fingerprint || contract?.fingerprint || "";
      form.dataset.draftRevision = draft?.revision || contract?.revision || "";
      form.dataset.reviewedFingerprint = draft?.reviewed || "";
      form.dataset.reviewedRevision = draft?.reviewedRevision || "";
      const choices = decision?.choices || [];
      if (choices.length) {
        const group = node("fieldset");
        group.append(node("legend", text("question.choices")));
        for (const choice of choices) {
          const label = node("label", undefined, "decision-choice");
          const radio = node("input");
          radio.type = "radio";
          radio.name = `choice-${question.id}`;
          radio.value = choice.id;
          radio.dataset.question = question.id;
          radio.dataset.field = `choice-${choice.id}`;
          radio.disabled = !editable;
          radio.checked = !reviewRequired && draft?.choice === choice.id;
          label.append(radio, node("span", choice.label));
          if (choice.detail)
            label.append(node("span", choice.detail, "sub choice-detail"));
          group.append(label);
        }
        form.append(group);
      }
      const textarea = node("textarea");
      textarea.dataset.question = question.id;
      textarea.dataset.field = "answer";
      textarea.setAttribute(
        "aria-label",
        text("question.answerLabel", { id: question.id }),
      );
      textarea.required = choices.length === 0;
      textarea.maxLength = 8000;
      textarea.disabled = !editable;
      textarea.value = draft?.text || "";
      form.append(textarea);
      const button = node("button", text("question.answer"), "primary");
      button.type = "submit";
      button.disabled = !editable || reviewRequired;
      if (changedDraft) {
        form.append(node("p", text("question.changedDraft"), "warn"));
        const label = node("label", undefined, "decision-choice");
        const review = node("input");
        review.type = "checkbox";
        review.dataset.question = question.id;
        review.dataset.field = "review";
        review.checked = !reviewRequired;
        review.disabled = !editable;
        review.addEventListener("change", () => {
          form.dataset.reviewedFingerprint = review.checked
            ? contract.fingerprint
            : "";
          form.dataset.reviewedRevision = review.checked
            ? contract.revision
            : "";
          button.disabled = !editable || !review.checked;
        });
        label.append(review, node("span", text("question.reviewed")));
        form.append(label);
      }
      const error = node("div", draft?.error || "", "error");
      error.setAttribute("role", "alert");
      form.append(button, error);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!editable || button.disabled) return;
        const choiceId =
          form.querySelector('input[type="radio"]:checked')?.value ?? null;
        const choice = choices.find((item) => item.id === choiceId);
        const answer = textarea.value.trim() ? textarea.value : choice?.label;
        if (!answer) {
          error.textContent = text("question.answerRequired");
          return;
        }
        button.disabled = true;
        try {
          await api("update/answer", {
            id: question.id,
            answer,
            ...(contract
              ? {
                  expected_revision: contract.revision,
                  contract_fingerprint: contract.fingerprint,
                  choice_id: choiceId,
                }
              : {}),
          });
          await refreshState();
        } catch (e) {
          error.textContent = e.message;
          button.disabled = false;
          await refreshState();
        }
      });
      if (contract && editable) {
        const cancel = node("button", text("question.cancel"));
        cancel.type = "button";
        cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          try {
            await api("decision/cancel", {
              id: question.id,
              expected_revision: contract.revision,
              cancel_reason: text("question.humanCancelled"),
            });
            await refreshState();
          } catch (e) {
            error.textContent = e.message;
            cancel.disabled = false;
          }
        });
        form.append(cancel);
      }
      article.append(form, node("p", text("question.noAuthority"), "sub"));
      if (contract?.history.some((record) => record.answer)) {
        const history = node("details");
        history.append(node("summary", text("question.history")));
        for (const record of contract.history.filter((item) => item.answer))
          history.append(
            node(
              "p",
              text("question.historyAnswer", {
                revision: record.revision,
                answer: record.answer.text,
              }),
            ),
          );
        article.append(history);
      }
      return article;
    }),
  );
  if (!questions.length)
    container.append(node("p", text("question.empty"), "empty"));
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
}
