const labels = {
  instruction: "指示",
  receipt: "受領",
  execution: "入力実行",
  test: "試験",
  question: "質問",
  answer: "回答",
  application: "回答適用",
};
const states = {
  unknown: "未確認",
  unverified: "未検証",
  uncorrelated: "相関なし",
  reported: "報告のみ",
  recorded: "記録あり",
  accepted: "保存済み",
  saved: "保存済み",
  current: "現行revision",
  invalidated: "旧revision",
  succeeded: "ACP入力結果あり",
  failed: "ACP入力失敗",
  current_full_pass: "現行の全体試験成功",
  recorded_revision: "回答時の質問revision",
  open: "質問あり",
  answered: "回答済み",
  review_required: "投稿候補の確認待ち",
  rejected: "投稿見送り",
};
const bases = {
  exact_input_command_id: "同じ入力command ID",
  exact_question_revision_and_feedback: "同じ質問revision・回答ID",
  exact_answer_event_id: "保存済み回答event ID",
  verified_native_owner_session_input_hash:
    "native owner・session・入力hashの照合済み",
};
const stageText = (trace) =>
  trace.stages
    .map(
      (stage) =>
        `${labels[stage.stage]} ${stage.count ? stage.count + "記録" : "未確認"}` +
        (stage.unknown ? `（${stage.unknown}未確認）` : ""),
    )
    .join(" · ");
export function createTimelinePanel(element, { api, node }) {
  element.style.overflowWrap = "anywhere";
  let after = 0,
    loading = false,
    signature = "",
    selected = null,
    detailSequence = 0;
  let views = new Map();
  const message = node("p", "相関記録を確認中…", "sub");
  const body = node("div");
  element.replaceChildren(message, body);
  const button = (text, action) => {
    const result = node("button", text);
    result.type = "button";
    result.addEventListener("click", action);
    return result;
  };
  const updateSummary = (trace, view) => {
    view.title.textContent = trace.title;
    view.context.textContent = trace.context
      ? `run ${trace.context.run_id} · session ${trace.context.session_id}`
      : "";
    view.counts.textContent = stageText(trace);
    view.problems.textContent = `未確認・問題 ${trace.issues.length}件`;
    view.open.hidden = !trace.issues.length;
  };
  async function detail(traceId, view) {
    selected = traceId;
    const target = view.target,
      sequence = ++detailSequence,
      expanded = new Set(
        [...target.querySelectorAll("details[open]")].map(
          (details) => details.dataset.timelineRaw,
        ),
      );
    if (!target.childElementCount)
      target.replaceChildren(node("p", "原記録を確認中…", "sub"));
    try {
      const report = await api(
        "timeline?trace_id=" + encodeURIComponent(traceId),
      );
      if (
        selected !== traceId ||
        sequence !== detailSequence ||
        !target.isConnected
      )
        return;
      const trace = report.traces[0];
      updateSummary(trace, view);
      target.dataset.timelineRevision = String(report.state_revision);
      target.replaceChildren(node("p", report.notice, "sub"));
      const problems = node("ul");
      for (const issue of trace.issues)
        problems.append(node("li", issue.message));
      target.append(problems);
      target.append(node("h4", "確認できたID相関"));
      const correlations = node("ul");
      for (const link of trace.links) {
        const from = trace.nodes.find((item) => item.id === link.from),
          to = trace.nodes.find((item) => item.id === link.to);
        if (!from || !to) continue;
        correlations.append(
          node(
            "li",
            `${labels[from.stage]} ${JSON.stringify(from.source_id)} → ${labels[to.stage]} ${JSON.stringify(to.source_id)}（${bases[link.basis] || link.basis}）`,
          ),
        );
      }
      target.append(correlations);
      if (!trace.links.length)
        target.append(node("p", "IDで照合できた相関はまだありません。", "sub"));
      for (const [stage, label] of Object.entries(labels)) {
        const items = trace.nodes.filter((item) => item.stage === stage);
        target.append(node("h4", label));
        if (!items.length)
          target.append(node("p", "この区間の相関記録なし", "sub"));
        for (const item of items) {
          const article = node("article", undefined, "summary-card");
          article.dataset.timelineNode = item.id;
          article.append(
            node("strong", states[item.status] || item.status),
            node("p", "ID: " + JSON.stringify(item.source_id), "sub"),
          );
          if (item.at) article.append(node("p", "記録時刻: " + item.at, "sub"));
          if (item.note) article.append(node("p", item.note, "sub"));
          const raw = node("details"),
            text = node("pre", JSON.stringify(item.raw, null, 2));
          raw.dataset.timelineRaw = item.id;
          raw.open = expanded.has(item.id);
          text.style.whiteSpace = "pre-wrap";
          text.style.overflowWrap = "anywhere";
          raw.append(node("summary", "原記録を開く"), text);
          article.append(raw);
          target.append(article);
        }
      }
      const links = node("details");
      links.dataset.timelineRaw = "links";
      links.open = expanded.has("links");
      links.append(node("summary", "相関IDの原記録を開く"));
      const text = node("pre", JSON.stringify(trace.links, null, 2));
      text.style.whiteSpace = "pre-wrap";
      text.style.overflowWrap = "anywhere";
      links.append(text);
      target.append(links);
    } catch {
      if (
        selected !== traceId ||
        sequence !== detailSequence ||
        !target.isConnected
      )
        return;
      target.replaceChildren(
        node(
          "p",
          "原記録を取得できません。未知の区間は補っていません。",
          "warn",
        ),
      );
    }
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      const report = await api("timeline?after=" + after + "&limit=10");
      const nextSignature = JSON.stringify([
        after,
        report.state_revision,
        report.history_revision,
        report.traces,
      ]);
      message.textContent = report.notice;
      if (nextSignature === signature) return;
      signature = nextSignature;
      if (!report.total) {
        body.replaceChildren(node("p", "相関記録はまだありません。", "sub"));
        views.clear();
        return;
      }
      const pagination = node("p");
      const previous = button("前の10件", () => {
        after = Math.max(0, after - 10);
        selected = null;
        void refresh();
      });
      previous.disabled = after === 0;
      const next = button("次の10件", () => {
        after = report.next;
        selected = null;
        void refresh();
      });
      next.disabled = report.next === null;
      pagination.append(
        previous,
        node(
          "span",
          ` ${after + 1}–${after + report.traces.length} / ${report.total} `,
        ),
        next,
      );
      const cards = [],
        nextViews = new Map();
      for (const trace of report.traces) {
        let view = views.get(trace.trace_id);
        if (!view) {
          view = {
            article: node("article", undefined, "summary-card"),
            title: node("h3"),
            context: node("p", "", "sub"),
            counts: node("p"),
            problems: node("p", "", "sub"),
            target: node("div"),
          };
          view.article.dataset.timelineTrace = trace.trace_id;
          view.counts.dataset.timelineCounts = "";
          view.open = button("未確認区間と原記録を調べる", () => {
            void detail(trace.trace_id, view);
          });
          view.article.append(
            view.title,
            view.context,
            view.counts,
            view.problems,
            view.open,
            view.target,
          );
        }
        updateSummary(trace, view);
        nextViews.set(trace.trace_id, view);
        cards.push(view.article);
      }
      views = nextViews;
      body.replaceChildren(pagination, ...cards);
      if (selected && views.has(selected))
        void detail(selected, views.get(selected));
    } catch {
      message.textContent =
        "相関記録を取得できません。受信だけで実行成功と扱っていません。";
    } finally {
      loading = false;
    }
  }
  return { refresh };
}
