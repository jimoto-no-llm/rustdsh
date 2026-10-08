const statuses = {
  within_budget: "予算内",
  warning: "soft到達：警告",
  blocked: "hard到達：新規受付停止",
  paused: "管理者が停止",
  unknown: "費用未確認：新規受付停止",
  period_closed: "対象期間外：新規受付停止",
  inactive: "制御終了",
};
const sources = {
  provider_usage: "provider usage",
  cli_report: "CLI報告",
  api_estimate: "API推定",
  invoice_actual: "請求額",
};
export function renderBudget(root, state, node) {
  const callsOpen = root.querySelector("#budget-call-history")?.open || false;
  const historyOpen =
    root.querySelector("#budget-decision-history")?.open || false;
  root.replaceChildren(node("h2", "予算と新規実行の制御"));
  root.append(
    node(
      "p",
      "予算制御を付けて起動したDSHのmodel callとjobが対象です。実行中のcallは続き、予約を超える課金や遅いusageで上限を超えることがあります。",
      "detail",
    ),
  );
  const book = state.budget_admission;
  if (!book?.policies.length) {
    root.append(
      node(
        "p",
        "予算制御は未設定。費用の表示だけでは実行を止めません。",
        "detail",
      ),
    );
    return;
  }
  const grid = node("div", undefined, "cards budget-grid");
  for (const p of book.policies) {
    const card = node("section", undefined, "card");
    card.append(
      node("h3", p.run_id ? `run ${p.run_id}` : "project全体"),
      node(
        "strong",
        statuses[p.status],
        ["blocked", "warning", "unknown"].includes(p.status) ? "warn" : "",
      ),
      node(
        "div",
        `${p.currency} ${p.effective ?? "未確認"} / ${p.hard_limit}`,
        "value",
      ),
      node(
        "p",
        `soft ${p.soft_limit} · hard ${p.hard_limit} · callごとの予約 ${p.call_reservation}`,
        "detail",
      ),
      node(
        "p",
        `報告済み ${p.spent ?? "未確認"} · 未確定の予約 ${p.reserved} · 実行中 ${p.executing} · usage待ち ${p.awaiting_usage}`,
        "detail",
      ),
      node(
        "p",
        p.next_call_fits
          ? "次のcallの予約はこの上限内に収まります。他のrun上限も受付時に確認します。"
          : "次のcallの予約を受け付けられません。上限・未確定費用・期間を確認してください。",
        "detail",
      ),
      node(
        "p",
        `${sources[p.source_kind]}を判定に使用。開始前の費用 ${p.baseline ?? "未確認"}：${p.baseline_basis}`,
        "detail",
      ),
      node("p", `${p.period_start} ～ ${p.period_end}`, "detail"),
    );
    if (p.overspend !== "0")
      card.append(
        node("p", `遅れて確認した超過額：${p.currency} ${p.overspend}`, "warn"),
      );
    grid.append(card);
  }
  root.append(grid);
  root.append(
    node(
      "p",
      "DSH 0.2.0-rc.2の登録済みフックを使う実行だけが制御対象です。通常起動・Codex・Claude・Kimiは表示のみ。model/providerを自動変更しません。上限変更・再開はローカル管理者のbudgetコマンドから行います。",
      "detail",
    ),
  );
  for (const job of book.jobs.slice(-20).reverse())
    root.append(
      node(
        "p",
        `${job.worker_id} · ${job.run_id} · ${job.enforcement === "guard_registered" ? "DSHフック登録済み" : job.enforcement === "stopped" ? "実行終了" : "フック未確認・新規許可なし"}`,
        "detail",
      ),
    );
  const history = node("details");
  const calls = node("details");
  calls.id = "budget-call-history";
  calls.open = callsOpen;
  history.id = "budget-decision-history";
  history.open = historyOpen;
  calls.append(
    node("summary", `callごとの予約と費用（${book.calls.length}件）`),
  );
  for (const call of book.calls.slice(-50).reverse()) {
    calls.append(
      node(
        "p",
        `${call.worker_id} · ${call.session_id || "補助call：session不明"} · ${call.provider} / ${call.model} · ${call.currency} ${call.amount === null ? `予約 ${call.reservation}（費用未確認）` : `報告額 ${call.amount}`} · ${call.finished_at === null ? "実行中または結果未取得" : "native終了記録あり"} · ${call.call_id}`,
        "detail",
      ),
    );
  }
  root.append(calls);
  history.append(
    node("summary", `受付と判断の履歴（${book.decisions.length}件）`),
  );
  for (const d of book.decisions.slice(-50).reverse()) {
    history.append(
      node(
        "p",
        `${d.recorded_at} · ${d.kind} · ${d.allowed === true ? "受付" : d.allowed === false ? "拒否" : "記録"} ${d.reason || ""} ${d.call_id || d.job_id || d.policy?.policy_id || ""}${d.kind === "usage" ? ` · ${d.currency} ${d.amount ?? "未確認"} · ${d.source_ref} · ${d.basis}` : ""}`,
        "detail",
      ),
    );
  }
  root.append(history);
}
