const reviewLabels = {
  clear: "申告上指摘なし・対象版一致",
  findings: "申告上指摘あり",
  partial: "未確認あり",
  unavailable: "レビュー利用不可",
  stale: "対象変更後の古いレビュー",
  unknown: "現在版を照合できません",
};
const freshnessLabels = {
  current: "現在版と一致",
  stale: "再レビューが必要",
  unknown: "照合未確認",
};
const freshnessReasons = {
  task_changed_after_review: "タスクの更新後にレビューされていません",
  source_head_changed_after_review: "プロジェクトのHEADがレビュー後に変わりました",
  source_has_uncommitted_changes: "未commitの変更があるためレビューが古い状態です",
  task_not_found: "対象タスクを確認できません",
  current_target_unavailable: "現在の対象版を確認できません",
};
const readinessLabels = {
  caller_reported_clear_for_human_decision: "申告上指摘なし · 人による完了判断待ち",
  caller_reported_findings_for_human_decision: "申告上指摘あり · 人による確認待ち",
  unknown: "判断に使える状態を確認できません",
};

export function renderReviewEvidence(root, state, node) {
  const reports = state.review_evidence?.reports || [];
  if (!reports.length) {
    root.replaceChildren(
      node("p", "独立レビューの記録はありません。", "sub"),
    );
    return;
  }
  const note = node(
    "p",
    "これは別contextのread-only workerを割り当てた後、呼び出し側が提出した報告です。実際のreview実行や報告者の本人性、sandbox強制、正しさを証明しません。clearも人間の完了判断を置き換えません。",
    "sub",
  );
  const cards = reports.map((report) => {
    const card = node("article", undefined, "event");
    const task = state.tasks.find((item) => item.id === report.task_id);
    card.append(
      node(
        "strong",
        `${reviewLabels[report.review_status] || reviewLabels.unknown} · ${task?.title || report.task_id}`,
      ),
      node(
        "p",
        `task ${report.task_id} · implementer ${report.implementation_worker_id} · reviewer ${report.reviewer_worker_id} · ${freshnessLabels[report.freshness] || freshnessLabels.unknown}`,
      ),
      node(
        "p",
        `head ${report.target.head_sha} · diff SHA-256 ${report.target.diff_sha256} · report SHA-256 ${report.report_digest}`,
        "sub",
      ),
    );
    if (report.freshness_reason)
      card.append(
        node(
          "p",
          freshnessReasons[report.freshness_reason] || report.freshness_reason,
          "sub",
        ),
      );
    if (report.findings.length) {
      const heading = node("strong", "指摘");
      const list = node("ul");
      for (const finding of report.findings) {
        const location = finding.path
          ? `${finding.path}${finding.line ? `:${finding.line}` : ""} · `
          : "";
        list.append(
          node(
            "li",
            `[${finding.severity}] ${location}${finding.title}: ${finding.detail}`,
          ),
        );
      }
      card.append(heading, list);
    }
    if (report.unverified.length) {
      card.append(node("strong", "未確認"));
      const list = node("ul");
      for (const item of report.unverified) list.append(node("li", item));
      card.append(list);
    }
    if (report.evidence_refs.length) {
      card.append(node("strong", "参照証拠"));
      const list = node("ul");
      for (const item of report.evidence_refs)
        list.append(node("li", `${item.label} · ${item.reference}`));
      card.append(list);
    }
    card.append(
      node(
        "p",
        `report ${report.review_id} · ${report.created_at} · ${readinessLabels[report.completion_readiness] || readinessLabels.unknown}`,
        "sub",
      ),
    );
    return card;
  });
  root.replaceChildren(note, ...cards);
}
