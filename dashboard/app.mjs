import { renderQuestionCards } from "./question-cards-ui.mjs";
import { renderAnswerApplications } from "./answer-applications-ui.mjs";
import { renderOverview } from "./project-overview.mjs";
import { renderConnectionDiagnostics } from "./connection-diagnostics-ui.mjs";
import { createInstructionPanel } from "./instruction-queue-ui.mjs";

const $ = (id) => document.getElementById(id);
const base = location.pathname.startsWith("/_rdsh") ? "/_rdsh/" : "/";
const suppliedBrowserToken =
  base === "/" ? new URLSearchParams(location.hash.slice(1)).get("key") : null;
const browserToken =
  base === "/"
    ? suppliedBrowserToken ||
      sessionStorage.getItem("rdsh_project_browser_token") ||
      ""
    : "";
if (browserToken) {
  sessionStorage.setItem("rdsh_project_browser_token", browserToken);
  if (suppliedBrowserToken !== null)
    history.replaceState(null, "", location.pathname + location.search);
}
async function api(route, body) {
  const headers = browserToken ? { "x-rdsh-browser-token": browserToken } : {};
  const response = await fetch(
    base + "api/" + route,
    body === undefined
      ? { headers }
      : {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "接続できません");
  return result;
}
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
const number = (value) =>
  value == null ? "未取得" : value.toLocaleString("ja-JP");
const money = (value) => (value == null ? "未取得" : "$" + value.toFixed(2));
const ratio = (numerator, denominator) =>
  numerator == null || denominator == null || denominator === 0
    ? null
    : numerator / denominator;
const percentage = (value) =>
  value == null ? "未取得" : (value * 100).toFixed(1) + "%";
function card(label, value, detail, progress, warning = false) {
  const element = node("section", undefined, "card");
  element.append(
    node("div", label, "label"),
    node("div", value, "value" + (warning ? " warn" : "")),
    node("div", detail, "detail"),
  );
  if (progress != null) {
    const bar = node("div", undefined, "bar");
    const fill = node("span");
    fill.style.width = Math.min(100, Math.max(0, progress * 100)) + "%";
    bar.append(fill);
    element.append(bar);
  }
  return element;
}
function emptyRow(text, columns) {
  const tr = node("tr");
  const cell = node("td", text, "empty");
  cell.colSpan = columns;
  tr.append(cell);
  return tr;
}
let renderedRevision = -1;
let latestState = null;
let selectedTask = "";
let selectionKey = "";
function navigateTo(id) {
  const target = $(id);
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement)
    if (parent.tagName === "DETAILS") parent.open = true;
  target.tabIndex = -1;
  target.focus();
  target.scrollIntoView({ block: "start" });
}
function updateOverview(state) {
  const select = $("overview-task");
  const options = [{ id: "", title: "プロジェクト全体" }, ...state.tasks];
  if (selectedTask && !state.tasks.some((task) => task.id === selectedTask))
    options.push({ id: selectedTask, title: "現在の一覧にありません" });
  const signature = JSON.stringify(
    options.map((task) => [task.id, task.title]),
  );
  if (select.dataset.options !== signature) {
    select.replaceChildren(
      ...options.map((task) => {
        const option = node(
          "option",
          `${task.id ? task.id + " · " : ""}${task.title}`,
        );
        option.value = task.id;
        return option;
      }),
    );
    select.dataset.options = signature;
  }
  select.value = selectedTask;
  const view = renderOverview($("project-overview"), state, selectedTask, node);
  $("quick-context").textContent = view.context;
  $("quick-context").title = view.context;
  $("quick-pending").textContent =
    `判断 ${view.pending.length}件${view.reviews.length ? ` · 追指示 ${view.reviews.length}件` : ""}`;
}
$("overview-task").addEventListener("change", (event) => {
  selectedTask = event.target.value;
  try {
    sessionStorage.setItem(selectionKey, selectedTask);
  } catch {}
  if (latestState) updateOverview(latestState);
});
$("tasks").addEventListener("click", (event) => {
  const link = event.target.closest("a[data-task-id]");
  if (!link) return;
  event.preventDefault();
  selectedTask = link.dataset.taskId;
  try {
    sessionStorage.setItem(selectionKey, selectedTask);
  } catch {}
  if (latestState) updateOverview(latestState);
  navigateTo("overview-heading");
});
$("overview-pending").addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link) return;
  event.preventDefault();
  navigateTo(decodeURIComponent(link.hash.slice(1)));
});
$("quick-overview").onclick = () => navigateTo("overview-heading");
$("quick-pending").onclick = () => {
  const view =
    latestState &&
    renderOverview($("project-overview"), latestState, selectedTask, node);
  if (view?.reviews.length && !view.pending.length) {
    renderInstructions.selectTarget(view.reviews[0].consumer_id);
    navigateTo("instruction-panel");
  } else navigateTo("pending-heading");
};
$("quick-details").onclick = () => navigateTo("metrics-heading");
$("quick-stop").onclick = () => navigateTo("overview-stop");
$("diagnostics-refresh").onclick = async () => {
  $("diagnostics-refresh").disabled = true;
  $("diagnostics-status").textContent = "接続の各段階を確認中…";
  try {
    const report = await api("diagnostics");
    renderConnectionDiagnostics($("diagnostics-result"), report, node);
    $("diagnostics-status").textContent =
      "診断を取得しました。各日時はその段階を観測した時点です。";
  } catch {
    $("diagnostics-status").textContent =
      "診断を取得できません。現在の接続は未確認です。最新のQRまたは rdsh-dashboard open から開き直してください。";
    $("diagnostics-result").replaceChildren();
  } finally {
    $("diagnostics-refresh").disabled = false;
  }
};
const renderInstructions = createInstructionPanel($("instruction-panel"), {
  node,
  api,
  refreshState,
});
function render(state) {
  if (state.revision < renderedRevision) return;
  renderedRevision = state.revision;
  latestState = state;
  renderInstructions(state);
  updateOverview(state);
  const m = state.metrics,
    done = state.tasks.filter((task) => task.status === "done").length,
    unanswered = state.questions.filter((question) => question.answer === null),
    pending = unanswered.filter(
      (question) =>
        !state.question_contracts?.cards[question.id] ||
        state.question_contracts.cards[question.id].status === "open",
    ),
    answered = state.questions.length - unanswered.length;
  const cache = ratio(m.cached_input_tokens, m.input_tokens),
    errors = ratio(m.tool_errors, m.tool_calls);
  const counts = ["done", "doing", "todo", "blocked"]
    .map(
      (status) =>
        `${status} ${state.tasks.filter((task) => task.status === status).length}`,
    )
    .join(" · ");
  $("cards").replaceChildren(
    card(
      "費用（API換算、累計）",
      money(m.total_cost_usd),
      m.total_budget_usd == null
        ? "上限 未設定"
        : "上限 " + money(m.total_budget_usd),
      ratio(m.total_cost_usd, m.total_budget_usd),
    ),
    card(
      "直近のセッション",
      money(m.session_cost_usd),
      `${m.session_id || "未取得"}　上限 ${m.session_budget_usd == null ? "未設定" : money(m.session_budget_usd)}`,
      ratio(m.session_cost_usd, m.session_budget_usd),
    ),
    card(
      "キャッシュ読み込み率",
      percentage(cache),
      `${number(m.model_calls)} 回の呼び出し（入力トークン加重）`,
    ),
    card(
      "ツールのエラー率",
      percentage(errors),
      `${number(m.tool_errors)} / ${number(m.tool_calls)} 件`,
    ),
    card(
      "文脈の読み落とし",
      number(m.context_misses),
      "報告元で検出した回数",
      undefined,
      m.context_misses > 0,
    ),
    card(
      "自動続行",
      number(m.auto_continues),
      `拒否 ${number(m.refusals)} · APIエラー ${number(m.api_errors)}`,
    ),
    card("タスク", `${done} / ${state.tasks.length}`, counts),
    card("未回答の質問", String(pending.length), `回答済み ${answered}`),
  );
  $("task-milestones").textContent = [
    ...new Set(state.tasks.map((task) => task.milestone).filter(Boolean)),
  ].join(" / ");
  $("tasks").replaceChildren(
    ...state.tasks.map((task) => {
      // #57: 端末を替えても同じ行へ戻れる安定アンカー。
      const tr = node("tr");
      tr.id = "task-" + task.id;
      const status = node("td");
      status.append(node("span", task.status, "status " + task.status));
      tr.append(
        node("td", task.id, "id"),
        status,
        node("td", task.title),
        node("td", task.blocker),
      );
      const taskLink = node("a", task.id);
      taskLink.href = "#task-" + encodeURIComponent(task.id);
      taskLink.dataset.taskId = task.id;
      tr.children[0].replaceChildren(taskLink);
      [...tr.children].forEach((cell, index) => {
        cell.dataset.label = ["ID", "状態", "題名", "ブロック要因"][index];
      });
      return tr;
    }),
  );
  if (!state.tasks.length)
    $("tasks").append(emptyRow("タスクはまだ登録されていません", 4));
  renderQuestionCards($("questions"), unanswered, state.question_contracts, {
    node,
    api,
    refreshState,
  });
  renderAnswerApplications($("reply-status"), state, node);
  $("events").replaceChildren(
    ...state.events
      .slice(-30)
      .reverse()
      .map((event) => {
        const element = node("article", undefined, "event");
        element.append(
          node("strong", event.title),
          node(
            "div",
            `${event.type} · ${new Date(event.created_at).toLocaleString("ja-JP")}`,
            "sub",
          ),
        );
        if (event.detail) element.append(node("p", event.detail));
        if (event.artifact) element.append(node("code", event.artifact));
        return element;
      }),
  );
  if (!state.events.length)
    $("events").append(
      node("div", "進捗・成果物の報告はまだありません", "empty"),
    );
  $("answers").replaceChildren(
    ...state.questions
      .filter((question) => question.answer !== null)
      .slice()
      .reverse()
      .map((question) => {
        const element = node("article", undefined, "event");
        element.append(
          node("strong", question.question),
          node("p", question.answer),
        );
        const contract = state.question_contracts?.cards[question.id];
        element.append(
          node(
            "p",
            contract
              ? `版 ${contract.revision} · ${contract.status === "answered" ? "回答を保存済み" : contract.status === "expired" ? "期限切れ · 回答は無効" : "取消し · 回答は無効"} · 実行権限は発行していません`
              : "相談への返答を保存済み · 実行権限は発行していません",
            "sub",
          ),
        );
        return element;
      }),
  );
  $("connection").textContent = "接続済み · プロジェクト専用";
  $("updated").textContent =
    `最終更新: ${state.updated_at ? new Date(state.updated_at).toLocaleString("ja-JP") : "まだ報告がありません"} · 未取得の指標はMCPから報告されたときに表示されます。費用は報告元のAPI換算値です。`;
}
async function refreshState() {
  try {
    render(await api("state"));
  } catch (e) {
    $("connection").textContent = e.message;
    $("overview-state").textContent = "画面の更新に失敗 · 対象の現在状態は不明";
  }
}
let qrObjectUrl = null;
async function renderShare(config) {
  const share = config.share;
  $("share-message").textContent = share.message;
  $("share-url").textContent = share.url || "";
  $("qr").hidden = !share.url;
  $("qr-placeholder").hidden = Boolean(share.url);
  $("qr-placeholder").textContent =
    share.state === "login_required"
      ? "Tailscaleへのログイン待ち"
      : "接続準備中";
  if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
  qrObjectUrl = null;
  if (share.url) {
    const response = await fetch(base + "api/qr.svg?updated=" + Date.now(), {
      headers: browserToken ? { "x-rdsh-browser-token": browserToken } : {},
    });
    if (!response.ok) throw new Error("QRコードを取得できません");
    qrObjectUrl = URL.createObjectURL(await response.blob());
    $("qr").src = qrObjectUrl;
  }
  $("consent").hidden = !share.consent_url;
  if (share.consent_url) $("consent").href = share.consent_url;
  $("mcp-info").textContent =
    config.kind === "project"
      ? `MCPのイベント購読: ${config.events?.active || 0} 件` +
        (config.events?.failures
          ? ` · 配信エラー ${config.events.failures} 件`
          : "") +
        (config.mcp_url
          ? ` · MCP接続先: ${config.mcp_url}`
          : " · 外部接続は設定待ち")
      : "";
}
$("share-toggle").addEventListener("click", () => {
  $("share").hidden = !$("share").hidden;
  $("share-toggle").setAttribute("aria-expanded", String(!$("share").hidden));
});
$("share-refresh").addEventListener("click", async () => {
  $("share-refresh").disabled = true;
  try {
    await api("share/refresh", {});
    await renderShare(await api("config"));
  } catch (e) {
    $("share-message").textContent = e.message;
  } finally {
    $("share-refresh").disabled = false;
  }
});
// #61: コマンドパレット。既存操作への別導線であり、権限・状態チェックや
// 確認は各操作側（回答フォームなど）で行い、ここで迂回しない。
// 入力欄での誤発動を避け、Esc・Ctrl/⌘+K・元フォーカス復帰だけを扱う。
const paletteCommands = [
  {
    id: "toggle-share",
    ja: "共有表示を切り替える",
    en: "Toggle phone view",
    keys: "共有 スマホ QR share phone",
    run: () => $("share-toggle").click(),
  },
  {
    id: "refresh-share",
    ja: "共有の接続を更新する",
    en: "Refresh share connection",
    keys: "更新 refresh",
    run: () => $("share-refresh").click(),
  },
  {
    id: "goto-pending",
    ja: "未回答の質問へ移動する",
    en: "Go to pending questions",
    keys: "質問 未回答 question pending",
    run: () => navigateTo("pending-heading"),
  },
  {
    id: "toggle-answered",
    ja: "回答済みの質問を開閉する",
    en: "Toggle answered questions",
    keys: "回答済み answered",
    run: () => {
      $("answered").open = !$("answered").open;
    },
  },
  {
    id: "back-to-top",
    ja: "先頭へ戻る",
    en: "Back to top",
    keys: "先頭 top",
    run: () => window.scrollTo({ top: 0 }),
  },
];
let paletteReturnFocus = null;
function renderPalette(filter = "") {
  const query = filter.trim().toLowerCase();
  const matched = paletteCommands.filter(
    (command) =>
      !query ||
      (command.ja + " " + command.en + " " + command.keys)
        .toLowerCase()
        .includes(query),
  );
  $("palette-list").replaceChildren(
    ...matched.map((command) => {
      const item = node("li");
      const button = node("button", command.ja + " · " + command.en);
      button.type = "button";
      button.addEventListener("click", () => {
        $("palette").close();
        command.run();
      });
      item.append(button);
      return item;
    }),
  );
  $("palette-count").textContent = matched.length
    ? matched.length + " 件"
    : "該当なし";
}
function openPalette() {
  paletteReturnFocus = document.activeElement;
  renderPalette("");
  $("palette-search").value = "";
  $("palette").showModal();
  $("palette-search").focus();
}
$("palette-toggle").addEventListener("click", openPalette);
$("palette-search").addEventListener("input", (event) =>
  renderPalette(event.target.value),
);
$("palette").addEventListener("close", () => {
  if (paletteReturnFocus?.focus) paletteReturnFocus.focus();
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    event.preventDefault();
    if ($("palette").open) $("palette").close();
    else openPalette();
  }
});
try {
  const config = await api("config");
  await renderShare(config);
  if (config.kind === "harness") {
    $("connection-detail").hidden = true;
    $("kind").textContent = "DEEPSEEK HARNESS";
    $("title").textContent = "Harnessを開く";
    $("location").textContent = "会話・ツール実行のWeb画面";
    $("project-content").hidden = true;
    $("harness").hidden = false;
    $("harness-open").href = config.harness_url;
    $("connection").textContent = "接続済み · Harness専用の入口";
    $("share").hidden = false;
    $("share-toggle").setAttribute("aria-expanded", "true");
    let stopRequested = false;
    let pendingStop = null;
    const refreshManaged = async () => {
      try {
        const value = await api("managed-process"),
          scope = value.scope;
        const labels = {
          running: "実行中",
          stopping: "停止要求中 · 子孫の終了を確認しています",
          exit_confirmed: "終了確認済み · 所有する子孫プロセスは0件",
          unverifiable: "終了確認不能 · 停止済みとは確認できません",
        };
        $("managed-status").textContent =
          labels[scope?.status] ?? "所有する実行はありません";
        $("managed-remaining").textContent = scope
          ? `残存プロセス ${scope.remaining_count ?? "未確認"} 件` +
            (scope.remaining_pids.length
              ? ` · PID ${scope.remaining_pids.join(", ")}`
              : "") +
            (scope.members_truncated ? " · 一覧は一部または未確認" : "") +
            (scope.confirmed && !scope.resources_released
              ? " · 管理用の資源解放は未確認"
              : "")
          : "";
        $("managed-run").textContent = value.run_id ?? "";
        const names = {
          input_interrupt: "入力中断",
          graceful: "協調終了",
          termination: "終了要求",
          kill: "期限後の強制終了",
          verification: "子孫の終了確認",
        };
        const results = {
          requested: "要求送信",
          unsupported: "非対応",
          running: "残存あり",
          exit_confirmed: "終了確認済み",
          unverifiable: "確認不能",
        };
        $("managed-stages").replaceChildren(
          ...value.stages.map((stage) =>
            node(
              "li",
              `${names[stage.stage]} · ${stage.phase === "request" ? "要求を記録" : results[stage.status]}`,
            ),
          ),
        );
        $("managed-stop").disabled =
          stopRequested || scope?.status !== "running";
        $("harness-open").hidden = scope?.status === "exit_confirmed";
      } catch {
        $("managed-status").textContent =
          "監視に接続できません · 終了は未確認です";
        $("managed-stop").disabled = true;
      }
    };
    $("managed-stop").onclick = async () => {
      try {
        const current = await api("managed-process");
        if (!current.run_id || current.scope?.status !== "running") {
          await refreshManaged();
          return;
        }
        pendingStop = {
          run_id: current.run_id,
          owner_id: current.scope.owner_id,
        };
        $("managed-stop-target").textContent =
          `run ${current.run_id} · owner ${current.scope.owner_id}`;
        $("managed-stop-impact").textContent =
          `このrunが所有する子孫プロセスを停止します。現在の残存 ${current.scope.remaining_count ?? "未確認"} 件（増減あり）。他のrun・外部プロセスは対象外です。停止後の作業結果は未確認です。`;
        $("managed-stop-error").textContent = "";
        $("managed-stop-confirm").disabled = false;
        $("managed-stop-dialog").showModal();
      } catch (error) {
        $("managed-status").textContent = error.message;
      }
    };
    $("managed-stop-cancel").onclick = () => $("managed-stop-dialog").close();
    $("managed-stop-dialog").addEventListener("close", () => {
      pendingStop = null;
      $("managed-stop").focus();
    });
    $("managed-stop-confirm").onclick = async () => {
      if (!pendingStop) return;
      const target = pendingStop;
      $("managed-stop-confirm").disabled = true;
      try {
        const current = await api("managed-process");
        if (
          current.run_id !== target.run_id ||
          current.scope?.owner_id !== target.owner_id ||
          current.scope.status !== "running"
        )
          throw new Error(
            "停止対象が変わりました。閉じて対象を確認し直してください",
          );
      } catch (error) {
        $("managed-stop-error").textContent = error.message;
        $("managed-stop-confirm").disabled = false;
        return;
      }
      $("managed-stop-dialog").close();
      stopRequested = true;
      $("managed-stop").disabled = true;
      $("managed-status").textContent =
        "停止要求中 · 子孫の終了を確認しています";
      try {
        await api("managed-stop", {});
      } catch (error) {
        $("managed-status").textContent = error.message;
      }
      await refreshManaged();
    };
    await refreshManaged();
    setInterval(refreshManaged, 500);
  } else {
    $("title").textContent = config.project.name;
    $("location").textContent = config.project.root;
    document.title = config.project.name + " · Project dashboard";
    selectionKey = "rdsh_overview_task_" + config.project.id;
    try {
      selectedTask = sessionStorage.getItem(selectionKey) || "";
    } catch {}
    if (location.hash.startsWith("#task-")) {
      try {
        selectedTask = decodeURIComponent(location.hash.slice(6));
        sessionStorage.setItem(selectionKey, selectedTask);
      } catch {}
    }
    $("quick-actions").hidden = false;
    await refreshState();
    const source = new EventSource(
      base + "api/live?key=" + encodeURIComponent(browserToken),
    );
    source.addEventListener("changed", refreshState);
    source.onerror = () => {
      $("connection").textContent = "再接続中…";
      $("overview-state").textContent = "再接続中 · 対象の現在状態は不明";
    };
    source.onopen = refreshState;
    // Expiration needs a clock update even when publishers send no SSE event.
    setInterval(refreshState, 5000);
  }
} catch (e) {
  $("connection").textContent = e.message;
}
