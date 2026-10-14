import { renderReports } from "./reports-view.mjs";
import { renderQuestionCards } from "./question-cards-ui.mjs";
import { renderAnswerApplications } from "./answer-applications-ui.mjs";
import { renderOverview } from "./project-overview.mjs";
import { renderConnectionDiagnostics } from "./connection-diagnostics-ui.mjs";
import { createInstructionPanel } from "./instruction-queue-ui.mjs";
import { createCostPanel } from "./cost-ledger-ui.mjs";
import { createModelCatalogPanel } from "./model-catalog-ui.mjs";
import { renderBudget } from "./budget-ui.mjs";
import { createHumanAnnotationPanel } from "./human-annotations-ui.mjs";
import { setupObservedCli } from "./observed-cli-ui.mjs";
import { formatDateTime, text } from "./locale.mjs";

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
async function api(route, body, method) {
  const headers = browserToken ? { "x-rdsh-browser-token": browserToken } : {};
  const requestMethod = method || (body === undefined ? "GET" : "POST");
  const options = { method: requestMethod, headers };
  if (body !== undefined) {
    options.headers = { ...headers, "content-type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(base + "api/" + route, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || text("connection.failed"));
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
let selectedTask = "";
let selectionKey = "";
let observedCli = null;
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
  const options = [{ id: "", title: text("overview.project") }, ...state.tasks];
  if (selectedTask && !state.tasks.some((task) => task.id === selectedTask))
    options.push({ id: selectedTask, title: text("overview.missingTask") });
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
    text("overview.decisions", { count: view.pending.length, reviews: view.reviews.length ? ` · ${text("overview.instructions", { count: view.reviews.length })}` : "" });
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
  $("diagnostics-status").textContent = text("diagnostics.working");
  try {
    const report = await api("diagnostics");
    renderConnectionDiagnostics($("diagnostics-result"), report, node);
    $("diagnostics-status").textContent =
      text("diagnostics.ready");
  } catch {
    $("diagnostics-status").textContent =
      text("diagnostics.failed");
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
const renderCatalog = createModelCatalogPanel($("model-catalog"), node);
const renderHumanAnnotations = createHumanAnnotationPanel(
  $("human-annotations-panel"),
  { api, node, navigateTo },
);
function render(state) {
  if (state.revision < renderedRevision) return;
  renderedRevision = state.revision;
  latestState = state;
  observedCli?.render(state);
  renderInstructions(state);
  renderCosts(state);
  renderCatalog();
  renderBudget($("budget-admission"), state, node);
  updateOverview(state);
  renderHumanAnnotations(state);
  renderReports(state);
  const unanswered = state.questions.filter((question) => question.answer === null);
  renderQuestionCards($("questions"), unanswered, state.question_contracts, {
    node,
    api,
    refreshState,
  });
  renderAnswerApplications($("reply-status"), state, node);
  $("answers").replaceChildren(
    ...state.questions
      .filter((question) => question.answer !== null)
      .slice()
      .reverse()
      .map((question) => {
        const element = node("article", undefined, "event");
        element.id = "decision-" + encodeURIComponent(question.id);
        element.append(
          node("strong", question.question),
          node("p", question.answer),
        );
        const contract = state.question_contracts?.cards[question.id];
        element.append(
          node(
            "p",
            contract
              ? `${text("answer.version", { version: contract.revision })} · ${contract.status === "answered" ? text("answer.answered") : contract.status === "expired" ? text("answer.expired") : text("answer.cancelled")} · ${text("answer.noAuthority")}`
              : text("answer.saved"),
            "sub",
          ),
        );
        return element;
      }),
  );
  $("connection").textContent = text("connection.connected");
  $("updated").textContent =
    text("updated.prefix", { time: state.updated_at ? formatDateTime(state.updated_at) : text("updated.none") });
}
async function refreshState() {
  try {
    render(await api("state"));
  } catch (e) {
    $("connection").textContent = e.message;
    $("overview-state").textContent = text("overview.refreshFailed");
  }
}
let qrObjectUrl = null;
async function renderShare(config) {
  const share = config.share;
  const key = "share.state." + share.state;
  const message = text(key);
  $("share-message").textContent = message === key ? share.message : message;
  if (share.state === "setup_required" && share.message) {
    const detail = node("details");
    detail.append(node("summary", text("share.rawDetail")), node("pre", share.message));
    $("share-message").append(detail);
  }
  $("share-url").textContent = share.url || "";
  $("qr").hidden = !share.url;
  $("qr-placeholder").hidden = Boolean(share.url);
  $("qr-placeholder").textContent =
    share.state === "login_required"
      ? text("share.loginRequired")
      : text("share.preparing");
  if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
  qrObjectUrl = null;
  if (share.url) {
    const response = await fetch(base + "api/qr.svg?updated=" + Date.now(), {
      headers: browserToken ? { "x-rdsh-browser-token": browserToken } : {},
    });
    if (!response.ok) throw new Error(text("share.qrFailed"));
    qrObjectUrl = URL.createObjectURL(await response.blob());
    $("qr").src = qrObjectUrl;
  }
  $("consent").hidden = !share.consent_url;
  if (share.consent_url) $("consent").href = share.consent_url;
  $("mcp-info").textContent =
    config.kind === "project"
      ? text("mcp.subscriptions", { count: config.events?.active || 0 }) +
        (config.events?.failures
          ? ` · ${text("mcp.failures", { count: config.events.failures })}`
          : "") +
        (config.mcp_url
          ? ` · ${text("mcp.endpoint", { url: config.mcp_url })}`
          : ` · ${text("mcp.pending")}`)
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
    label: "palette.toggleShare",
    keys: "共有 スマホ QR share phone",
    run: () => $("share-toggle").click(),
  },
  {
    id: "refresh-share",
    label: "palette.refreshShare",
    keys: "更新 refresh",
    run: () => $("share-refresh").click(),
  },
  {
    id: "goto-pending",
    label: "palette.pending",
    keys: "質問 未回答 question pending",
    run: () => navigateTo("pending-heading"),
  },
  {
    id: "toggle-answered",
    label: "palette.toggleAnswered",
    keys: "回答済み answered",
    run: () => {
      $("answered").open = !$("answered").open;
    },
  },
  {
    id: "back-to-top",
    label: "palette.top",
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
      (text(command.label) + " " + command.keys)
        .toLowerCase()
        .includes(query),
  );
  $("palette-list").replaceChildren(
    ...matched.map((command) => {
      const item = node("li");
      const button = node("button", text(command.label));
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
    ? text("palette.count", { count: matched.length })
    : text("palette.none");
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
  if (config.kind === "project") observedCli = setupObservedCli({ api });
  await renderShare(config);
  if (config.kind === "harness") {
    $("connection-detail").hidden = true;
    $("kind").textContent = "DEEPSEEK HARNESS";
    $("title").textContent = text("app.harnessTitle");
    $("location").textContent = text("app.harnessLocation");
    $("project-content").hidden = true;
    $("harness").hidden = false;
    $("harness-open").href = config.harness_url;
    $("connection").textContent = text("app.harnessConnection");
    $("share").hidden = false;
    $("share-toggle").setAttribute("aria-expanded", "true");
    let stopRequested = false;
    let pendingStop = null;
    const refreshManaged = async () => {
      try {
        const value = await api("managed-process"),
          scope = value.scope;
        const labels = {
          running: text("status.running"), stopping: text("status.stopping"),
          exit_confirmed: text("status.exitConfirmed"), unverifiable: text("status.unverifiable"),
        };
        $("managed-status").textContent =
          labels[scope?.status] ?? text("status.none");
        $("managed-remaining").textContent = scope
          ? text("status.remaining", { count: scope.remaining_count ?? text("status.unknown") }) +
            (scope.remaining_pids.length
              ? ` · PID ${scope.remaining_pids.join(", ")}`
              : "") +
            (scope.members_truncated ? ` · ${text("status.partial")}` : "") +
            (scope.confirmed && !scope.resources_released
              ? ` · ${text("status.resources")}`
              : "")
          : "";
        $("managed-run").textContent = value.run_id ?? "";
        const names = {
          input_interrupt: text("managed.stage.inputInterrupt"), graceful: text("managed.stage.graceful"),
          termination: text("managed.stage.termination"), kill: text("managed.stage.kill"), verification: text("managed.stage.verification"),
        };
        const results = {
          requested: text("managed.result.requested"), unsupported: text("managed.result.unsupported"),
          running: text("managed.result.running"), exit_confirmed: text("managed.result.exitConfirmed"), unverifiable: text("managed.result.unverifiable"),
        };
        $("managed-stages").replaceChildren(
          ...value.stages.map((stage) =>
            node(
              "li",
              `${names[stage.stage]} · ${stage.phase === "request" ? text("managed.stage.recorded") : results[stage.status]}`,
            ),
          ),
        );
        $("managed-stop").disabled =
          stopRequested || scope?.status !== "running";
        $("harness-open").hidden = scope?.status === "exit_confirmed";
      } catch {
        $("managed-status").textContent =
          text("managed.monitorFailed");
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
          text("managed.impact", { count: current.scope.remaining_count ?? text("status.unknown") });
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
            text("managed.targetChanged"),
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
        text("status.stopping");
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
    document.title = config.project.name + " · " + text("chrome.project");
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
      $("connection").textContent = text("app.reconnecting");
      $("overview-state").textContent = text("app.reconnectingState");
    };
    source.onopen = refreshState;
    // Expiration needs a clock update even when publishers send no SSE event.
    setInterval(refreshState, 5000);
  }
} catch (e) {
  $("connection").textContent = e.message;
}
