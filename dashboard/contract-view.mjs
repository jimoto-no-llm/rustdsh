function approvalScope(request, node) {
  const element = node("div");
  for (const [label, value] of [
    ["task / 契約版", `${request.task_id} / v${request.contract_version}`],
    ["run / command", `${request.run_id} / ${request.command_id}`],
    ["worker role", request.worker_role || "review"],
    ["操作", request.attributes.tool],
    ["対象", request.attributes.path || request.attributes.executable || request.attributes.origin],
    ["データhash", request.operation_digest],
    ["上限", `$${request.limits.max_cost_usd} / ${request.limits.max_attempts} attempts`],
    ["期限", request.expires_at], ["元要求", request.source_ref],
    ["予約済み", `${request.uses.length} attempts / $${request.reserved_cost_microusd / 1000000}`],
  ]) element.append(node("p", `${label}: ${value}`));
  for (const decision of request.decisions || [])
    element.append(node("p", `判断: ${decision.decision} / ${decision.approver} / ${decision.authenticated_by} / ${decision.decided_at}`));
  for (const use of request.uses)
    element.append(node("p", `実行: attempt ${use.attempt} / $${use.reserved_cost_microusd / 1000000} / ${use.execution} / ${use.started_at || use.claimed_at} / ${use.finished_at || "完了時刻なし"}`));
  return element;
}

export function renderTaskContract(task, state, node) {
  const versions = state.contracts?.find((item) => item.task_id === task.id)?.versions || [];
  const current = versions.at(-1);
  const details = node("details");
  details.append(node("summary", current ? `タスク契約 v${current.version}` : "タスク契約 未設定"));
  if (current) {
    for (const contract of versions.slice().reverse()) {
      details.append(node("strong", `v${contract.version} ・ ${contract.changed_at}`));
      for (const [label, value] of [
        ["目的", contract.purpose],
        ["対象repo", contract.repository],
        ["許可範囲", contract.allowed_scope],
        ["worker role", (contract.worker_roles || ["review"]).join(", ")],
        ["書込先", contract.write_roots.join("\n") || "書込不可"],
        ["読取先", contract.operation_policy?.read_roots.join("\n") || "構造policyでは未許可"],
        ["実行file", contract.operation_policy?.executables.map((rule) => `${rule.file} (${rule.argument_count}引数・hash照合)`).join("\n") || "未許可"],
        ["network origin", contract.operation_policy?.network_origins.join("\n") || "未許可"],
        ["禁止事項", contract.forbidden_actions.join("\n") || "記載なし"],
        ["終了条件", contract.completion_conditions.join("\n")],
        ["変更理由", contract.change_reason],
      ]) details.append(node("p", `${label}: ${value}`));
    }
    details.append(node("p", "契約変更後は承認の再照合が必要です。質問への回答は契約を変更しません。"));
  }
  return details;
}

export function renderOperations(state, checks, approvals, { node, api, refreshState }) {
  checks.replaceChildren(
    node("p", "構造policyは事前照合です。実行は人間承認後、Linux x64 の実測sandboxを通る操作だけ許可します。直接DSHツールと未対応環境は保留です。", "notice"),
    ...(state.policy_checks || []).slice(-10).reverse().map((check) => {
      const element = node("article", undefined, "event");
      element.append(node("strong", `${check.id}: ${check.decision}`),
        node("p", `${check.reason} ・ 実行: ${check.execution}`));
      return element;
    }),
  );
  approvals.replaceChildren(
    node("p", "承認はworker role・run・command・対象・データhash・上限・期限・要求版に固定されます。開始記録を永続化してからsandbox実行し、失敗や結果不明のattemptは再利用できません。", "notice"),
    ...(state.approval_requests || []).map((history) => {
      const request = history.versions.at(-1);
      const element = node("article", undefined, "event");
      element.append(node("strong", `${history.id} v${request.version}: ${request.status}`));
      element.append(approvalScope(request, node));
      const past = history.versions.slice(0, -1).reverse();
      if (past.length) {
        const audit = node("details");
        audit.append(node("summary", `過去の要求（${past.length}版）`));
        for (const previous of past) {
          audit.append(node("strong", `v${previous.version}: ${previous.status}（現在の操作には適用不可）`), approvalScope(previous, node));
        }
        element.append(audit);
      }
      const error = node("div", undefined, "error");
      error.setAttribute("role", "alert");
      const choices = request.status === "pending" ? [["grant", "この操作範囲を承認"], ["reject", "拒否"]]
        : request.status === "granted" ? [["revoke", "承認を取り消す"]] : [];
      for (const [decision, label] of choices) {
        const button = node("button", label);
        button.type = "button";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await api("approvals/decide", { id: history.id, request_version: request.version, decision });
            await refreshState();
          } catch (e) { error.textContent = e.message; button.disabled = false; }
        });
        element.append(button);
      }
      element.append(error);
      return element;
    }),
  );
}
