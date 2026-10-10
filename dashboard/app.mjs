import { renderReports } from "./reports-view.mjs";
import { renderQuestionCards } from "./question-cards-ui.mjs";
import { createQuestionRecovery } from "./answer-recovery.mjs";
import { renderAnswerApplications } from "./answer-applications-ui.mjs";
import { renderOverview } from "./project-overview.mjs";
import { renderConnectionDiagnostics } from "./connection-diagnostics-ui.mjs";
import { createInstructionPanel } from "./instruction-queue-ui.mjs";
import { createCostPanel } from "./cost-ledger-ui.mjs";
import { renderBudget } from "./budget-ui.mjs";

const $ = (id) => document.getElementById(id);
const base = location.pathname.startsWith("/_rdsh") ? "/_rdsh/" : "/";
let tabStorage;
let storageWarning = "";
function storageFailed() {
  storageWarning = "下書きをこのタブに保存できません。再読み込み・移動の前に回答をコピーしてください。";
  if ($("draft-storage-note")) $("draft-storage-note").textContent = storageWarning;
}
function storageRead(key) {
  try { return tabStorage?.getItem(key); }
  catch { storageFailed(); return null; }
}
function storageWrite(key, value) {
  try { tabStorage?.setItem(key, value); }
  catch { storageFailed(); }
}
try { tabStorage = sessionStorage; }
catch { storageFailed(); }
const suppliedBrowserToken =
  base === "/" ? new URLSearchParams(location.hash.slice(1)).get("key") : null;
const browserToken =
  base === "/"
    ? suppliedBrowserToken ||
      storageRead("rdsh_project_browser_token") ||
      ""
    : "";
