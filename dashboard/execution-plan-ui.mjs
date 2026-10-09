const reasons = {
  unknown_task: "登録されていないタスク",
  unknown_dependency: "待機先が計画にない",
  unknown_parent: "分岐元が計画にない",
  dependency_cycle: "依存関係が循環している",
  branch_cycle: "分岐元が循環している",
  branch_depth_limit: "分岐の深さが上限を超えている",
  native_depth_limit: "実際の分岐の深さが上限を超えている",
  plan_graph_invalid: "計画に未解決の依存関係がある",
  prerequisite_unverified: "完了報告と現在のコードの全件チェックを待っている",
  plan_not_enabled: "計画の開始制御が未設定",
  plan_expired: "計画の期限に到達した",
  operator_stopped: "新しい子タスクの受付を停止済み",
  child_failed_or_unconfirmed: "子タスクが失敗、取消し、または結果不明",
  concurrency_limit: "同時実行数の上限に到達した",
  total_start_limit: "総開始数の上限に到達した",
  task_claim_held: "開始権を保持中。二重に開始できない",
  already_started: "このタスクは開始済み",
  branch_parent_unavailable: "分岐元の実行を待っている",
};
const states = {
  waiting: "待機中",
  runnable: "実行候補",
  reserved: "開始権を予約中",
  running: "実行中",
  unknown: "起動結果不明・開始権を保持",
  finished: "実行終了・受け入れ確認は別",
  verified: "現在のコードの全件チェック済み",
};
export function createPlanPanel(root, api, node) {
  let pending = null,
    signature = "";
  const openPlans = new Map(),
    pages = new Map();
  const render = (value) => {
    for (const details of root.querySelectorAll("details[data-plan-id]"))
      openPlans.set(details.dataset.planId, details.open);
    root.replaceChildren(node("h2", "依存関係と実行計画"));
    root.append(
      node(
        "p",
        "開始制御を付けたWorkflowの計画です。依存先の完了報告と、現在のコードに対する全件チェックが揃ってから後続を受け付けます。実行候補も起動直前に再確認します。",
        "detail",
      ),
    );
    if (!value.plans.length) {
      root.append(
        node(
          "p",
          "実行計画は未設定です。CLIの plan define / enforce で、既存のrunに上限付きの計画を接続できます。",
          "detail",
        ),
      );
      return;
    }
    for (const p of value.plans) {
      const card = node("article", undefined, "card"),
        title = node("h3", p.plan_id);
      card.append(
        title,
        node("p", `run ${p.run_id}`, "sub"),
        node(
          "p",
          `実行中・予約・不明 ${p.active_claims} / ${p.limits.max_concurrent} · 分岐深さ ${p.limits.max_depth} · 開始 ${p.starts} / ${p.limits.max_starts}`,
          "detail",
        ),
        node(
          "p",
          `受付期限 ${new Date(p.limits.stop_at).toLocaleString("ja-JP")} · 子の失敗で停止 ${p.limits.stop_on_failure ? "あり" : "なし"}`,
          "detail",
        ),
      );
      card.append(
        node(
          "p",
          p.stop_reason
            ? reasons[p.stop_reason] || p.stop_reason
            : "開始制御を設定済み。CLIの稼働状態はsession台帳で確認してください。",
          p.stop_reason ? "warn" : "detail",
        ),
      );
      if (p.enabled && !p.stop_reason) {
        const stop = node("button", "新しい子タスクの受付を停止する");
        stop.type = "button";
        stop.onclick = async () => {
          stop.disabled = true;
          try {
            const result = await api("plans/stop", { plan_id: p.plan_id });
            signature = JSON.stringify(result);
            render(result);
          } catch (error) {
            card.append(
              node("p", "停止の保存を確認できません: " + error.message, "warn"),
            );
            stop.disabled = false;
          }
        };
        card.append(stop);
      }
      const summary = node(
        "p",
        `実行候補 ${p.nodes.filter((n) => n.state === "runnable").length}件 · 待機 ${p.nodes.filter((n) => n.state === "waiting").length}件 · 全 ${p.nodes.length}件`,
      );
      card.append(summary);
      const details = node("details", undefined, "fold");
      details.dataset.planId = p.plan_id;
      details.open = openPlans.get(p.plan_id) || false;
      details.append(
        node("summary", `依存関係を開く（${p.nodes.length}件・50件ずつ表示）`),
      );
      const graph = node("div");
      let drawnOpen = false;
      details.append(graph);
      const nodeId = (id) =>
        "plan-" + encodeURIComponent(p.plan_id) + "-" + encodeURIComponent(id);
      const focus = (id) => {
        const index = p.nodes.findIndex((n) => n.task_id === id);
        if (index < 0) {
          summary.textContent = `待機先 ${id} は計画にありません。計画を修正して新しいIDで定義してください。`;
          summary.tabIndex = -1;
          summary.focus();
          return;
        }
        pages.set(p.plan_id, Math.floor(index / 50));
        details.open = true;
        draw();
        const target = root.ownerDocument.getElementById(nodeId(id));
        target?.focus();
        target?.scrollIntoView({ block: "nearest" });
      };
      const blockerButton = (b) => {
        const label = reasons[b.code] || b.code,
          button = node(
            "button",
            `${label}${b.related_task_id ? " → " + b.related_task_id : ""}`,
          );
        button.type = "button";
        button.onclick = () => focus(b.related_task_id || b.task_id);
        return button;
      };
      const blockers = [
        ...p.preflight,
        ...p.nodes.flatMap((n) =>
          n.blockers.filter((b) => b.code === "prerequisite_unverified"),
        ),
      ];
      if (blockers.length) {
        const list = node("ul");
        for (const b of blockers.slice(0, 8)) {
          const li = node("li");
          li.append(node("span", b.task_id + ": "), blockerButton(b));
          list.append(li);
        }
        card.append(list);
        if (blockers.length > 8)
          card.append(
            node(
              "p",
              `他 ${blockers.length - 8}件は依存関係を開くと確認できます。`,
              "detail",
            ),
          );
      }
      const draw = () => {
        drawnOpen = details.open;
        if (!details.open) {
          graph.replaceChildren();
          return;
        }
        const page = Math.min(
          pages.get(p.plan_id) || 0,
          Math.floor((p.nodes.length - 1) / 50),
        );
        pages.set(p.plan_id, page);
        graph.replaceChildren();
        const nav = node("div"),
          previous = node("button", "前の50件"),
          next = node("button", "次の50件");
        previous.type = next.type = "button";
        previous.disabled = page === 0;
        next.disabled = (page + 1) * 50 >= p.nodes.length;
        previous.onclick = () => {
          pages.set(p.plan_id, page - 1);
          draw();
        };
        next.onclick = () => {
          pages.set(p.plan_id, page + 1);
          draw();
        };
        nav.append(
          previous,
          node(
            "span",
            ` ${page * 50 + 1}–${Math.min(p.nodes.length, (page + 1) * 50)} / ${p.nodes.length} `,
          ),
          next,
        );
        graph.append(nav);
        for (const n of p.nodes.slice(page * 50, (page + 1) * 50)) {
          const row = node("article", undefined, "event");
          row.id = nodeId(n.task_id);
          row.tabIndex = -1;
          row.append(
            node("strong", n.task_id + " · " + states[n.state]),
            node(
              "p",
              n.depends_on.length
                ? "待機先: " + n.depends_on.join(", ")
                : "待機先なし",
              "detail",
            ),
          );
          if (n.parent_task_id)
            row.append(node("p", "分岐元: " + n.parent_task_id, "detail"));
          if (n.child_session_id)
            row.append(node("p", "子session: " + n.child_session_id, "sub"));
          for (const b of n.blockers) row.append(blockerButton(b));
          graph.append(row);
        }
      };
      details.addEventListener("toggle", () => {
        openPlans.set(p.plan_id, details.open);
        if (drawnOpen !== details.open) draw();
      });
      card.append(details);
      root.append(card);
      draw();
    }
  };
  return () =>
    (pending ||= (async () => {
      try {
        const value = await api("plans"),
          next = JSON.stringify(value);
        if (signature !== next) {
          signature = next;
          render(value);
        }
      } catch (error) {
        signature = "";
        root.replaceChildren(
          node("h2", "依存関係と実行計画"),
          node("p", "計画の現在状態を確認できません: " + error.message, "warn"),
        );
      } finally {
        pending = null;
      }
    })());
}
