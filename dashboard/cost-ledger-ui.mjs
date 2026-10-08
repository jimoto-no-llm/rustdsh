const sources = {
  provider_usage: "provider usage",
  cli_report: "CLI報告",
  api_estimate: "API換算",
  invoice_actual: "請求実額の報告",
};
const certainty = {
  unknown: "未取得",
  reported: "報告値",
  estimated: "推定",
  confirmed: "報告元で確定",
};
const amount = (group) =>
  group.amount === null ? "未取得" : `${group.currency} ${group.amount}`;
function targetLabel(scope, id) {
  const target = scope.targets.find((target) => target.target_id === id);
  return target
    ? `${target.worker_id} · ${target.session_id}`
    : "プロジェクト請求（作業者へ未配賦）";
}
export function createCostPanel(container, node) {
  let latest,
    selected = "",
    reportLimit = 100;
  const select = node("select"),
    label = node("label", "費用の対象期間");
  select.id = "cost-scope";
  label.htmlFor = select.id;
  const content = node("div");
  container.append(label, select, content);
  select.onchange = () => {
    selected = select.value;
    reportLimit = 100;
    render(latest);
  };
  function render(state) {
    latest = state;
    const scopes = state.cost_ledger?.scopes || [];
    if (!scopes.length) {
      label.hidden = select.hidden = true;
      content.replaceChildren(
        node(
          "p",
          "費用の明細は未取得です。累計報告から作業者別の費用は推定できません。",
          "sub",
        ),
      );
      return;
    }
    label.hidden = select.hidden = false;
    if (!scopes.some((scope) => scope.scope_id === selected))
      selected = scopes[0].scope_id;
    const options = JSON.stringify(
      scopes.map((scope) => [
        scope.scope_id,
        scope.period_start,
        scope.period_end,
      ]),
    );
    if (select.dataset.options !== options) {
      select.replaceChildren(
        ...scopes.map((scope) => {
          const option = node(
            "option",
            `${scope.scope_id} · ${scope.period_start.slice(0, 10)}〜${scope.period_end.slice(0, 10)}`,
          );
          option.value = scope.scope_id;
          return option;
        }),
      );
      select.dataset.options = options;
    }
    select.value = selected;
    const scope = scopes.find((scope) => scope.scope_id === selected);
    const opened = new Set(
      [...content.querySelectorAll("details[open]")].map(
        (detail) => detail.dataset.costDetail,
      ),
    );
    content.replaceChildren(
      node(
        "p",
        `期間 ${scope.period_start} 以上、${scope.period_end} 未満 · 登録対象 ${scope.targets.length}件`,
        "sub",
      ),
      node(
        "p",
        scope.membership_complete
          ? "報告元が宣言した対象一覧で集計します。明細が欠けている対象は未取得です。"
          : "対象一覧の網羅性は未確認です。登録対象の報告が揃っても部分集計として扱います。",
        "sub",
      ),
      node(
        "p",
        "出所・通貨・期間ごとの値です。異なる出所や未配賦の請求を足し合わせず、請求との差額で換算値を補正しません。",
        "sub",
      ),
    );
    const grid = node("div", undefined, "cards cost-grid");
    for (const source of Object.keys(sources)) {
      const groups = scope.groups.filter(
        (group) => group.source_kind === source,
      );
      if (!groups.length) {
        const card = node("section", undefined, "card");
        card.append(
          node("div", sources[source], "label"),
          node("div", "未取得", "value"),
          node(
            "p",
            `登録対象 ${scope.targets.length}件の金額は未取得`,
            "detail",
          ),
        );
        grid.append(card);
      }
      for (const group of groups) {
        const card = node("section", undefined, "card");
        card.append(
          node(
            "div",
            sources[source] +
              (group.level === "project_invoice" ? " · 未配賦" : " · 作業者別"),
            "label",
          ),
          node("div", amount(group), "value"),
          node(
            "p",
            `${group.partial ? "部分集計" : group.level === "project_invoice" ? "期間全体の請求報告" : "宣言対象の報告が揃っています"} · ${certainty[group.certainty]}`,
            "detail",
          ),
          node(
            "p",
            group.level === "project_invoice"
              ? "プロジェクト全体の請求報告。作業者への配賦は未取得です。"
              : `金額取得 ${group.covered_targets.length}/${scope.targets.length}件`,
            "detail",
          ),
          node("p", "最終観測 " + group.observed_at, "detail"),
        );
        if (group.missing_targets.length)
          card.append(
            node(
              "p",
              "未取得: " +
                group.missing_targets
                  .map((id) => targetLabel(scope, id))
                  .join("、"),
              "detail",
            ),
          );
        grid.append(card);
      }
    }
    content.append(grid);
    const targets = node("details", undefined, "fold");
    targets.dataset.costDetail = "targets";
    targets.open = opened.has("targets");
    targets.append(node("summary", "集計する作業者・session"));
    for (const target of scope.targets)
      targets.append(
        node(
          "p",
          `${target.target_id} · ${target.worker_id} · session ${target.session_id} · run ${target.run_id || "未取得"} · provider ${target.provider || "未取得"} · model ${target.model || "未取得"}`,
        ),
      );
    const history = node("details", undefined, "fold");
    history.dataset.costDetail = "history";
    history.open = opened.has("history");
    history.append(
      node("summary", `明細と出所（${scope.reports.length}報告）`),
    );
    if (!scope.reports.length) history.append(node("p", "明細は未取得です。"));
    if (scope.reports.length > reportLimit)
      history.append(
        node(
          "p",
          `観測日時の新しい ${reportLimit}/${scope.reports.length}報告を表示中。集計は全明細を対象としています。`,
          "sub",
        ),
      );
    for (const report of scope.reports.slice(0, reportLimit)) {
      const row = node("article", undefined, "cost-entry");
      row.append(
        node(
          "h3",
          `${sources[report.source_kind]} · ${amount(report)}${report.amount === null ? "" : " · " + certainty[report.certainty]}`,
        ),
        node("p", targetLabel(scope, report.target_id)),
        node(
          "p",
          report.included
            ? "現在の集計対象"
            : "履歴のみ（重複報告または置き換え済みの累計）",
          "sub",
        ),
        node(
          "p",
          `観測 ${report.observed_at} · 受信 ${report.received_at}`,
          "sub",
        ),
        node(
          "p",
          `報告 ${report.event_id} · ${report.mode === "cumulative" ? "累計" : "独立明細"} #${report.sequence}`,
          "sub",
        ),
        node("p", `出所 ${report.source_ref}`),
        node("p", `根拠 ${report.basis}`),
        node(
          "p",
          `入力 ${report.tokens?.input ?? "未取得"} · キャッシュ入力 ${report.tokens?.cached_input ?? "未取得"} · 出力 ${report.tokens?.output ?? "未取得"}`,
          "sub",
        ),
      );
      history.append(row);
    }
    if (scope.reports.length > reportLimit) {
      const more = node("button", "次の100報告を表示");
      more.type = "button";
      more.onclick = () => {
        reportLimit += 100;
        render(latest);
      };
      history.append(more);
    }
    content.append(targets, history);
  }
  return render;
}
