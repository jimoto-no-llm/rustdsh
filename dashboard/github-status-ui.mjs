const statusLabels = {
  unavailable: "ローカルGit情報を取得できません",
  push_not_confirmed: "最後のpushを確認できません",
  remote_unavailable: "追跡先のSHAを取得できません",
  local_changes_unpushed: "未commitのローカル変更があります",
  github_unavailable: "GitHubの状態を取得できません",
  pr_unavailable: "このブランチのPRを確認できません",
  pr_head_stale: "PR headが最後のpushと一致しません",
  target_changed_during_observation: "取得中にHEADまたは追跡先が変わりました。再取得してください",
  checks_unavailable: "必須checkの全件を確認できません",
  ci_failed: "必須CIに失敗があります",
  ci_pending: "必須CIが未完了です",
  pr_closed: "PRは開いていません",
  pr_draft: "Draft PRです",
  review_changes_requested: "レビューの修正依頼が残っています",
  review_required: "必要なレビューが未完了です",
  review_unconfirmed: "レビュー状態を確認できません",
  merge_blocked: "GitHub上のマージ条件を満たしていません",
  merge_ready: "GitHubが最新headをマージ可能と判断しました",
};

const reviewLabels = {
  APPROVED: "承認済み",
  CHANGES_REQUESTED: "修正依頼あり",
  REVIEW_REQUIRED: "レビュー待ち",
};

const checkLabels = {
  QUEUED: "待機中",
  REQUESTED: "待機中",
  WAITING: "承認・開始待ち",
  IN_PROGRESS: "実行中",
  COMPLETED: "完了",
  SUCCESS: "成功",
  FAILURE: "失敗",
  ERROR: "エラー",
  TIMED_OUT: "タイムアウト",
  CANCELLED: "キャンセル",
  ACTION_REQUIRED: "実行承認待ち",
  NEUTRAL: "中立終了",
  SKIPPED: "スキップ",
  STALE: "古い結果",
  PENDING: "待機中",
  UNKNOWN: "未確認",
};

function dateLabel(value) {
  if (!value) return "未取得";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "未取得"
    : date.toLocaleString("ja-JP");
}

function shaLabel(value) {
  return value || "未確認";
}

function addSha(container, label, value, node) {
  container.append(node("dt", label), node("dd", shaLabel(value)));
}

function safeLink(url, label, node) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return node("span", label);
    const link = node("a", label);
    link.href = parsed.href;
    link.target = "_blank";
    link.rel = "noreferrer";
    return link;
  } catch {
    return node("span", label);
  }
}

export function renderGitHubStatus(container, report, node) {
  container.replaceChildren();
  const label = statusLabels[report.status] || statusLabels.unavailable;
  container.append(
    node(
      "p",
      `判定: ${label} · 確認: ${dateLabel(report.checked_at || report.observed_at)}`,
      report.status === "merge_ready" ? "notice" : "sub",
    ),
  );

  const summary = node("dl", undefined, "github-status-summary");
  addSha(summary, "ローカルHEAD", report.local_sha, node);
  summary.append(
    node("dt", "ブランチ"),
    node("dd", report.branch || "detached / 未取得"),
    node("dt", "作業ツリー"),
    node("dd", report.dirty === true ? "未commit変更あり" : report.dirty === false ? "clean" : "未確認"),
    node("dt", "追跡先SHA"),
    node("dd", report.remote_sha || "未確認"),
  );
  if (report.pr) {
    summary.append(
      node("dt", "PR head SHA"),
      node("dd", report.pr.head_sha || "未確認"),
      node("dt", "PRレビュー"),
      node("dd", reviewLabels[report.pr.review_decision] || "未確認"),
      node("dt", "GitHubのmerge state"),
      node("dd", report.pr.merge_state || "未確認"),
    );
    const prRow = node("dd");
    prRow.append(safeLink(report.pr.url, `#${report.pr.number} · ${report.pr.state}`, node));
    summary.append(node("dt", "Pull request"), prRow);
  } else {
    summary.append(node("dt", "Pull request"), node("dd", "未取得"));
  }
  summary.append(
    node(
      "dt",
      `必須check ${report.required_check_count ?? 0}件 / 取得check ${report.checks?.length ?? 0}件`,
    ),
    node(
      "dd",
      report.checks_available
        ? report.checks_truncated
          ? "一部のみ取得 · merge-ready判定には使用しません"
          : "required判定をGitHubから取得済み"
        : "required判定を取得できません · 成功扱いしません",
    ),
  );
  container.append(summary);

  if (!report.checks?.length) {
    container.append(node("p", "check結果はありません。", "sub"));
    return;
  }
  const heading = node("h3", "head SHAに結び付いたcheck");
  const note = node(
    "p",
    "pushとpull_requestの起動はイベント別に表示します。同名checkの重複もまとめずに残します。",
    "sub",
  );
  const list = node("ul", undefined, "github-status-checks");
  for (const check of report.checks) {
    const row = node("li");
    const requirement =
      check.required === true
        ? "必須"
        : check.required === false
          ? "任意"
          : "必須判定なし";
    const state = check.conclusion || check.status || "UNKNOWN";
    const event = check.event || "外部status / event不明";
    const detail = node(
      "span",
      `${check.name} · ${requirement} · ${event} · ${checkLabels[state] || state}`,
    );
    row.append(detail);
    if (check.url) row.append(document.createTextNode(" · "), safeLink(check.url, "詳細", node));
    row.append(
      node(
        "small",
        ` · 更新: ${dateLabel(check.completed_at || check.started_at)}`,
        "sub",
      ),
    );
    list.append(row);
  }
  container.append(heading, note, list);
}
