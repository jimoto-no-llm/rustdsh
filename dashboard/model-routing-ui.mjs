const tuple = (value) =>
  value
    ? `${value.provider} / ${value.model} / effort: ${value.effort ?? "未指定"}`
    : "未取得";
const sources = {
  explicit_operator_request: "明示指定",
  parent_request: "親から継承",
  environment: "環境変数",
  persisted_role: "保存したrole設定",
};
const reasons = {
  native_session_mismatch: "対象と異なるsessionへの呼出し",
  native_selection_unavailable: "呼出しのモデルを取得できません",
  native_effort_unavailable: "effortの実効値を取得できません",
  native_route_mismatch: "許可中のprovider・model・effortと不一致",
  route_authorization_expired: "モデル変更許可の期限切れ",
  request_changed_before_dispatch: "送信直前に要求値が変わりました",
  request_interrupted_before_dispatch: "送信前に中断されました",
};
export function renderModelRouting(container, runs, node) {
  const expandedHistory = new Set(
    Array.from(
      container.querySelectorAll("article[data-run-id] details[open]"),
      (details) => details.closest("article").dataset.runId,
    ),
  );
  container.replaceChildren();
  container.append(node("h2", "モデル呼出しの照合履歴"));
  container.append(
    node(
      "p",
      "DSHがadapterへ渡す直前の要求を記録します。provider側で稼働した実モデルや認証の成功は、この履歴では確認できません。",
      "sub",
    ),
  );
  if (!runs.length) {
    container.append(
      node("p", "このプロジェクトに、照合できるDSH runはありません。", "sub"),
    );
    return;
  }
  for (const run of runs) {
    const card = node("article", undefined, "summary-card");
    card.dataset.runId = run.run_id;
    card.append(node("h3", run.task_id || run.run_id));
    if (run.error) {
      card.append(
        node(
          "p",
          "履歴を取得できません。モデルと送信可否は未確認です。",
          "notice warn",
        ),
      );
      container.append(card);
      continue;
    }
    const call = run.latest_native_call;
    const status = !run.native_dispatch_required
      ? "起動時の設定照合のみ · 呼出し直前のガードは未設定"
      : !call
        ? "呼出し証拠は未取得 · 送信前のガードを要求しています"
        : call.phase === "blocked" ||
            (call.phase === "finished" && !call.dispatch_started)
          ? "ガードが送信を停止"
          : call.phase === "admitted"
            ? "要求を照合 · adapterへの送信結果は未確認"
            : call.outcome === "succeeded"
              ? "呼出し要求を照合 · adapterの完了を観測"
              : "呼出し要求を照合 · 完了結果は失敗または中断";
    card.append(node("p", status, "notice"));
    const facts = node("dl", undefined, "summary-facts");
    const rows = [
      ["要求", tuple(run.requested)],
      ["許可中の値", tuple(run.active_route)],
      [
        "指定元",
        `${sources[run.source] || "未取得"}${run.role ? ` · ${run.role}` : ""}`,
      ],
      ["起動設定", tuple(run.configuration)],
      ["呼出し要求", tuple(call?.selection)],
      ["観測時刻", call?.observed_at || "未取得"],
      ["検査件数", String(run.native_call_count)],
      ["停止理由", reasons[call?.reason] || "記録なし"],
    ];
    for (const [label, value] of rows)
      facts.append(node("dt", label), node("dd", value));
    card.append(facts);
    if (run.authorization)
      card.append(
        node(
          "p",
          `変更許可 ${run.authorization.id} · ${run.authorization.source} · ${tuple(run.authorization.from)} → ${tuple(run.authorization.to)} · ${run.authorization.expired ? "期限切れ" : `期限 ${run.authorization.expires_at}`}`,
          "sub",
        ),
      );
    if (run.change_history?.length) {
      const history = node("details");
      history.open = expandedHistory.has(run.run_id);
      history.append(
        node(
          "summary",
          `モデル変更の許可履歴（${run.change_history.length}件）`,
        ),
      );
      const list = node("ol");
      for (const change of run.change_history)
        list.append(
          node(
            "li",
            `${change.applied_at} · ${change.id} · ${change.source} · ${tuple(change.from)} → ${tuple(change.to)} · ${change.expired ? "期限切れ" : `期限 ${change.expires_at}`}`,
          ),
        );
      history.append(list);
      card.append(history);
    }
    card.append(
      node(
        "p",
        "履歴は観測時点の値です。以後の送信可否やガードの生存を保証しません。",
        "sub",
      ),
    );
    container.append(card);
  }
}
