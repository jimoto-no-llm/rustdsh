import { renderAttention } from "./attention-view.mjs";
import { renderReports } from "./reports-view.mjs";
import { renderTaskContract, renderOperations } from "./contract-view.mjs";
import { renderQuestionCards } from "./question-cards-ui.mjs";
import { renderAnswerApplications } from "./answer-applications-ui.mjs";
import { renderOverview } from "./project-overview.mjs";
import { renderConnectionDiagnostics } from "./connection-diagnostics-ui.mjs";
import { renderGitHubStatus } from "./github-status-ui.mjs";
import { createInstructionPanel } from "./instruction-queue-ui.mjs";
import { createCostPanel } from "./cost-ledger-ui.mjs";
import { createModelCatalogPanel } from "./model-catalog-ui.mjs";
import { renderSurface } from "./ui/blocks.mjs";
import { renderBudget } from "./budget-ui.mjs";
import {
  clearPendingProjectDeepLink,
  clearProjectDeepLinkUrl,
  createProjectDeepLink,
  parseProjectDeepLink,
  pendingProjectDeepLink,
  rememberProjectDeepLink,
  resolveProjectDeepLink,
} from "./deep-links.mjs";
import { deepLinkButton } from "./deep-link-ui.mjs";
import { createUpdateSummary } from "./update-summary.mjs";
import { renderModelRouting } from "./model-routing-ui.mjs";
import { renderReviewEvidence } from "./review-evidence-ui.mjs";
import { renderManagedRunHealth } from "./run-health-ui.mjs";
import { createPlanPanel } from "./execution-plan-ui.mjs";
import { createTimelinePanel } from "./causal-timeline-ui.mjs";
import { createNotificationPanel } from "./notifications-ui.mjs";
import { createTaskOutcomesPanel } from "./task-outcomes-ui.mjs";
import { createHumanAnnotationPanel } from "./human-annotations-ui.mjs";
import { createHumanMetricsPanel } from "./human-metrics-ui.mjs";
import { createDecisionLogPanel } from "./decision-log-ui.mjs";
import { setupObservedCli } from "./observed-cli-ui.mjs";
import { formatDateTime, searchText, text } from "./locale.mjs";
import { setupDeviceAccess } from "./devices-ui.mjs";
import { renderProviderStatuses } from "./provider-status-ui.mjs";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const base = location.pathname.startsWith("/_rdsh") ? "/_rdsh/" : "/";
let deviceAccess = null;
let deepLinkStorage = null;
try {
  deepLinkStorage = localStorage;
} catch {}
const urlDeepLink = parseProjectDeepLink(location.href);
if (urlDeepLink.status === "target")
  rememberProjectDeepLink(deepLinkStorage, urlDeepLink);
const requestedDeepLink =
  urlDeepLink.status === "none"
    ? pendingProjectDeepLink(deepLinkStorage)
    : urlDeepLink;
const suppliedBrowserToken =
  base === "/" ? new URLSearchParams(location.hash.slice(1)).get("key") : null;
const browserTokenKey =
  base === "/" ? "rdsh_project_browser_token" : "rdsh_harness_browser_token";
const browserToken =
  suppliedBrowserToken || sessionStorage.getItem(browserTokenKey) || "";
