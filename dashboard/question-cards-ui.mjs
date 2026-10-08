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
          reviewed: form.dataset.reviewedFingerprint,
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
      const changedDraft = Boolean(
        draft?.fingerprint && draft.fingerprint !== contract?.fingerprint,
      );
      const reviewRequired =
        changedDraft && draft?.reviewed !== contract.fingerprint;
      const article = node("article", undefined, "decision-card");
      article.id = "question-" + question.id;
      const heading = node("div", undefined, "decision-heading");
      heading.append(
        node(
          "span",
          decision?.kind === "approval" ? "承認依頼" : "相談",
          "kind" + (decision?.kind === "approval" ? " kind-approval" : ""),
        ),
        node("span", `${question.id} · ${question.urgency}`, "sub"),
      );
      article.append(heading, node("h3", question.question));
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
      if (question.default_action)
        article.append(
          node(
            "p",
            `参考の行動: ${question.default_action}（自動実行しません）`,
            "sub",
          ),
        );
      const form = node("form");
      form.dataset.id = question.id;
      form.dataset.draftFingerprint =
        draft?.fingerprint || contract?.fingerprint || "";
      form.dataset.reviewedFingerprint = draft?.reviewed || "";
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
      textarea.setAttribute("aria-label", `質問 ${question.id} への回答`);
      textarea.required = choices.length === 0;
      textarea.maxLength = 8000;
      textarea.disabled = !editable;
      textarea.value = draft?.text || "";
      form.append(textarea);
      const button = node("button", "回答を返す", "primary");
      button.type = "submit";
      button.disabled = !editable || reviewRequired;
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
        review.disabled = !editable;
        review.addEventListener("change", () => {
          form.dataset.reviewedFingerprint = review.checked
            ? contract.fingerprint
            : "";
          button.disabled = !editable || !review.checked;
        });
        label.append(review, node("span", "更新後の対象と条件を確認した"));
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
          error.textContent = "選択肢を選ぶか、回答を入力してください。";
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
        const cancel = node("button", "この質問を取消す");
        cancel.type = "button";
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
        form.append(cancel);
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
}