if (browserToken) {
  storageWrite("rdsh_project_browser_token", browserToken);
  if (suppliedBrowserToken !== null)
    history.replaceState(null, "", location.pathname + location.search);
}
// Opening a fresh browser link in this tab may only change its fragment.
// Reload to let the existing bootstrap adopt that key for both API and SSE.
window.addEventListener("hashchange", () => {
  if (base !== "/" || !new URLSearchParams(location.hash.slice(1)).get("key")) return;
  if (storageWarning && recovery?.hasDrafts()) {
    storageWarning = "新しい接続に切り替える前に、保存できていない下書きをコピーしてください。コピー後に再読み込みすると接続を更新できます。";
    $("draft-storage-note").textContent = storageWarning;
    $("connection").textContent = storageWarning;
    return;
  }
  location.reload();
});
let authenticationRequired = false;
let streamDisconnected = false;
const authenticationMessage = "接続情報がないか、古くなっています。最新のURL・QRで開き直してください。";
function setConnection(message) {
  $("connection").textContent = authenticationRequired ? authenticationMessage : message;
}
function checkAuthentication(response) {
  if (response.status !== 401) return;
  if (!authenticationRequired) {
    authenticationRequired = true;
    $("auth-notice").replaceChildren(
      node("h2", "最新のURL・QRで開き直してください"),
      node("p", "起動元のPCで最新の完全URLまたはQRコードを取得して、開き直してください。サーバーの再起動後や別のブラウザーでは、以前の接続情報を使えないことがあります。"),
      node("p", "未送信の下書きがある場合は、必要な本文をコピーしてから、このタブで最新の完全URLを開いてください。表示中の内容は、最後に取得した情報です。"),
    );
    $("auth-notice").hidden = false;
    if (!latestState) {
      $("title").textContent = "接続し直してください";
      document.title = "接続し直してください · Dashboard";
      $("project-content").hidden = true;
    }
    // The QR and URL belong to the rejected connection. Refreshing sharing
    // cannot obtain a new browser credential through an unauthenticated API.
    if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
    qrObjectUrl = null;
    $("qr").hidden = true;
    $("qr-placeholder").hidden = false;
    $("qr-placeholder").textContent = "接続し直してください";
    $("share-url").textContent = "";
    $("share-message").textContent = authenticationMessage;
    $("share-refresh").disabled = true;
  }
  setConnection(authenticationMessage);
  throw new Error(authenticationMessage);
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
  checkAuthentication(response);
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
let renderedRevision = -1;
let latestState = null;
let recovery = null;
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
const renderCosts = createCostPanel($("cost-ledger"), node);
function render(state) {
  if (state.revision < renderedRevision) return;
  renderedRevision = state.revision;
  latestState = state;
  renderInstructions(state);
  renderCosts(state);
  renderBudget($("budget-admission"), state, node);
  updateOverview(state);
  renderReports(state);
  const unanswered = state.questions.filter((question) => question.answer === null);
  renderQuestionCards($("questions"), unanswered, state.question_contracts, {
    node,
    api,
    refreshState,
    recovery,
    applyState,
    rerender: () => render(latestState),
  });
  renderAnswerApplications($("reply-status"), state, node);
  $("answered-summary").textContent = `回答済みの質問（${state.questions.filter((question) => question.answer !== null).length}件）`;
  $("answers").replaceChildren(
    ...state.questions
      .filter((question) => question.answer !== null)
      .slice()
      .reverse()
      .map((question) => {
        const element = node("article", undefined, "event");
        element.append(
          node("code", question.id, "question-id"),
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
  setConnection(streamDisconnected ? "再接続中…" : "接続済み · プロジェクト専用");
  $("updated").textContent =
    `最終受信: ${state.updated_at ? new Date(state.updated_at).toLocaleString("ja-JP") : "まだ報告がありません"} · 鮮度は各項目の観測時刻から判定します。累計欄は報告元のAPI換算値です。台帳は出所ごとの報告値です。`;
}
function applyState(state, read = 0) {
  if (recovery && !recovery.reconcile(state, read)) return;
  render(state);
}
async function refreshState() {
  const read = recovery?.beginRead() || 0;
  try {
    applyState(await api("state"), read);
  } catch (e) {
    setConnection(streamDisconnected ? "再接続中…" : e.message);
    $("overview-state").textContent = "画面の更新に失敗 · 対象の現在状態は不明";
  }
}
let qrObjectUrl = null;
async function renderShare(config) {
  if (authenticationRequired) return;
  const share = config.share;
  $("share-message").textContent = share.message;
  $("share-url").textContent = share.url || "";
  $("qr").hidden = !share.url;
  $("qr-placeholder").hidden = Boolean(share.url);
  $("qr-placeholder").textContent =
    share.state === "disabled"
      ? "共有は無効"
      : share.state === "login_required"
        ? "Tailscaleへのログイン待ち"
        : "QRコード未発行";
  if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
  qrObjectUrl = null;
  if (share.url) {
    const response = await fetch(base + "api/qr.svg?updated=" + Date.now(), {
      headers: browserToken ? { "x-rdsh-browser-token": browserToken } : {},
    });
    checkAuthentication(response);
    if (!response.ok) throw new Error("QRコードを取得できません");
    const blob = await response.blob();
    if (authenticationRequired) return;
    qrObjectUrl = URL.createObjectURL(blob);
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
    $("share-refresh").disabled = authenticationRequired;
  }
});
// #61: コマンドパレット。既存操作への別導線であり、権限・状態チェックや
// 確認は各操作側（回答フォームなど）で行い、ここで迂回しない。
// 入力欄での誤発動を避け、Esc・Ctrl/⌘+K・元フォーカス復帰だけを扱う。
const paletteCommands = [
  {
    id: "toggle-share",
    ja: "接続・共有の表示を切り替える",
    en: "Toggle connection details",
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
let paletteViewport = null;
function fitPaletteToViewport() {
  if (!$("palette").open || !paletteViewport ||
      paletteViewport.width <= 0 || paletteViewport.height <= 0) return;
  const width = Math.min(560, Math.max(0, paletteViewport.width - 40));
  const style = $("palette").style;
  // Fixed positioning uses layout coordinates; offsets locate the visible area
  // after the keyboard appears or the user pans a zoomed page.
  style.left = `${paletteViewport.offsetLeft + (paletteViewport.width - width) / 2}px`;
  style.top = `${paletteViewport.offsetTop + 20}px`;
  style.right = "auto";
  style.bottom = "auto";
  style.margin = "0";
  style.width = `${width}px`;
  style.maxHeight = `${Math.max(0, paletteViewport.height - 40)}px`;
}
function stopPaletteViewport() {
  paletteViewport?.removeEventListener("resize", fitPaletteToViewport);
  paletteViewport?.removeEventListener("scroll", fitPaletteToViewport);
  paletteViewport = null;
  for (const property of ["left", "top", "right", "bottom", "margin", "width", "maxHeight"])
    $("palette").style[property] = "";
}
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
  if ($("palette").open) return;
  paletteReturnFocus = document.activeElement;
  renderPalette("");
  $("palette-search").value = "";
  $("palette").showModal();
  stopPaletteViewport();
  paletteViewport = window.visualViewport;
  paletteViewport?.addEventListener("resize", fitPaletteToViewport);
  paletteViewport?.addEventListener("scroll", fitPaletteToViewport);
  fitPaletteToViewport();
  // The close button receives showModal's initial focus. Request search focus
  // explicitly without asking iOS to zoom or scroll the field into view.
  $("palette-search").focus({ preventScroll: true });
}
$("palette-toggle").addEventListener("click", openPalette);
$("palette-close").addEventListener("click", () => $("palette").close());
$("palette-search").addEventListener("input", (event) =>
  renderPalette(event.target.value),
);
$("palette").addEventListener("close", () => {
  if ($("palette").open) return;
  stopPaletteViewport();
  if (paletteReturnFocus?.focus) paletteReturnFocus.focus({ preventScroll: true });
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
  if (authenticationRequired) throw new Error(authenticationMessage);
  if (config.kind === "harness") {
    $("connection-detail").hidden = true;
    $("kind").textContent = "DEEPSEEK HARNESS";
    $("title").textContent = "Harnessを開く";
    $("location").textContent = "会話・ツール実行のWeb画面";
    $("project-content").hidden = true;
    $("harness").hidden = false;
    $("harness-open").href = config.harness_url;
    setConnection("接続済み · Harness専用の入口");
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
    recovery = createQuestionRecovery(config.project.id, {
      read: storageRead, write: storageWrite, onStorageError: storageFailed,
    });
    $("quick-actions").hidden = false;
    await refreshState();
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) return refreshState();
    });
    const source = new EventSource(
      base + "api/live?key=" + encodeURIComponent(browserToken),
    );
    source.addEventListener("changed", refreshState);
    source.onerror = () => {
      streamDisconnected = true;
      setConnection("再接続中…");
      $("overview-state").textContent = "再接続中 · 対象の現在状態は不明";
      // EventSource does not expose HTTP status. Recheck the authenticated API.
      if (!authenticationRequired) return refreshState();
    };
    source.onopen = () => {
      streamDisconnected = false;
      return refreshState();
    };
    // Expiration needs a clock update even when publishers send no SSE event.
    setInterval(refreshState, 5000);
  }
} catch (e) {
  setConnection(e.message);
}