if (browserToken) {
  sessionStorage.setItem(browserTokenKey, browserToken);
  if (suppliedBrowserToken !== null)
    history.replaceState(null, "", location.pathname + location.search);
}
function deviceMayCall(route, method) {
  if (deviceAccess?.role !== "device" || method === "GET") return true;
  const capabilities = new Set(deviceAccess.capabilities);
  if (
    ["update/answer", "instructions/resolve"].includes(route) &&
    capabilities.has("reply")
  )
    return true;
  return (
    ["decision/cancel", "instructions/submit", "managed-stop"].includes(
      route,
    ) && capabilities.has("control")
  );
}
async function api(route, body, method) {
  const headers = browserToken ? { "x-rdsh-browser-token": browserToken } : {};
  const requestMethod = method || (body === undefined ? "GET" : "POST");
  if (!deviceMayCall(route, requestMethod))
    throw new Error("この端末にはその操作権限がありません");
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
function formatObservedAt(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleString("ja-JP")
    : "観測履歴なし";
}
async function refreshProjectCrossOverview() {
  const list = $("cross-project-rows");
  try {
    const value = await api("projects/overview");
    const projectFilter = $("cross-project-search-project");
    const selectedProject = projectFilter.value;
    projectFilter.replaceChildren(node("option", "すべてのproject"));
    projectFilter.firstElementChild.value = "";
    for (const project of value.projects) {
      const option = node("option", project.name);
      option.value = project.project_id;
      projectFilter.append(option);
    }
    projectFilter.value = value.projects.some(
      (project) => project.project_id === selectedProject,
    )
      ? selectedProject
      : "";
    list.replaceChildren(
      ...value.projects.map((project) => {
        const item = node("li", undefined, "event");
        item.append(node("strong", project.name));
        if (project.status === "observed" && project.counts) {
          item.append(
            node(
              "p",
              `稼働 ${project.counts.active} · 待ち ${project.counts.waiting} · 要確認 ${project.counts.needs_attention}`,
            ),
            node(
              "p",
              `最終観測: ${formatObservedAt(project.last_observed_at)}`,
              "sub",
            ),
          );
        } else {
          item.append(
            node("p", "稼働・待ち・要確認: 不明"),
            node(
              "p",
              `最終観測: ${formatObservedAt(project.last_observed_at)}`,
              "sub",
            ),
          );
        }
        if (project.detail_url) {
          const link = node("a", "元projectの詳細を開く");
          link.href = project.detail_url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          item.append(link);
        } else if (project.status === "observed") {
          item.append(
            node(
              "p",
              "詳細画面は停止中です。元projectのdashboard起動後に開けます。",
              "sub",
            ),
          );
        }
        return item;
      }),
    );
    $("cross-project-observed").textContent =
      `この一覧の最終取得: ${formatObservedAt(value.observed_at)}`;
  } catch {
    list.replaceChildren();
    $("cross-project-observed").textContent =
      "横断情報を取得できません · 状態は不明です";
  }
}
const searchKindNames = {
  task: "task",
  decision: "判断",
  log: "log",
  artifact: "artifact参照",
};
function renderProjectCrossSearch(value) {
  const list = $("cross-project-search-results");
  list.replaceChildren(
    ...(value.results || []).map((result) => {
      const item = node("li", undefined, "event");
      item.append(
        node(
          "strong",
          `${result.project_name} · ${searchKindNames[result.kind] || result.kind} · ${result.title}`,
        ),
        node("p", result.snippet),
        node(
          "p",
          `${result.kind}:${result.record_id} · ${formatObservedAt(result.time)} · ${result.search_scope === "reference_only" ? "参照情報のみを検索" : "記録本文を検索"}`,
          "sub",
        ),
      );
      if (result.reference_status) {
        const labels = {
          available: "参照ファイルの存在を確認",
          stale: "参照先なし · 古い参照",
          external: "外部参照 · 取得状態は未確認",
          unknown: "参照先の状態は未確認",
        };
        item.append(
          node(
            "p",
            labels[result.reference_status] || "参照先の状態は未確認",
            result.reference_status === "stale" ? "warn" : "sub",
          ),
        );
      }
      if (result.source_url) {
        const link = node("a", "元の記録を開く");
        link.href = result.source_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        item.append(link);
      } else {
        item.append(node("p", "元projectのdashboardは停止中です", "sub"));
      }
      return item;
    }),
  );
  const unavailable = value.unavailable_projects?.length || 0;
  $("cross-project-search-status").textContent =
    `一致 ${value.matched_count}件${value.truncated ? " · 表示上限に達しました" : ""}${unavailable ? ` · 状態不明 ${unavailable} project（検索結果なし）` : ""}`;
}
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
  // SVG shapes need the SVG namespace or they render as inert HTML nodes.
  node.svg = (tag) => document.createElementNS(SVG_NS, tag);
// Theme: the boot script picks the palette before paint; this keeps the
// toggle label, aria state and storage in sync afterwards.
const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const storedTheme = () => {
  try {
    return localStorage.getItem("rdsh_dashboard_theme");
  } catch {
    return null;
  }
};
const currentTheme = () =>
  document.documentElement.dataset.theme === "dark" ? "dark" : "light";
function renderThemeToggle() {
  const dark = currentTheme() === "dark";
  const button = $("theme-toggle");
  button.textContent = dark ? "ライト表示" : "ダーク表示";
  button.setAttribute("aria-pressed", String(dark));
}
function setTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem("rdsh_dashboard_theme", theme);
    } catch {}
  }
  renderThemeToggle();
}
$("theme-toggle").addEventListener("click", () => {
  setTheme(currentTheme() === "dark" ? "light" : "dark", true);
});
themeQuery.addEventListener("change", (event) => {
  // An explicit operator choice outranks the system preference.
  const stored = storedTheme();
  if (stored === "dark" || stored === "light") return;
  setTheme(event.matches ? "dark" : "light", false);
});
renderThemeToggle();

let artifactPreviewUrl = null;
let artifactPreviewRequest = 0;
let artifactPreviewRevision = -1;
async function previewArtifact(sequence) {
  const request = ++artifactPreviewRequest;
  // The state generation at click time: a newer render while the fetch is
  // in flight leaves older text on screen, so the dialog says so.
  const revision = latestState?.revision ?? -1;
  artifactPreviewRevision = revision;
  const dialog = $("artifact-preview");
  const status = $("artifact-preview-status");
  const content = $("artifact-preview-content");
  content.replaceChildren();
  status.textContent = "成果物を読み取っています…";
  dialog.showModal();
  try {
    const response = await fetch(
      base + "api/artifacts/" + encodeURIComponent(sequence),
      {
        headers: browserToken
          ? { "x-rdsh-browser-token": browserToken }
          : {},
      },
    );
    if (request !== artifactPreviewRequest) return;
    if (!response.ok) {
      let reason = "成果物をプレビューできません";
      try {
        reason = (await response.json()).error || reason;
      } catch {}
      throw new Error(reason);
    }
    const blob = await response.blob();
    if (request !== artifactPreviewRequest) return;
    const redacted = response.headers.get("x-rdsh-preview-redacted") === "true";
    const truncated = response.headers.get("x-rdsh-preview-truncated") === "true";
    const isImage = response.headers.get("x-rdsh-preview-kind") === "image";
    const text = isImage ? null : await blob.text();
    if (request !== artifactPreviewRequest) return;
    const stale =
      latestState != null &&
      revision !== -1 &&
      latestState.revision !== revision;
    const staleNote = stale ? "（取得後に状態が更新されました）" : "";
    if (isImage) {
      artifactPreviewUrl = URL.createObjectURL(blob);
      const image = node("img", undefined, "artifact-preview-image");
      image.src = artifactPreviewUrl;
      image.alt = "成果物の画像プレビュー";
      content.append(image);
      status.textContent =
        "画像を読み取り専用で表示しています。" + staleNote;
    } else {
      content.append(node("pre", text, "artifact-preview-text"));
      status.textContent =
        [
          redacted
            ? "認証情報らしき値を伏せて表示しています。"
            : "読み取り専用のテキスト表示です。",
          truncated ? "先頭128 KiBまで表示しています。" : "",
        ]
          .filter(Boolean)
          .join(" ") + staleNote;
    }
  } catch (error) {
    if (request !== artifactPreviewRequest) return;
    content.replaceChildren(node("p", error.message, "warn"));
    status.textContent = "表示できる内容はありません。元ファイルは変更していません。";
  }
}
$("artifact-preview-close").addEventListener("click", () =>
  $("artifact-preview").close(),
);
$("artifact-preview").addEventListener("close", () => {
  artifactPreviewRequest++;
  if (artifactPreviewUrl) URL.revokeObjectURL(artifactPreviewUrl);
  artifactPreviewUrl = null;
});
$("cross-project-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  $("cross-project-search-status").textContent = "検索中…";
  $("cross-project-search-results").replaceChildren();
  const projectId = $("cross-project-search-project").value;
  try {
    const value = await api("projects/search", {
      query: $("cross-project-search-query").value,
      ...(projectId ? { project_ids: [projectId] } : {}),
      kind: $("cross-project-search-kind").value,
      since: $("cross-project-search-since").value,
      until: $("cross-project-search-until").value,
    });
    renderProjectCrossSearch(value);
  } catch (error) {
    $("cross-project-search-status").textContent =
      `検索できませんでした: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});
function focusCurrentSource() {
  let target;
  try {
    target = decodeURIComponent(location.hash.slice(1));
  } catch {
    return;
  }
  if (/^(?:task|question|decision|event)-/.test(target)) navigateTo(target);
}
window.addEventListener("hashchange", focusCurrentSource);
let renderedRevision = -1;
let latestState = null;
const timeline = createTimelinePanel($("causal-timeline"), { api, node });
setInterval(() => {
  if (latestState?.project) void timeline.refresh();
}, 5000);
let selectedTask = "";
let selectionKey = "";
let deepLinkHandled = false;
function makeDeepLink(kind, id, runId) {
  if (!latestState?.project?.id) throw new Error("Project state is unavailable");
  return createProjectDeepLink(
    location.href,
    latestState.project.id,
    kind,
    id,
    runId,
  );
}
let observedCli = null;
let workspaceLayoutStorageKey = null;
const workspaceLayouts = ["1", "2", "3"];
function setWorkspaceLayout(value, { persist = true, announce = true } = {}) {
  if (!workspaceLayouts.includes(value)) return false;
  $("workspace-grid").dataset.layout = value;
  document
    .querySelectorAll('input[name="workspace-layout"]')
    .forEach((input) => {
      input.checked = input.value === value;
    });
  let saved = false;
  if (persist && workspaceLayoutStorageKey) {
    try {
      localStorage.setItem(workspaceLayoutStorageKey, value);
      saved = true;
    } catch {}
  }
  if (announce) {
    $("workspace-layout-status").textContent = saved
      ? text("workspace.saved", { count: value })
      : text("workspace.unsaved");
  }
  return true;
}
function restoreWorkspaceLayout(projectId) {
  let layout = "3";
  if (typeof projectId === "string" && projectId.trim()) {
    workspaceLayoutStorageKey =
      `rdsh:workspace-layout:v1:${encodeURIComponent(projectId)}`;
    try {
      const saved = localStorage.getItem(workspaceLayoutStorageKey);
      if (workspaceLayouts.includes(saved)) layout = saved;
    } catch {}
  }
  setWorkspaceLayout(layout, { persist: false, announce: false });
  $("workspace-layout-controls").disabled = false;
}
document
  .querySelectorAll('input[name="workspace-layout"]')
  .forEach((input) =>
    input.addEventListener("change", () => {
      if (input.checked) setWorkspaceLayout(input.value);
    }),
  );
function navigateTo(id) {
  const target = $(id);
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement)
    if (parent.tagName === "DETAILS") parent.open = true;
  if (target.tagName === "DETAILS") target.open = true;
  target.tabIndex = -1;
  target.focus();
  target.scrollIntoView({ block: "start" });
}
function applyDeepLink(state) {
  if (deepLinkHandled || requestedDeepLink.status === "none") return;
  deepLinkHandled = true;
  const status = $("deep-link-status");
  if (requestedDeepLink.status === "invalid") {
    status.textContent =
      "リンクの対象情報を読み取れません。project・対象・IDを確認してください。";
  } else {
    const target = resolveProjectDeepLink(requestedDeepLink, state);
    if (target.status === "wrong_project") {
      status.textContent =
        "このリンクは別projectの対象です。対象projectの認証済み画面から開いてください。";
    } else if (target.status === "not_found") {
      status.textContent =
        "リンク先はこのprojectの現在の状態にありません。削除済みか、接続先が異なる可能性があります。";
    } else if (target.status === "ambiguous") {
      status.textContent =
        "同じrun/sessionの対象を一意に確認できません。元の画面でリンクを作り直してください。";
    } else if (target.status === "found" && target.kind === "session") {
      if (renderInstructions.selectTarget(target.consumerId)) {
        navigateTo("instruction-detail");
        status.textContent = `登録済みのrun/session ${requestedDeepLink.runId} / ${requestedDeepLink.id} を表示しました。現在の接続状態は未確認です。`;
      } else {
        status.textContent =
          "session対象を確認しましたが、追指示の保存処理中です。処理後にリンクを開き直してください。";
      }
    } else if (target.status === "found") {
      navigateTo(target.elementId);
      status.textContent = `${target.kind} ${target.id} を表示しました。`;
    } else {
      status.textContent = "リンク先を確認できません。対象情報を確認してください。";
    }
  }
  clearPendingProjectDeepLink(deepLinkStorage);
  history.replaceState(
    null,
    "",
    clearProjectDeepLinkUrl(location.href),
  );
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
function renderRunDiagnostics(report) {
  const target = $("run-diagnostics-result");
  const classNames = {
    active: "活動を観測",
    api_wait_possible: "応答待ちの可能性",
    stall_suspected: "停滞の疑い（未確定）",
    resource_wait: "資源待ち",
    process_exited: "プロセス終了を観測",
    waiting_human: "人の確認待ち",
    succeeded: "完了記録",
    failed: "失敗記録",
    insufficient_evidence: "根拠不足・状態未確認",
  };
  const signalNames = {
    process: "プロセス",
    agent_activity: "ACP活動heartbeat",
    api_wait: "応答要求",
    resource_wait: "資源待ち",
    cpu_activity: "CPU活動",
    gpu_activity: "GPU活動",
    browser_connection: "ブラウザー接続",
  };
  const statusNames = {
    alive: "稼働を観測",
    exit_confirmed: "終了を確認",
    absence_observed: "不在を観測",
    gone: "終了を観測",
    pid_reused: "PID再利用を観測",
    unknown: "未確認",
    recent: "最近の活動あり",
    delayed: "heartbeat遅延",
    unverified: "時刻を検証できず",
    unavailable: "取得できず",
    request_pending: "送信応答待ち（推定）",
    not_observed: "待機なし／未報告",
    waiting: "待機中",
    available: "利用可能",
    connected: "接続中",
    disconnected: "切断を観測",
  };
  const basisNames = {
    measured: "実測・記録",
    inferred: "推定",
    unavailable: "欠測",
    unknown: "未確認",
  };
  const reasonNames = {
    recorded_terminal_result: "run履歴に終端結果が記録されています",
    owned_process_exit_observed: "所有プロセスの終了を観測しました",
    run_recorded_waiting_for_resource: "run状態が資源待ちです",
    explicit_resource_wait_observed: "資源providerが待機を報告しました",
    resource_observation_conflicts_with_run_state: "run状態と資源providerの観測が一致しません",
    run_recorded_waiting_for_human: "run状態が人の確認待ちです",
    recent_acp_activity_heartbeat: "ACPから最近の活動通知を受けています",
    send_command_pending_without_recent_activity: "送信要求が未完了で、最近のACP活動がありません",
    long_pending_send_without_recent_activity: "送信要求とプロセスは残っていますが、活動heartbeatが長時間ありません",
    browser_disconnected_run_health_unconfirmed: "ブラウザー切断だけではrun状態を判定できません",
    independent_activity_or_resource_observation_missing: "活動や資源の独立した観測がありません",
  };
  const recommendationNames = {
    reconnect_dashboard: "ダッシュボードへ再接続する",
    inspect_resource_readiness: "待機中の資源・leaseを確認する",
    check_provider_and_cli_status: "provider/APIとCLIの状態を確認する",
    collect_another_observation: "時間を置いて追加観測する",
    collect_process_and_activity_observations: "プロセスとACP heartbeatを再確認する",
    review_recorded_run_state: "記録済みのrun状態を確認する",
  };
  const when = (value) =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString("ja-JP")
      : "未取得";
  const age = (value) =>
    value === null || value === undefined
      ? "経過時間未計測"
      : value < 60000
        ? `${Math.floor(value / 1000)}秒前`
        : `${Math.floor(value / 60000)}分前`;
  const cards = (report.runs || []).map((run) => {
    const diagnosis = run.stall_diagnosis;
    const classification =
      classNames[diagnosis.classification] || diagnosis.classification;
    const article = node("article", undefined, "event");
    article.append(
      node("strong", `${run.run_id} · ${classification}`),
      node(
        "p",
        [
          `記録状態 ${run.recorded_state}`,
          `根拠 ${basisNames[diagnosis.confidence] || diagnosis.confidence}`,
          reasonNames[diagnosis.reason] || diagnosis.reason,
        ].join(" · "),
      ),
      node(
        "p",
        `観測時刻 ${when(diagnosis.observed_at)} · 自動停止なし`,
      ),
    );
    const evidence = node("ul");
    for (const signal of diagnosis.signals) {
      const signalName = signalNames[signal.name] || signal.name;
      const signalStatus = statusNames[signal.status] || signal.status;
      const detail = [
        `${signalName}: ${signalStatus}`,
        basisNames[signal.basis] || signal.basis,
        signal.resource_kind ? `種別 ${signal.resource_kind}` : null,
        signal.age_ms === undefined ? null : age(signal.age_ms),
        `観測 ${when(signal.observed_at)}`,
        `確認 ${when(signal.checked_at)}`,
      ]
        .filter(Boolean)
        .join(" · ");
      evidence.append(node("li", detail));
    }
    article.append(evidence);
    const next = (diagnosis.recommendations || [])
      .map((item) => recommendationNames[item] || item)
      .join(" · ");
    article.append(
      node("p", `次の確認: ${next || "追加操作は不要です"}`),
    );
    if (diagnosis.limitations?.length)
      article.append(
        node(
          "p",
          `未確認: ${diagnosis.limitations.join(" · ")}`,
          "sub",
        ),
      );
    return article;
  });
  target.replaceChildren(
    ...(cards.length ? cards : [node("p", "run履歴がありません。", "sub")]),
  );
}
$("run-diagnostics-refresh").onclick = async () => {
  $("run-diagnostics-refresh").disabled = true;
  $("run-diagnostics-status").textContent = "プロセスとrun履歴を確認中…";
  try {
    const report = await api("run-diagnostics");
    renderRunDiagnostics(report);
    const statusDetails = [
      report.recovery_required ? "履歴の末尾が未確定" : null,
      report.observation_store_status === "unavailable"
        ? "活動観測の保存内容を確認できません"
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    $("run-diagnostics-status").textContent =
      `直近 ${report.runs.length} run · 観測 ${new Date(
        report.observed_at,
      ).toLocaleString("ja-JP")}${statusDetails ? ` · ${statusDetails}` : ""}`;
  } catch (error) {
    $("run-diagnostics-status").textContent =
      `診断を取得できません: ${error.message}`;
    $("run-diagnostics-result").replaceChildren();
  } finally {
    $("run-diagnostics-refresh").disabled = false;
  }
};
$("github-status-refresh").onclick = async () => {
  const button = $("github-status-refresh");
  button.disabled = true;
  $("github-status-message").textContent =
    "ローカルSHA・追跡先・GitHubの状態を取得中…";
  try {
    const report = await api("github/status");
    renderGitHubStatus($("github-status-result"), report, node);
    $("github-status-message").textContent =
      "読み取り専用の観測結果です。時刻とSHAを確認してください。";
  } catch {
    $("github-status-result").replaceChildren();
    $("github-status-message").textContent =
      "状態を取得できません。未確認として扱い、成功表示へ置き換えません。";
  } finally {
    button.disabled = false;
  }
};
const renderInstructions = createInstructionPanel($("instruction-panel"), {
  node,
  api,
  refreshState,
  makeDeepLink,
});
const renderNotifications = createNotificationPanel({
  api,
  refreshState,
  navigateTo,
});
const renderCosts = createCostPanel($("cost-ledger"), node);
let summarySourceRecords = [];
const renderUpdateSummary = createUpdateSummary($("update-summary"), {
  node,
  navigateTo,
  loadChangeRecords: (afterRevision) =>
    api(`changes?after_revision=${encodeURIComponent(afterRevision)}`),
  onSourceRecords: (records, sourceEventIds, state) => {
    summarySourceRecords = records;
    renderReports(
      { ...state, change_records: records },
      Date.now(),
      sourceEventIds,
    );
  },
});
const renderTaskOutcomes = createTaskOutcomesPanel(
  $("tasks"),
  $("task-milestones"),
  { node, api, makeDeepLink },
);
const renderCatalog = createModelCatalogPanel($("model-catalog"), node);
// rdsh-ui/1: the agent presents a surface, and a human action returns to the
// same session. The rendered surface is skipped until its revision changes so
// an update never wipes a draft, a selection or focus.
let renderedSurfaceKey = "";
let uiActionSequence = 0;
async function submitUiAction(action, block, value) {
  const surface = latestState?.ui_surfaces?.current;
  const status = $("agent-ui-status");
  if (!surface) {
    status.textContent = "提示されたUIがありません。";
    return;
  }
  uiActionSequence += 1;
  const body = {
    surface_id: surface.surface_id,
    surface_revision: surface.revision,
    block_id: block.id,
    action_id: action.id,
    action_request_id: "act_" + Date.now().toString(36) + "_" + uiActionSequence,
  };
  if (value !== null && value !== undefined) body.value = value;
  try {
    const result = await api("ui/actions", body);
    status.className = result.followup_required ? "" : "ok";
    status.textContent = result.followup_required
      ? "要求として記録しました。実行は別の認可された経路で行われます。"
      : "選択をセッションへ返しました（受付 " + result.sequence + "）。実行権限は発行していません。";
  } catch (error) {
    status.className = "error";
    status.textContent = "送信できません: " + error.message;
  }
}
function renderAgentUi(state) {
  const surface = state.ui_surfaces?.current || null;
  const key = surface ? surface.surface_id + "@" + surface.revision : "none";
  if (key === renderedSurfaceKey) return;
  renderedSurfaceKey = key;
  renderSurface($("agent-ui"), surface, node, submitUiAction);
  const meta = $("agent-ui-meta");
  const status = $("agent-ui-status");
  meta.replaceChildren();
  status.className = "";
  status.textContent = "";
  if (!surface) {
    meta.append(node("span", "提示待ち"));
    return;
  }
  meta.append(
    node("span", surface.surface_id, "ui-surface-id"),
    node("span", "版 " + surface.revision),
    node("span", "提示 " + (surface.presented_at
      ? new Date(surface.presented_at).toLocaleString("ja-JP")
      : "未取得")),
    node("span", "ブロック " + surface.blocks.length),
  );
}
const renderHumanAnnotations = createHumanAnnotationPanel(
  $("human-annotations-panel"),
  { api, node, navigateTo },
);
const renderHumanMetrics = createHumanMetricsPanel($("human-metrics"), {
  api,
  node,
  confirm: (message) => window.confirm(message),
});
let humanMetricsRevision = -1;
const renderDecisions = createDecisionLogPanel($("decision-log"), {
  node,
  api,
  refreshState,
});
let profileCatalog = null;
function selectedProfileVersion() {
  try {
    const selected = JSON.parse($("profile-select").value || "null");
    return selected && typeof selected.id === "string" && typeof selected.version === "string"
      ? selected
      : null;
  } catch {
    return null;
  }
}
function profileVersionEntry(selection) {
  return profileCatalog?.profiles?.[selection?.id]?.versions?.find(
    (entry) => entry.version === selection.version,
  ) || null;
}
function loadProfileSelection() {
  const selection = selectedProfileVersion();
  const profile = profileCatalog?.profiles?.[selection?.id];
  const version = profileVersionEntry(selection);
  if (!profile || !version) return;
  $("profile-id").value = profile.id;
  $("profile-name").value = profile.name;
  $("profile-values").value = JSON.stringify(version.values, null, 2);
}
async function refreshProfiles() {
  profileCatalog = await api("profiles");
  const active = profileCatalog.active;
  const versions = Object.values(profileCatalog.profiles || {})
    .flatMap((profile) => profile.versions.map((version) => ({ profile, version })))
    .sort((a, b) => a.profile.name.localeCompare(b.profile.name) ||
      b.version.created_at.localeCompare(a.version.created_at));
  const options = versions.map(({ profile, version }) => {
    const option = node(
      "option",
      `${profile.name} · ${profile.id} · ${version.version.slice(0, 19)}`,
    );
    option.value = JSON.stringify({ id: profile.id, version: version.version });
    return option;
  });
  $("profile-select").replaceChildren(...options);
  if (active) {
    $("profile-select").value = JSON.stringify(active);
  } else if (options.length) {
    $("profile-select").value = options[0].value;
  }
  if (versions.length) {
    loadProfileSelection();
    const isActive = active && versions.some(({ profile, version }) =>
      profile.id === active.id && version.version === active.version);
    $("profile-status").textContent = isActive
      ? `選択中: ${active.id} · ${active.version}`
      : "保存済みprofileがあります。実行へは自動適用されません。";
  } else {
    $("profile-id").value = "";
    $("profile-name").value = "";
    $("profile-status").textContent =
      "profileは未設定です。保存した設定は実行に自動適用されません。";
  }
}
$("profile-select").addEventListener("change", loadProfileSelection);
$("profile-save").addEventListener("click", async () => {
  const button = $("profile-save");
  button.disabled = true;
  try {
    const values = JSON.parse($("profile-values").value || "{}");
    const catalog = await api("profiles/save", {
      id: $("profile-id").value,
      name: $("profile-name").value,
      values,
      activate: true,
    });
    profileCatalog = catalog;
    await refreshProfiles();
    $("profile-status").textContent =
      `保存して選択しました: ${catalog.active.id} · ${catalog.active.version}`;
    $("profile-preview-result").textContent = "プレビューは未取得です。";
  } catch (error) {
    $("profile-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("profile-activate").addEventListener("click", async () => {
  const button = $("profile-activate");
  button.disabled = true;
  try {
    const selection = selectedProfileVersion();
    if (!selection) throw new Error("選択する保存済みprofileがありません");
    profileCatalog = await api("profiles/activate", selection);
    await refreshProfiles();
    $("profile-status").textContent =
      `選択しました: ${selection.id} · ${selection.version}`;
    $("profile-preview-result").textContent = "プレビューは未取得です。";
  } catch (error) {
    $("profile-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("profile-preview").addEventListener("click", async () => {
  const button = $("profile-preview");
  button.disabled = true;
  try {
    const selection = selectedProfileVersion();
    if (!selection) throw new Error("プレビューする保存済みprofileがありません");
    const result = await api("profiles/preview", {
      ...selection,
      user: JSON.parse($("profile-user-values").value || "{}"),
      invocation: JSON.parse($("profile-invocation-values").value || "{}"),
    });
    $("profile-preview-result").textContent = JSON.stringify(result, null, 2);
    $("profile-status").textContent =
      "優先順位と出所を表示しました。実行・権限変更は発生していません。";
  } catch (error) {
    $("profile-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
function render(state) {
  if (state.revision < renderedRevision) return;
  const focusedId = document.activeElement?.id || "";
  renderedRevision = state.revision;
  latestState = state;
  void timeline.refresh();
  observedCli?.render(state);
  renderHumanMetrics.render(state);
  if (state.revision !== humanMetricsRevision) {
    humanMetricsRevision = state.revision;
    void renderHumanMetrics.reload();
  }
  renderInstructions(state);
  renderNotifications(state);
  renderCosts(state);
  renderCatalog();
  renderAgentUi(state);
  renderProviderStatuses($("provider-status"), state.provider_statuses, node);
  renderBudget($("budget-admission"), state, node);
  renderDecisions(state);
  updateOverview(state);
  renderHumanAnnotations(state);
  const focusedEventSequence = requestedDeepLink.status === "target" &&
    requestedDeepLink.kind === "event" && requestedDeepLink.projectId === state.project.id
    ? requestedDeepLink.id
    : null;
  const summarySources = renderUpdateSummary(state);
  summarySourceRecords = summarySources.records;
  renderReports(
    { ...state, change_records: summarySourceRecords },
    Date.now(),
    summarySources.sourceEventIds,
    previewArtifact,
    makeDeepLink,
    focusedEventSequence,
  );
  renderReviewEvidence($("review-evidence"), state, node);
  for (const task of state.tasks) {
    const title = document.getElementById("task-" + task.id)?.children[2];
    title?.append(renderTaskContract(task, state, node));
  }
  renderOperations(state, $("policy-checks"), $("approvals"), {
    node,
    api,
    refreshState,
  });
  const unanswered = state.questions.filter((question) => question.answer === null);
  renderTaskOutcomes(state);
  const deviceCapabilities = new Set(deviceAccess?.capabilities || []);
  renderQuestionCards($("questions"), unanswered, state.question_contracts, {
    node,
    api,
    refreshState,
    canReply:
      deviceAccess?.role !== "device" || deviceCapabilities.has("reply"),
    canControl:
      deviceAccess?.role !== "device" || deviceCapabilities.has("control"),
    makeDeepLink,
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
        const link = deepLinkButton(node, makeDeepLink, "question", question.id, `質問 ${question.id}`);
        if (link) element.append(link);
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
  renderAttention(state);
  applyDeepLink(state);
  const restoredFocus = focusedId ? $(focusedId) : null;
  if (restoredFocus) {
    if (restoredFocus.tabIndex < 0) restoredFocus.tabIndex = -1;
    restoredFocus.focus({ preventScroll: true });
  }
  $("connection").textContent = text("connection.connected");
  $("updated").textContent =
    text("updated.prefix", { time: state.updated_at ? formatDateTime(state.updated_at) : text("updated.none") });
}
const refreshPlans = createPlanPanel($("execution-plans"), api, node);
async function refreshState() {
  await refreshModelRouting();
  void refreshPlans();
}
let routingRefreshing = false;
async function refreshModelRouting() {
  if (routingRefreshing) return;
  routingRefreshing = true;
  try {
    render(await api("state"));
    if (!initialSourceFocused) {
      focusCurrentSource();
      initialSourceFocused = true;
    }
  } catch (e) {
    $("connection").textContent = e.message;
    $("overview-state").textContent = text("overview.refreshFailed");
  }
  try {
    renderModelRouting(
      $("model-routing"),
      (await api("model-routing")).runs,
      node,
    );
  } catch {
    $("model-routing").replaceChildren(
      node(
        "p",
        "モデルの照合履歴を取得できません。現在のモデルは未確認です。",
        "sub",
      ),
    );
  } finally {
    routingRefreshing = false;
  }
}
setInterval(() => {
  if (!document.hidden) void refreshModelRouting();
}, 5000);
let qrObjectUrl = null;
let initialSourceFocused = false;
async function renderShare(config) {
  if (config.device_access?.role === "device") {
    $("share-toggle").hidden = true;
    $("share").hidden = true;
    return;
  }
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
// 入力欄での誤発動を避け、検索・選択・取消しとフォーカス復帰を扱う。
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
let paletteMatches = [];
let paletteSelectedIndex = -1;
let paletteCommandAfterClose = null;
function setPaletteSelection(index) {
  if (!paletteMatches.length) {
    paletteSelectedIndex = -1;
    $("palette-search").removeAttribute("aria-activedescendant");
    $("palette-count").textContent = "該当なし";
    return;
  }
  paletteSelectedIndex = (index + paletteMatches.length) % paletteMatches.length;
  const command = paletteMatches[paletteSelectedIndex];
  const options = $("palette-list").querySelectorAll('[role="option"]');
  options.forEach((option, optionIndex) =>
    option.setAttribute(
      "aria-selected",
      String(optionIndex === paletteSelectedIndex),
    ),
  );
  $("palette-search").setAttribute(
    "aria-activedescendant",
    `palette-option-${command.id}`,
  );
  $("palette-count").textContent =
    `${paletteSelectedIndex + 1} / ${text("palette.count", { count: paletteMatches.length })} · ` +
    `${text(command.label)}`;
}
function renderPalette(filter = "") {
  const query = filter.trim().toLowerCase();
  paletteMatches = paletteCommands.filter(
    (command) =>
      !query ||
      (searchText(command.label) + " " + command.keys)
        .toLowerCase()
        .includes(query),
  );
  $("palette-list").replaceChildren(
    ...paletteMatches.map((command, index) => {
      const item = node("li", text(command.label));
      item.id = `palette-option-${command.id}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.addEventListener("pointermove", () => {
        if (paletteSelectedIndex !== index) setPaletteSelection(index);
      });
      item.addEventListener("click", () => activatePalette(index));
      return item;
    }),
  );
  setPaletteSelection(0);
}
function activatePalette(index = paletteSelectedIndex) {
  const command = paletteMatches[index];
  if (!command) return;
  paletteCommandAfterClose = command;
  $("palette").close();
}
function openPalette() {
  const active = document.activeElement;
  paletteReturnFocus =
    active && active !== document.body && active.isConnected
      ? active
      : $("palette-toggle");
  paletteCommandAfterClose = null;
  $("palette-search").value = "";
  $("palette-search").setAttribute("aria-expanded", "true");
  $("palette-toggle").setAttribute("aria-expanded", "true");
  renderPalette("");
  $("palette").showModal();
  $("palette-search").focus();
}
$("palette-toggle").addEventListener("click", openPalette);
$("palette-search").addEventListener("input", (event) =>
  renderPalette(event.target.value),
);
$("palette-search").addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setPaletteSelection(paletteSelectedIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setPaletteSelection(paletteSelectedIndex - 1);
  } else if (event.key === "Enter" && paletteSelectedIndex >= 0) {
    event.preventDefault();
    activatePalette();
  } else if (event.key === "Escape") {
    event.preventDefault();
    $("palette").close();
  }
});
$("palette").addEventListener("close", () => {
  $("palette-search").setAttribute("aria-expanded", "false");
  $("palette-search").removeAttribute("aria-activedescendant");
  $("palette-toggle").setAttribute("aria-expanded", "false");
  const returnFocus = paletteReturnFocus;
  const command = paletteCommandAfterClose;
  paletteReturnFocus = null;
  paletteCommandAfterClose = null;
  if (returnFocus?.isConnected && returnFocus.focus) returnFocus.focus();
  command?.run();
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    if ($("palette").open) {
      event.preventDefault();
      $("palette").close();
      return;
    }
    const tag = document.activeElement?.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      document.activeElement?.isContentEditable
    )
      return;
    event.preventDefault();
    openPalette();
  }
});
try {
  const config = await api("config");
  deviceAccess = config.device_access;
  await setupDeviceAccess({ api, config, base });
  if (config.kind === "project") observedCli = setupObservedCli({ api });
  restoreWorkspaceLayout(config.project?.id);
  if (deviceAccess?.role !== "device") await renderShare(config);
  if (config.kind === "harness") {
    $("connection-detail").hidden = true;
    $("kind").textContent = "DEEPSEEK HARNESS";
    $("title").textContent = text("app.harnessTitle");
    $("location").textContent = text("app.harnessLocation");
    $("project-content").hidden = true;
    $("harness").hidden = false;
    $("harness-open").href = config.harness_url || "#";
    $("harness-open").hidden = deviceAccess?.role === "device";
    $("connection").textContent = text("app.harnessConnection");
    if (deviceAccess?.role !== "device") {
      $("share").hidden = false;
      $("share-toggle").setAttribute("aria-expanded", "true");
    }
    let stopRequested = false;
    let pendingStop = null;
    const refreshManaged = async () => {
      try {
        const value = await api("managed-process"),
          scope = value.scope;
        renderManagedRunHealth($("managed-health"), value.diagnostic, node);
        const labels = {
          running: text("status.running"), stopping: text("status.stopping"),
          exit_confirmed: text("status.exitConfirmed"), unverifiable: text("status.unverifiable"),
        };
        $("managed-status").textContent =
          labels[scope?.status] ?? text("status.none");
        $("managed-provider").textContent = value.provider
          ? text("managed.provider", {
              provider: value.provider.label,
              connection: value.provider.capabilities.connection,
              stop: value.provider.capabilities.stop,
            })
          : "";
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
        $("harness-open").hidden =
          deviceAccess?.role === "device" || scope?.status === "exit_confirmed";
      } catch {
        $("managed-status").textContent =
          text("managed.monitorFailed");
        renderManagedRunHealth($("managed-health"), null, node);
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
    await refreshProfiles();
    $("cross-project-overview").hidden = !config.project_overview_enabled;
    $("cross-project-search").hidden = !config.project_search_enabled;
    if (config.project_overview_enabled) {
      await refreshProjectCrossOverview();
      setInterval(refreshProjectCrossOverview, 15000);
    }
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
