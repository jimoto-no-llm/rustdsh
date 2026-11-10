import http from "node:http";
import { loadProductLocale } from "./product-locale.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  ProjectStore,
  writeJson,
  stateHome,
  publicState,
  publicChangeRecords,
  identity,
} from "./state.mjs";
import { acquireProjectIdentityLock } from "./project-identity.mjs";
import { writeOwnerCredentials } from "./private-runtime.mjs";
import {
  InstructionQueueWorker,
  resolveRdshExecutable,
  supportsInstructionQueueServe,
} from "./instruction-queue-worker.mjs";
import { createMcpServer } from "./mcp.mjs";
import { enableShare, inspectShare } from "./tailscale.mjs";
import { startHarness, proxyHarness, upgradeHarness } from "./harness.mjs";
import { EventsHub } from "./webhooks.mjs";
import { NotificationInbox } from "./notifications.mjs";
import { RunHistory } from "./run-history.mjs";
import { modernMcpHandler } from "./mcp2.mjs";
import { activeContract, checkContract } from "./contracts.mjs";
import { checkWorkerStart } from "./enforcement.mjs";
import { executeSandboxedOperation, probeSandbox } from "./worker-sandbox.mjs";
import { AnswerApplicationServer } from "./answer-application-server.mjs";
import { BudgetAdmissionServer } from "./budget-server.mjs";
import { HumanMetricsStore } from "./human-metrics.mjs";
import { createHistoryBackup, backupMaximum } from "./history-backup.mjs";
import { createArtifactPreview } from "./artifact-preview.mjs";
import { AcceptanceStore } from "./acceptance.mjs";
import { modelRoutingViews } from "./model-routing-view.mjs";
import { ExecutionPlans } from "./execution-plan.mjs";
import { readCausalTimeline } from "./causal-timeline.mjs";
import { inspectTaskOutcomes } from "./task-outcomes-view.mjs";
import { ObservedCliStore } from "./observed-cli.mjs";
import { ReviewEvidenceStore } from "./review-evidence.mjs";
import { WorkerWorkspaces } from "./workers.mjs";
import {
  acceptanceHandoffView,
  buildHandoff,
  handoffFreshness,
  handoffResource,
  isHandoffPacket,
} from "./handoffs.mjs";
import { createProjectCrossOverview } from "./project-cross-overview.mjs";
import { createProjectCrossSearch } from "./project-cross-search.mjs";
import {
  emptyProfileCatalog,
  previewProjectProfile,
} from "./project-profiles.mjs";
import {
  ConnectionObservations,
  connectionReport,
  inspectTunnel,
} from "./connection-diagnostics.mjs";
import { HumanAnnotationStore } from "./human-annotations.mjs";
import { inspectGitHubStatus } from "./github-status.mjs";
import { DeviceRegistry } from "./devices.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const handoffMaximum = 1024 * 1024;
// Only these paths are served without any credential; every other route is
// checked below (device credentials stay scoped to the management API).
const dashboardAssets = new Set([
  "/",
  "/app.mjs",
  "/locale.mjs",
  "/locale-details.mjs",
  "/devices-ui.mjs",
  "/provider-status.mjs",
  "/provider-status-ui.mjs",
  "/run-health-ui.mjs",
  "/execution-plan-ui.mjs",
  "/contract-view.mjs",
  "/causal-timeline-ui.mjs",
  "/notifications-ui.mjs",
  "/deep-links.mjs",
  "/deep-link-ui.mjs",
  "/decision-log-ui.mjs",
  "/human-annotations-ui.mjs",
  "/annotation-identifiers.mjs",
  "/model-catalog-ui.mjs",
  "/github-status-ui.mjs",
  "/task-outcomes-ui.mjs",
  "/observed-cli-ui.mjs",
  "/view-mode.mjs",
  "/observations.mjs",
  "/reports-view.mjs",
  "/question-cards-ui.mjs",
  "/project-overview.mjs",
  "/connection-diagnostics-ui.mjs",
  "/answer-applications-ui.mjs",
  "/instruction-queue-ui.mjs",
  "/cost-ledger-ui.mjs",
  "/budget-ui.mjs",
  "/attention.mjs",
  "/attention-view.mjs",
  "/update-summary.mjs",
  "/model-routing-ui.mjs",
  "/review-evidence-ui.mjs",
  "/human-metrics-ui.mjs",
  "/ui/registry.mjs",
  "/ui/blocks.mjs",
  "/ui/state-adapter.mjs",
  "/favicon.ico",
  "/icon.png",
  "/icon.svg",
]);
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const forwardingHeaders = ["forwarded", "x-forwarded-for", "x-forwarded-host"];
// Exclusive live-instance lock: stale-lock reclamation is serialized
// in-process, cross-process steals use an atomic rename, and cleanup only
// removes a lock owned by this starter (`pid:token`).
let dashboardLockQueue = Promise.resolve();
function parseDashboardLock(content) {
  const text = String(content ?? "").trim();
  const sep = text.indexOf(":");
  if (sep === -1) return { pid: Number(text), token: null };
  return { pid: Number(text.slice(0, sep)), token: text.slice(sep + 1) };
}
function dashboardPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
export async function removeDashboardLockIfOwned(lockFile, ownedContent) {
  let current = null;
  try {
    current = await fs.readFile(lockFile, "utf8");
  } catch {
    return false;
  }
  if (current !== ownedContent) return false;
  try {
    await fs.unlink(lockFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return true;
}
export async function acquireDashboardLock(lockFile, ownedContent) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fs.writeFile(lockFile, ownedContent, { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let existing = null;
    try {
      existing = await fs.readFile(lockFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (dashboardPidAlive(parseDashboardLock(existing).pid)) {
      throw new Error(
        "This dashboard is already running; use rdsh-dashboard open with the same project",
      );
    }
    const backup = `${lockFile}.stale.${process.pid}.${randomUUID()}`;
    try {
      await fs.rename(lockFile, backup);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    let stolen = null;
    try {
      stolen = await fs.readFile(backup, "utf8");
    } catch {
      stolen = null;
    }
    if (stolen !== existing) {
      if (stolen !== null) {
        try {
          await fs.writeFile(lockFile, stolen, { flag: "wx", mode: 0o600 });
          await fs.unlink(backup).catch(() => {});
        } catch (restoreError) {
          if (restoreError?.code !== "EEXIST") throw restoreError;
          await fs.unlink(backup).catch(() => {});
        }
      } else {
        await fs.unlink(backup).catch(() => {});
      }
      continue;
    }
    await fs.unlink(backup).catch(() => {});
  }
  throw new Error("Could not acquire dashboard lock");
}
function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
async function readBody(req, maximum = 131072) {
  let size = 0,
    chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
export async function startDashboard(options) {
  const { kind = "project", tailscale = true, overviewProjects = [] } = options;
  const displayLocale = await loadProductLocale(
    options.language,
    options.environment ?? process.env,
  );
  let project = options.project;
  if (
    !Array.isArray(overviewProjects) ||
    (overviewProjects.length && kind !== "project") ||
    overviewProjects.length > 31
  )
    throw new Error("Cross-project overview is available only in project mode");
  // Managed projects live in <home>/projects/<id> and can be remapped by a
  // project move; callers that pass an explicit state directory keep it.
  const managedLayout =
    kind === "project" &&
    path.basename(path.dirname(project?.directory || "")) === "projects";
  const projectHome = managedLayout
    ? path.dirname(path.dirname(project.directory))
    : stateHome();
  let port, directory, lockFile, lockContent;
  let releaseIdentityLock;
  try {
    if (managedLayout && /^[0-9a-f]{16}$/.test(project?.id || "")) {
      releaseIdentityLock = await acquireProjectIdentityLock(projectHome);
      project = await identity(project.root, projectHome);
    }
    port =
      options.port ??
      (kind === "harness"
        ? 38081
        : 38100 + (parseInt(project.id.slice(0, 4), 16) % 1000));
    directory =
      kind === "project" ? project.directory : path.join(stateHome(), "harness");
    await fs.mkdir(directory, { recursive: true });
    // The identity lock makes migration and server startup mutually exclusive;
    // the exclusive live-instance lock never launches two writers for one project.
    lockFile = path.join(directory, "server.lock");
    lockContent = `${process.pid}:${randomUUID()}`;
    const acquisition = dashboardLockQueue.then(
      () => acquireDashboardLock(lockFile, lockContent),
      () => acquireDashboardLock(lockFile, lockContent),
    );
    dashboardLockQueue = acquisition.catch(() => {});
    await acquisition;
  } catch (error) {
    await releaseIdentityLock?.();
    throw error;
  }
  await releaseIdentityLock?.();
  const githubStatusInspector =
    options.githubStatusInspector || inspectGitHubStatus;
  const token = randomBytes(32).toString("hex"); // local administrator
  const mcpToken = randomBytes(32).toString("hex");
  const browserToken = randomBytes(32).toString("hex");
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const connections = new ConnectionObservations();
  let localUrl = `http://127.0.0.1:${port}/`;
  const cookieName = `rdsh_${kind === "project" ? project.id : "harness"}`;
  let store, eventsHub, devices, notificationInbox, runHistory, humanAnnotations, humanMetrics, observedCli, instructionQueueWorker, reviewEvidence, projectCrossOverview, projectCrossSearch;
  try {
    if (kind === "project") {
      instructionQueueWorker = options.instructionQueueWorker || null;
      // Keep the JSONL subprocess experimental until it meets the live
      // mutation latency gate; tests and benchmarks can still opt in.
      if (
        !instructionQueueWorker &&
        process.env.RDSH_DASHBOARD_RUST_INSTRUCTION_QUEUE === "1"
      ) {
        const executable = await resolveRdshExecutable();
        if (executable && (await supportsInstructionQueueServe(executable)))
          instructionQueueWorker = new InstructionQueueWorker(executable);
      }
      store = await ProjectStore.open(project, { instructionQueueWorker });
    } else store = null;
    devices =
      store || kind === "harness"
        ? await DeviceRegistry.open(path.join(directory, "devices.json"))
        : null;
    humanAnnotations = store ? await HumanAnnotationStore.open(project) : null;
    humanMetrics = store ? await HumanMetricsStore.open(project) : null;
    reviewEvidence = store ? await ReviewEvidenceStore.open(project) : null;
    eventsHub = store
      ? await EventsHub.open(project, () => store.value, options.webhookPost)
      : null;
    if (overviewProjects.length) {
      const readProjectState = async (target) =>
        target.id === project.id
          ? store.value
          : JSON.parse(
              await fs.readFile(
                path.join(target.directory, "state.json"),
                "utf8",
              ),
            );
      projectCrossOverview = createProjectCrossOverview(
        [project, ...overviewProjects],
        path.join(directory, "project-cross-overview.json"),
        { readState: readProjectState },
      );
      projectCrossSearch = createProjectCrossSearch(
        [project, ...overviewProjects],
        { readState: readProjectState },
      );
    }
    notificationInbox = store ? await NotificationInbox.open(project) : null;
    runHistory = store ? new RunHistory(project) : null;
    observedCli = store
      ? await ObservedCliStore.open(project, {
          observe: options.observeExternalCli,
        })
      : null;
  } catch (error) {
    await instructionQueueWorker?.close().catch(() => {});
    await removeDashboardLockIfOwned(lockFile, lockContent).catch(() => {});
    throw error;
  }
  const live = new Map(),
    sessions = new Map();
  const sockets = new Set();
  const applications = store
    ? new AnswerApplicationServer(project, () => store.value, mutateReply)
    : null;
  let runHistoryCache = null;
  const readRunHistory = async () => {
    let stat;
    try {
      stat = await fs.stat(runHistory.file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const history = await runHistory.read();
      runHistoryCache = { size: 0, mtimeMs: null, history };
      return history;
    }
    if (
      runHistoryCache?.size === stat.size &&
      runHistoryCache.mtimeMs === stat.mtimeMs
    ) {
      if (runHistoryCache.error) throw runHistoryCache.error;
      return runHistoryCache.history;
    }
    try {
      const history = await runHistory.read();
      runHistoryCache = { size: stat.size, mtimeMs: stat.mtimeMs, history };
      return history;
    } catch (error) {
      runHistoryCache = { size: stat.size, mtimeMs: stat.mtimeMs, error };
      throw error;
    }
  };
  const visibleState = async (includeNotifications = false) => {
    const current = store.value;
    const state = publicState(
      current,
      await applications.observations(),
      eventsHub.deliveries(),
      budgets.observations(),
    );
    if (reviewEvidence)
      state.review_evidence = await reviewEvidence.list({ tasks: store.value.tasks });
    if (!includeNotifications || !notificationInbox) return state;
    let historyEvents = [],
      runHistoryStatus = "available";
    try {
      const history = await readRunHistory();
      historyEvents = history.events;
      if (history.tail_bytes) runHistoryStatus = "incomplete";
    } catch {
      runHistoryStatus = "unavailable";
    }
    return {
      ...state,
      notifications: notificationInbox.snapshot(
        current,
        Date.now(),
        historyEvents,
        runHistoryStatus,
      ),
    };
  };
  const budgets = store ? new BudgetAdmissionServer(mutateBudget) : null;
  const modern = store
    ? modernMcpHandler(
        {
          getState: visibleState,
          mutate,
          createHandoff,
          getHandoff,
          getAcceptance,
          checkContract: preflight,
          checkOperation: policyCheck,
          requestApproval,
          checkApproval: approvalCheck,
          claimApproval: approvalClaim,
          executeApproval,
          checkWorkerStart: workerStartCheck,
          presentUi: mutateUiSurface,
          recordReview,
        },
        eventsHub,
        connections,
      )
    : null;
  const deliveryTimer = eventsHub
    ? setInterval(() => {
        void eventsHub.flush().catch(() => {});
      }, 2000)
    : null;
  deliveryTimer?.unref();
  let harness = null;
  let humanMetricsWarning = null;
  let lastManagedPollAt = null;
  let share = {
    state: "disabled",
    message: "ローカル接続のみ。Tailscale共有は起動時に有効にできます。",
    url: null,
  };
  let updateQueue = Promise.resolve();
  let refreshPromise = null;
  let closing = false;
  let closePromise = null;
  // Parsed once per share change; the old code rebuilt the Set and parsed
  // the share URL on every request (twice per request via trusted()).
  let originsCache = null;
  const allowedOrigins = () => {
    if (!originsCache) {
      originsCache = {
        origins: new Set([
          localUrl.slice(0, -1),
          `http://localhost:${port}`,
          ...(share.url ? [new URL(share.url).origin] : []),
        ]),
        hosts: new Set(
          [
            localUrl.slice(0, -1),
            `http://localhost:${port}`,
            ...(share.url ? [new URL(share.url).origin] : []),
          ].map((o) => new URL(o).host),
        ),
      };
    }
    return originsCache;
  };
  function browserAuthorized(req, url, route) {
    if (kind === "project")
      return (
        equal(req.headers["x-rdsh-browser-token"], browserToken) ||
        (route === "/api/live" &&
          equal(url.searchParams.get("key"), browserToken))
      );
    return (req.headers.cookie || "").split(";").some((item) => {
      const [name, value] = item.trim().split("=");
      return name === cookieName && equal(value, browserToken);
    });
  }
  async function browserIdentity(req, url, route) {
    if (browserAuthorized(req, url, route))
      return { role: "owner", capabilities: ["read", "reply", "control"] };
    if (!devices) return null;
    const credential =
      req.headers["x-rdsh-browser-token"] ||
      (route === "/api/live" ? url.searchParams.get("key") : null);
    return devices.authenticate(credential);
  }
  function deviceCanAccess(method, route, identity, dashboardKind) {
    if (identity?.role !== "device") return true;
    const capabilities = new Set(identity.capabilities);
    if (!capabilities.has("read")) return false;
    if (method === "GET") {
      if (route === "/api/qr.svg") return false;
      if (dashboardKind === "harness")
        return (
          dashboardAssets.has(route) ||
          ["/api/config", "/api/managed-process"].includes(route)
        );
      return true;
    }
    if (method !== "POST") return false;
    if (dashboardKind === "harness")
      return route === "/api/managed-stop" && capabilities.has("control");
    if (
      ["/api/update/answer", "/api/instructions/resolve"].includes(route)
    )
      return capabilities.has("reply");
    if (
      [
        "/api/decision/cancel",
        "/api/instructions/submit",
      ].includes(route)
    )
      return capabilities.has("control");
    return false;
  }
  function trusted(req) {
    const host = req.headers.host;
    const allowed = allowedOrigins();
    return (
      allowed.hosts.has(host) &&
      (!req.headers.origin || allowed.origins.has(req.headers.origin))
    );
  }
  function directLoopback(req) {
    return (
      loopbackAddresses.has(req.socket.remoteAddress) &&
      forwardingHeaders.every((name) => req.headers[name] === undefined)
    );
  }
  function browserUrl(base, root = false) {
    const url = new URL(kind === "harness" && !root ? "_rdsh/" : "", base);
    if (kind === "project") url.hash = `key=${browserToken}`;
    else url.searchParams.set("rdsh_dashboard_key", browserToken);
    if (kind === "harness" && root && harness) {
      for (const [key, value] of harness.url.searchParams)
        url.searchParams.set(key, value);
      url.hash = harness.url.hash;
      url.searchParams.set("rdsh_dashboard_key", browserToken);
    }
    return url.href;
  }
  async function persistRuntime() {
    await writeJson(path.join(directory, "runtime.json"), {
      schema: 1,
      kind,
      project_id: project?.id || null,
      instance_id: instanceId,
      pid: process.pid,
      port,
      local_url: localUrl,
      mcp_token: mcpToken,
      share,
    }, { retryWindowsRename: true });
    await writeOwnerCredentials(directory, {
      schema: 1,
      kind,
      project_id: project?.id || null,
      instance_id: instanceId,
      browser_url: browserUrl(localUrl),
      browser_token: browserToken,
      admin_token: token,
    });
    if (kind === "project") {
      await writeJson(path.join(directory, "mcp-config.json"), {
        mcpServers: {
          [`dashboard-${project.id}`]: {
            command: process.execPath,
            args: [
              path.join(here, "cli.mjs"),
              "mcp",
              "--project",
              project.root,
            ],
            env: { RDSH_DASHBOARD_HOME: path.resolve(stateHome()) },
          },
        },
      });
      await writeJson(path.join(directory, "mcp-http-config.json"), {
        mcpServers: {
          [`dashboard-${project.id}`]: {
            type: "http",
            url: `${share.url || localUrl}mcp`,
            headers: { Authorization: `Bearer ${mcpToken}` },
          },
        },
      });
    }
  }
  async function refreshShare() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      share = tailscale ? await enableShare(port) : share;
      originsCache = null; // share.url changed; reparsed on next request
      await persistRuntime();
      return share;
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }
  let diagnosticPromise = null;
  async function diagnostics() {
    if (diagnosticPromise) return diagnosticPromise;
    diagnosticPromise = (async () => {
      const [currentShare, tunnel] = await Promise.all([
        tailscale
          ? (options.inspectShare || inspectShare)(port)
          : { state: "disabled", observed_at: new Date().toISOString() },
        inspectTunnel(project, instanceId),
      ]);
      return connectionReport({
        project,
        startedAt,
        browser: connections.snapshot("browser_auth"),
        mcp: {
          authentication: connections.snapshot("mcp_auth"),
          discovery: connections.snapshot("server/discover"),
          tools: connections.snapshot("tools/list"),
          events: connections.snapshot("events/list"),
        },
        share: currentShare,
        tunnel,
        events: eventsHub.diagnostics(),
      });
    })();
    try {
      return await diagnosticPromise;
    } finally {
      diagnosticPromise = null;
    }
  }
  async function mutate(operation, input, authority = "agent") {
    if (!store)
      throw new Error("Project operations are unavailable in Harness mode");
    const task = updateQueue.then(async () => {
      const state = await store.mutate(operation, input, authority);
      for (const response of live.keys())
        response.write(`event: changed\ndata: ${state.revision}\n\n`);
      for (const { mcp } of sessions.values()) void mcp.notify();
      void eventsHub.flush().catch(() => {});
      return visibleState();
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  async function inspectAcceptance(taskId) {
    if (!project || !store)
      throw new Error("Acceptance inspection is unavailable in Harness mode");
    return (await AcceptanceStore.open(project)).inspect(taskId);
  }
  async function loadHandoff() {
    if (!project || !store)
      throw new Error("Handoff packets are unavailable in Harness mode");
    const file = path.join(project.directory, "handoff.json");
    let bytes;
    try {
      bytes = await fs.readFile(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (bytes.length > handoffMaximum)
      throw new Error("Stored handoff packet exceeds the size limit");
    const packet = JSON.parse(bytes.toString("utf8"));
    if (!isHandoffPacket(packet))
      throw new Error("Stored handoff packet is invalid; create a new packet");
    return packet;
  }
  async function getHandoff() {
    const packet = await loadHandoff();
    if (!packet) return handoffResource(null);
    const [state, acceptance] = await Promise.all([
      visibleState(),
      inspectAcceptance(packet.task_id),
    ]);
    return handoffResource(packet, handoffFreshness(packet, state, acceptance));
  }
  async function getAcceptance() {
    const packet = await loadHandoff();
    if (!packet)
      return {
        schema: 1,
        status: "unknown",
        reason: "handoff_packet_not_created",
      };
    return acceptanceHandoffView(await inspectAcceptance(packet.task_id));
  }
  async function createHandoff(taskId) {
    if (!store || !project)
      throw new Error("Handoff packets are unavailable in Harness mode");
    const task = updateQueue.then(async () => {
      const state = await visibleState();
      const acceptance = await inspectAcceptance(taskId);
      const packet = buildHandoff(state, taskId, acceptance);
      packet.snapshot_revision = state.revision + 1;
      if (
        Buffer.byteLength(JSON.stringify(packet, null, 2) + "\n") > handoffMaximum
      )
        throw new Error("Handoff packet exceeds the size limit");
      const committed = await store.recordHandoff();
      packet.snapshot_revision = committed.revision;
      await writeJson(path.join(project.directory, "handoff.json"), packet);
      for (const response of live.keys())
        response.write(`event: changed\ndata: ${store.value.revision}\n\n`);
      for (const { mcp } of sessions.values()) void mcp.notify();
      void eventsHub.flush().catch(() => {});
      const currentState = await visibleState();
      const currentAcceptance = await inspectAcceptance(taskId);
      return handoffResource(
        packet,
        handoffFreshness(packet, currentState, currentAcceptance),
      );
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  async function recordReview(input) {
    if (!reviewEvidence || !project)
      throw new Error("Review evidence is unavailable in Harness mode");
    const task = updateQueue.then(async () => {
      const workerInspection = await WorkerWorkspaces.open(project).then((workers) =>
        workers.inspect(),
      );
      const saved = await reviewEvidence.record(input, {
        state: store.value,
        workerInspection,
      });
      for (const response of live.keys())
        response.write(`event: changed\ndata: ${store.value.revision}\n\n`);
      for (const { mcp } of sessions.values()) void mcp.notify();
      const evidence = await reviewEvidence.list({
        tasks: store.value.tasks,
        taskId: saved.report.task_id,
      });
      const report = evidence.reports.find(
        (item) => item.review_id === saved.report.review_id,
      );
      return {
        revision: saved.revision,
        idempotent: saved.idempotent,
        report,
      };
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  async function mutateReply(operation, input, context) {
    const task = updateQueue.then(async () => {
      const result = await store.mutateReply(operation, input, context);
      if (
        operation === "instruction_submit" &&
        result?.request?.review_reason === "queue_revision_changed"
      ) {
        try {
          await humanMetrics.recordQueueRevisionConflict();
          humanMetricsWarning = null;
        } catch {
          humanMetricsWarning = "競合の計測をローカルに保存できませんでした。";
        }
      }
      for (const response of live.keys())
        response.write(`event: changed\ndata: ${store.value.revision}\n\n`);
      for (const { mcp } of sessions.values()) void mcp.notify();
      return result;
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  async function mutateBudget(operation, input) {
    const task = updateQueue.then(async () => {
      const result = await store.mutateBudget(operation, input);
      for (const response of live.keys())
        response.write(`event: changed\ndata: ${store.value.revision}\n\n`);
      for (const { mcp } of sessions.values()) void mcp.notify();
      return result;
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  // rdsh-ui/1: the agent presents a surface through MCP, and a human action
  // returns to the same session as feedback. Both go through updateQueue so
  // live views and MCP subscribers see one ordered revision.
  async function mutateUiSurface(input) {
    const task = updateQueue.then(async () => {
      const result = await store.mutateUiSurface(input);
      for (const response of live.keys())
        response.write("event: changed\ndata: " + store.value.revision + "\n\n");
      for (const { mcp } of sessions.values()) void mcp.notify();
      return result;
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  async function mutateUiAction(input) {
    const task = updateQueue.then(async () => {
      const result = await store.mutateUiAction(input);
      for (const response of live.keys())
        response.write("event: changed\ndata: " + store.value.revision + "\n\n");
      for (const { mcp } of sessions.values()) void mcp.notify();
      void eventsHub.flush().catch(() => {});
      return result;
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  async function backupOperation(action, input) {
    const task = updateQueue.then(async () => {
      if (action === "history") {
        if (Object.keys(input).length)
          throw new Error("History takes no input");
        return {
          project_id: project.id,
          revision: store.value.revision,
          history_backups: structuredClone(store.value.history_backups || []),
        };
      }
      const acceptance = await (await AcceptanceStore.open(project)).read();
      if (action === "preview") {
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          !Object.hasOwn(input, "selection") ||
          Object.keys(input).some((k) => !["selection", "review"].includes(k))
        )
          throw new Error("Invalid backup preview fields");
        return createHistoryBackup(
          store.value,
          acceptance,
          input.selection,
          input.review,
        );
      }
      const result = await store.restoreBackup(
        input,
        acceptance.evidence.map((r) => r.evidence_id),
        acceptance.tasks.map((r) => r.id),
      );
      for (const response of live.keys())
        response.write(`event: changed\ndata: ${store.value.revision}\n\n`);
      for (const { mcp } of sessions.values()) void mcp.notify();
      return result;
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  async function preflight(input) {
    // Share the writer queue so the check observes preceding contract changes.
    const task = updateQueue.then(() => checkContract(store.value, input));
    updateQueue = task.catch(() => {});
    return task;
  }
  async function policyCheck(input) {
    const state = await mutate("policy", input);
    return state.policy_checks.at(-1);
  }
  async function requestApproval(input) {
    const state = await mutate("approval_request", input);
    return { id: input.id, ...state.approval_requests.find((item) => item.id === input.id).versions.at(-1) };
  }
  async function approvalCheck(input) {
    const state = await mutate("approval_check", input);
    return state.approval_checks.at(-1);
  }
  async function approvalClaim(input) {
    const state = await mutate("approval_claim", input);
    return state.approval_checks.at(-1);
  }
  async function workerStartCheck(input) {
    const probe = options.sandboxProbe || probeSandbox;
    const task = updateQueue.then(() => checkWorkerStart(store.value, input, { probe }));
    updateQueue = task.catch(() => {});
    return task;
  }
  async function executeApproval(input) {
    const checked = await approvalCheck(input);
    if (checked.decision !== "approval_valid") return checked;
    const probe = options.sandboxProbe || probeSandbox;
    const sandbox = await probe();
    if (!sandbox.supported)
      return { ...checked, decision: "hold", reason: sandbox.reason || "sandbox_probe_failed",
        execution: "not_started", enforcement: "not_applied", fallback: "disabled" };

    // Persist the one-use start before any tool side effect. A crash or lost
    // response leaves this attempt consumed and therefore non-replayable.
    const state = await mutate("approval_start", input);
    const started = state.approval_checks.at(-1);
    if (started.decision !== "approval_started") return started;
    const request = state.approval_requests
      ?.find((item) => item.id === input.id)?.versions
      ?.find((item) => item.version === input.request_version);
    const contract = activeContract(state, input.task_id);
    let executed;
    try {
      executed = await (options.sandboxExecutor || executeSandboxedOperation)({
        repository: contract?.repository, contract, workerRole: request.worker_role,
        input: input.operation, evaluated: started.attributes, capability: sandbox,
      });
    } catch {
      executed = { execution: "unknown", reason: "sandbox_executor_failed" };
    }
    const execution = ["completed", "failed"].includes(executed.execution)
      ? executed.execution : executed.execution === "not_started" ? "failed" : "unknown";
    const reason = /^[a-z][a-z0-9_]{0,119}$/.test(executed.reason || "")
      ? executed.reason : null;
    const exitCode = Number.isSafeInteger(executed.exit_code) &&
      executed.exit_code >= 0 && executed.exit_code <= 255 ? executed.exit_code : null;
    try {
      await mutate("approval_finish", { id: input.id, request_version: input.request_version,
        attempt: input.attempt, execution, reason, exit_code: exitCode });
    } catch {
      // Do not permit replay if the result could not be durably recorded.
      return { ...started, decision: "execution_unknown", reason: "execution_result_not_persisted",
        execution: "unknown" };
    }
    const output = {};
    for (const key of ["stdout", "stderr", "status", "content_type", "body", "signal"])
      if (executed[key] !== undefined) output[key] = executed[key];
    return { ...started, decision: "execution_finished", reason: reason || "execution_finished",
      execution, exit_code: exitCode, result: output };
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    try {
      if (!trusted(req))
        return json(res, 403, { error: "Untrusted host or origin" });
      const url = new URL(req.url, localUrl);
      if (
        kind === "harness" &&
        req.method === "GET" &&
        equal(url.searchParams.get("rdsh_dashboard_key"), browserToken)
      ) {
        url.searchParams.delete("rdsh_dashboard_key");
        const secure =
          share.url && req.headers.host === new URL(share.url).host
            ? "; Secure"
            : "";
        res.writeHead(303, {
          "set-cookie": `${cookieName}=${browserToken}; HttpOnly; SameSite=Strict; Path=/${secure}`,
          location: url.pathname + url.search,
        });
        return res.end();
      }
      const prefix = kind === "harness" ? "/_rdsh" : "";
      const route = url.pathname.startsWith(prefix + "/")
        ? url.pathname.slice(prefix.length)
        : null;
      const adminAuthorized = equal(
        req.headers.authorization,
        `Bearer ${token}`,
      );
      const agentRoute =
        ["/api/contracts/check", "/api/policy/check", "/api/workers/check", "/api/approvals/request", "/api/approvals/check", "/api/approvals/claim", "/api/approvals/execute"].includes(route) ||
        route === "/mcp" ||
        route === "/api/state" ||
        (req.method === "GET" &&
          ["/api/handoff", "/api/acceptance"].includes(route)) ||
        (req.method === "POST" && route === "/api/handoff/create") ||
        (req.method === "GET" && route === "/api/task-outcomes") ||
        route === "/api/instructions/context" ||
        (req.method === "POST" && route === "/api/instructions/submit") ||
        (req.method === "POST" &&
          ["metrics", "task", "question", "event", "ui_surface", "provider_status"].some(
            (operation) => route === `/api/update/${operation}`,
          ));
      const mcpAuthorized =
        kind === "project" &&
        agentRoute &&
        equal(req.headers.authorization, `Bearer ${mcpToken}`);
      const browserAccess = await browserIdentity(req, url, route);
      const humanAuthorized = Boolean(browserAccess);
      if (
        !adminAuthorized &&
        browserAccess?.role === "device" &&
        !deviceCanAccess(req.method, route, browserAccess, kind)
      )
        return json(res, 403, {
          error: "This device is not allowed to perform that operation",
        });
      if (kind === "project" && route === "/mcp")
        connections.record(
          "mcp_auth",
          mcpAuthorized,
          mcpAuthorized ? "authenticated" : "unauthorized",
        );
      if (
        kind === "project" &&
        ["/api/state", "/api/changes", "/api/config"].includes(route) &&
        (humanAuthorized || req.headers["x-rdsh-browser-token"])
      )
        connections.record(
          "browser_auth",
          humanAuthorized,
          humanAuthorized ? "authenticated" : "unauthorized",
          share.url && req.headers.host === new URL(share.url).host
            ? "tailscale"
            : "loopback",
        );
      const consumerRoute =
        kind === "project" &&
        ((req.method === "GET" && route === "/api/replies/read") ||
          (req.method === "POST" &&
            ["/api/replies/ack", "/api/replies/control"].includes(route)));
      const consumerToken = req.headers["x-rdsh-consumer-token"];
      const budgetProducerRoute =
        kind === "project" &&
        req.method === "POST" &&
        route?.startsWith("/api/budget/producer/");
      const budgetToken = req.headers["x-rdsh-budget-token"];
      const publicAsset =
        (kind === "project" || kind === "harness") &&
        req.method === "GET" &&
        dashboardAssets.has(route);
      // Device credentials are for the scoped management API only. They must not
      // turn into access to the proxied, fully interactive Harness application.
      if (
        kind === "harness" &&
        route === null &&
        browserAccess?.role === "device"
      )
        return json(res, 403, { error: "Harness UI requires its owner session" });
        (route === "/" ||
          route === "/app.mjs" ||
          route === "/locale.mjs" ||
          route === "/locale-details.mjs" ||
          route === "/deep-links.mjs" ||
          route === "/deep-link-ui.mjs" ||
          route === "/human-annotations-ui.mjs" ||
          route === "/annotation-identifiers.mjs" ||
          route === "/observations.mjs" ||
          route === "/reports-view.mjs" ||
          route === "/question-cards-ui.mjs" ||
          route === "/model-catalog-ui.mjs" ||
          route === "/project-overview.mjs" ||
          route === "/connection-diagnostics-ui.mjs" ||
          route === "/github-status-ui.mjs" ||
          route === "/answer-applications-ui.mjs" ||
          route === "/instruction-queue-ui.mjs" ||
          route === "/cost-ledger-ui.mjs" ||
          route === "/budget-ui.mjs" ||
          route === "/notifications-ui.mjs" ||
          route === "/task-outcomes-ui.mjs" ||
          route === "/observed-cli-ui.mjs" ||
          route === "/view-mode.mjs" ||
          route === "/favicon.ico" ||
          route === "/icon.png" ||
          route === "/icon.svg");
      if (
        !publicAsset &&
        !adminAuthorized &&
        !mcpAuthorized &&
        !humanAuthorized &&
        !(budgetProducerRoute && typeof budgetToken === "string") &&
        !(consumerRoute && typeof consumerToken === "string")
      )
        return json(res, 401, {
          error:
            "Open this dashboard through rdsh-dashboard open or its QR code",
        });
      if (closing) return json(res, 503, { error: "Dashboard is stopping" });
      if (devices && route === "/api/devices") {
        if (!adminAuthorized && browserAccess?.role !== "owner")
          return json(res, 403, { error: "Dashboard owner required" });
        if (req.method === "GET")
          return json(res, 200, { devices: devices.list() });
        if (req.method === "POST") {
          const input = await readBody(req, 4096);
          if (kind === "harness" && input.capabilities?.includes("reply"))
            return json(res, 400, {
              error: "Harness devices can only read or control the managed run",
            });
          const result = await devices.create(input);
          return json(res, 201, result);
        }
        return json(res, 405, { error: "Method not allowed" });
      }
      if (devices && route?.startsWith("/api/devices/")) {
        if (!adminAuthorized && browserAccess?.role !== "owner")
          return json(res, 403, { error: "Dashboard owner required" });
        const match = route.match(/^\/api\/devices\/([0-9a-f-]{36})$/);
        if (req.method !== "DELETE" || !match)
          return json(res, 404, { error: "Unknown device operation" });
        const device = await devices.revoke(match[1]);
        if (!device) return json(res, 404, { error: "Unknown device" });
        for (const [response, deviceId] of live) {
          if (deviceId === device.id) {
            response.end();
            live.delete(response);
          }
        }
        return json(res, 200, { device });
      }
      if (
        req.method === "GET" &&
        ["/favicon.ico", "/icon.png", "/icon.svg"].includes(route)
      ) {
        const [file, type] =
          route === "/favicon.ico"
            ? ["icon.ico", "image/x-icon"]
            : route === "/icon.png"
              ? ["icon-256.png", "image/png"]
              : ["icon.svg", "image/svg+xml"];
        const bytes = await fs.readFile(path.join(here, "../assets", file));
        res.writeHead(200, {
          "content-type": type,
          "x-content-type-options": "nosniff",
        });
        return res.end(bytes);
      }
      if (req.method === "GET" && route === "/api/managed-process") {
        if (!harness)
          return json(res, 200, { run_id: null, scope: null, stages: [] });
        const now = Date.now();
        const browserPollGapMs = !humanAuthorized || lastManagedPollAt === null
          ? null
          : Math.max(0, now - lastManagedPollAt);
        if (humanAuthorized) lastManagedPollAt = now;
        return json(
          res,
          200,
          await harness.inspect({ browser_poll_gap_ms: browserPollGapMs }),
        );
      }
      if (req.method === "POST" && route === "/api/managed-stop") {
        if (!harness)
          return json(res, 409, { error: "No owned Harness process" });
        if (!adminAuthorized && !humanAuthorized)
          return json(res, 401, {
            error: "Owner browser or administrator required",
          });
        void harness.stop().catch(() => {});
        return json(res, 202, { requested: true, run_id: harness.run_id });
      }
      if (req.method === "POST" && route === "/api/stop") {
        if (!adminAuthorized)
          return json(res, 401, {
            error: "Administrator bearer token required",
          });
        const result = harness ? await harness.stop() : null;
        if (result && !result.confirmed)
          return json(res, 409, {
            error:
              "Managed descendants are unverified; dashboard remains available",
            managed_stop: result,
          });
        res.once("finish", () => {
          void close().catch(() => {});
        });
        return json(res, 200, { stopping: true, managed_stop: result });
      }
      if (
        req.method === "POST" &&
        route === "/api/events/revoke" &&
        eventsHub
      ) {
        if (!adminAuthorized)
          return json(res, 401, {
            error: "Administrator bearer token required",
          });
        await eventsHub.revoke();
        return json(res, 200, { revoked: true });
      }
      if (req.method === "GET" && route === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end((await fs.readFile(path.join(here, "ui.html"), "utf8")).replaceAll("__RDSH_LOCALE__", displayLocale));
      }
      if (
        req.method === "GET" &&
        [
          "/app.mjs",
          "/locale.mjs",
          "/locale-details.mjs",
          "/attention.mjs",
          "/attention-view.mjs",
          "/devices-ui.mjs",
          "/contract-view.mjs",
          "/deep-links.mjs",
          "/deep-link-ui.mjs",
          "/human-annotations-ui.mjs",
          "/annotation-identifiers.mjs",
          "/observations.mjs",
          "/provider-status.mjs",
          "/provider-status-ui.mjs",
          "/reports-view.mjs",
          "/decision-log-ui.mjs",
          "/question-cards-ui.mjs",
          "/model-catalog-ui.mjs",
          "/project-overview.mjs",
          "/connection-diagnostics-ui.mjs",
          "/github-status-ui.mjs",
          "/answer-applications-ui.mjs",
          "/instruction-queue-ui.mjs",
          "/causal-timeline-ui.mjs",
          "/cost-ledger-ui.mjs",
          "/budget-ui.mjs",
          "/update-summary.mjs",
          "/model-routing-ui.mjs",
          "/review-evidence-ui.mjs",
          "/run-health-ui.mjs",
          "/execution-plan-ui.mjs",
          "/notifications-ui.mjs",
          "/task-outcomes-ui.mjs",
          "/observed-cli-ui.mjs",
          "/view-mode.mjs",
          "/ui/registry.mjs",
          "/ui/blocks.mjs",
          "/ui/state-adapter.mjs",
          "/model-catalog-ui.mjs",
          "/human-metrics-ui.mjs",
        ].includes(route)
      ) {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
        });
        return res.end(await fs.readFile(path.join(here, route.slice(1))));
      }
      if (kind === "project" && route === "/api/observed-cli") {
        if (!humanAuthorized)
          return json(res, 403, { error: "Dashboard owner browser required" });
        if (req.method === "GET")
          return json(res, 200, await observedCli.inspect(store.value));
        if (req.method === "POST") {
          const record = await observedCli.register(
            await readBody(req, 4096),
            store.value,
          );
          return json(res, 201, {
            process: {
              id: record.id,
              task_id: record.task_id,
              cli_kind: record.cli_kind,
              pid: record.pid,
              registered_at: record.registered_at,
            },
          });
        }
        return json(res, 405, { error: "Method not allowed" });
      }
      if (
        kind === "project" &&
        route?.startsWith("/api/observed-cli/")
      ) {
        if (!humanAuthorized)
          return json(res, 403, { error: "Dashboard owner browser required" });
        const match = route.match(/^\/api\/observed-cli\/([0-9a-f-]{36})$/);
        if (req.method !== "DELETE" || !match)
          return json(res, 404, { error: "Unknown observed CLI operation" });
        return json(
          res,
          200,
          await observedCli.unregister({ id: match[1] }),
        );
      }
      if (
        kind === "project" &&
        req.method === "GET" &&
        route === "/api/model-routing"
      )
        return json(res, 200, { runs: await modelRoutingViews(project) });
      if (
        kind === "project" &&
        req.method === "GET" &&
        route === "/api/diagnostics"
      )
        return json(res, 200, await diagnostics());
      if (
        kind === "project" &&
        req.method === "GET" &&
        route === "/api/run-diagnostics"
      ) {
        const history = new RunHistory(project);
        return json(
          res,
          200,
          await history.diagnoseRecent({
            uiConnection: humanAuthorized ? "connected" : "unknown",
          }),
        );
      }
      if (
        kind === "project" &&
        req.method === "GET" &&
        route === "/api/github/status"
      ) {
        if (!humanAuthorized)
          return json(res, 403, { error: "Human browser credential required" });
        return json(
          res,
          200,
          await githubStatusInspector({ cwd: project.directory }),
        );
      }
      if (req.method === "GET" && route === "/api/config")
        return json(res, 200, {
          kind,
          project_overview_enabled: Boolean(projectCrossOverview),
          project_search_enabled: Boolean(projectCrossSearch),
          instance_id: instanceId,
          device_access: browserAccess,
          project: project
            ? { id: project.id, name: project.name, root: project.root }
            : null,
          share,
          events: eventsHub?.status() || null,
          mcp_url: kind === "project" && share.url ? `${share.url}mcp` : null,
          harness_url: harness && browserAccess?.role !== "device"
            ? "/" + harness.url.search + harness.url.hash
            : null,
        });
      if (req.method === "POST" && route === "/api/share/refresh")
        return json(res, 200, await refreshShare());
      if (req.method === "GET" && route === "/api/qr.svg") {
        if (!share.url)
          return json(res, 409, { error: "Tailscale connection is not ready" });
        const svg = await QRCode.toString(
          browserUrl(share.url, kind === "harness"),
          { type: "svg", errorCorrectionLevel: "M", margin: 4, width: 280 },
        );
        res.writeHead(200, { "content-type": "image/svg+xml" });
        return res.end(svg);
      }
      if (kind === "project") {
        if (req.method === "GET" && route === "/api/plans")
          return json(res, 200, await ExecutionPlans.open(project).inspect());
        if (req.method === "POST" && route === "/api/plans/stop") {
          if (!adminAuthorized && !humanAuthorized)
            return json(res, 403, {
              error: "Human browser or administrator required",
            });
          const input = await readBody(req);
          if (
            !input ||
            Object.keys(input).length !== 1 ||
            typeof input.plan_id !== "string"
          )
            return json(res, 400, { error: "An exact plan_id is required" });
          await ExecutionPlans.open(project).stop(input.plan_id);
          return json(res, 200, await ExecutionPlans.open(project).inspect());
        }
        // The shared 401 gate above authenticates all project checks. Claiming
        // a retry/cost reservation additionally requires the execution credential.
        if (req.method === "POST" && route === "/api/contracts/update") {
          if (!adminAuthorized)
            return json(res, 403, { error: "Administrator bearer token required" });
          return json(res, 200, await mutate("contract", await readBody(req), "local_administrator"));
        }
        if (req.method === "POST" && route === "/api/contracts/check") {
          if (!(adminAuthorized || mcpAuthorized || humanAuthorized))
            return json(res, 403, { error: "Project credential required" });
          const result = await preflight(await readBody(req));
          return json(res, result.decision === "within_scope" ? 200 : 409, result);
        }
        if (req.method === "POST" && route === "/api/policy/check") {
          const result = await policyCheck(await readBody(req));
          return json(res, result.decision === "within_policy" ? 200 : 409, result);
        }
        if (req.method === "POST" && route === "/api/approvals/request")
          return json(res, 200, await requestApproval(await readBody(req)));
        if (req.method === "POST" && ["/api/approvals/check", "/api/approvals/claim"].includes(route)) {
          if (route.endsWith("claim") && !mcpAuthorized)
            return json(res, 403, { error: "Execution bearer token required" });
          const result = await (route.endsWith("claim") ? approvalClaim : approvalCheck)(await readBody(req));
          return json(res, result.decision === "approval_valid" ? 200 : 409, result);
        }
        if (req.method === "POST" && route === "/api/approvals/execute") {
          if (!mcpAuthorized)
            return json(res, 403, { error: "Execution bearer token required" });
          const result = await executeApproval(await readBody(req, 512 * 1024));
          return json(res, result.decision === "execution_finished" ? 200 : 409, result);
        }
        if (req.method === "POST" && route === "/api/approvals/decide") {
          if (!humanAuthorized) return json(res, 403, { error: "Owner browser credential required" });
          return json(res, 200, await mutate("approval_decision", await readBody(req), "browser_owner"));
        }
        if (req.method === "POST" && route === "/api/workers/check") {
          const result = await workerStartCheck(await readBody(req));
          return json(res, result.decision === "ready" ? 200 : 409, result);
        }
        if (req.method === "POST" && route?.startsWith("/api/backup/")) {
          if (!adminAuthorized || !directLoopback(req))
            return json(res, 403, {
              error:
                "Backup requires a local administrator credential and direct loopback access",
            });
          const action = route.slice("/api/backup/".length);
          if (!["preview", "restore", "history"].includes(action))
            return json(res, 404, { error: "Unknown backup operation" });
          return json(
            res,
            200,
            await backupOperation(
              action,
              await readBody(req, backupMaximum + 65536),
            ),
          );
        }
        if (req.method === "POST" && route?.startsWith("/api/budget/")) {
          if (!directLoopback(req))
            return json(res, 403, {
              error: "Budget control requires direct loopback access",
            });
          const action = route.slice("/api/budget/".length);
          const input = await readBody(req);
          if (budgetProducerRoute)
            return json(
              res,
              200,
              await budgets.producer(
                action.slice("producer/".length),
                input,
                budgetToken,
              ),
            );
          if (!adminAuthorized)
            return json(res, 403, {
              error:
                "Local administrator credential required for budget control",
            });
          if (action === "launch")
            return json(res, 200, await budgets.launch(input));
          if (action === "revoke")
            return json(res, 200, await budgets.revoke(input));
          if (action === "inspect")
            return json(
              res,
              200,
              (await visibleState()).budget_admission || null,
            );
          if (["policy", "usage"].includes(action))
            return json(res, 200, await mutateBudget(action, input));
          return json(res, 404, { error: "Unknown budget operation" });
        }
        if (req.method === "GET" && route === "/api/instructions/context")
          return json(
            res,
            200,
            await applications.instructionContext(
              url.searchParams.get("consumer_id"),
            ),
          );
        if (
          req.method === "POST" &&
          ["/api/instructions/submit", "/api/instructions/resolve"].includes(
            route,
          )
        ) {
          const resolve = route.endsWith("/resolve");
          if (resolve && !humanAuthorized && !adminAuthorized)
            return json(res, 403, { error: "Human confirmation required" });
          return json(
            res,
            200,
            await applications.instruction(
              await readBody(req),
              adminAuthorized
                ? "administrator"
                : mcpAuthorized
                  ? "management_agent"
                  : "human",
              resolve,
            ),
          );
        }
        if (req.method === "POST" && route === "/api/replies/register") {
          if (!adminAuthorized)
            return json(res, 403, {
              error: "Local administrator must bind the verified ACP owner",
            });
          return json(
            res,
            200,
            await applications.register(await readBody(req)),
          );
        }
        if (consumerRoute) {
          if (typeof consumerToken !== "string")
            return json(res, 403, {
              error: "Separate consumer credential required",
            });
          if (req.method === "GET")
            return json(
              res,
              200,
              await applications.read(
                url.searchParams.get("consumer_id"),
                consumerToken,
                Number(url.searchParams.get("after") || "0"),
              ),
            );
          return json(
            res,
            200,
            route.endsWith("/control")
              ? await applications.control(await readBody(req), consumerToken)
              : await applications.ack(await readBody(req), consumerToken),
          );
        }
        if (req.method === "POST" && route === "/api/decision/cancel") {
          if (!humanAuthorized)
            return json(res, 403, {
              error: "Owner browser credential required",
            });
          const input = await readBody(req);
          return json(
            res,
            200,
            await mutate("question", { ...input, action: "cancel" }),
          );
        }
        if (
          req.method === "POST" &&
          ["/api/notifications/read", "/api/notifications/preferences"].includes(route)
        ) {
          if (!humanAuthorized || !notificationInbox)
            return json(res, 403, { error: "Human browser credential required" });
          const input = await readBody(req, 8192);
          try {
            let history;
            try {
              history = await readRunHistory();
            } catch {
              return json(res, 503, { error: "run_history_unavailable" });
            }
            const result =
              route === "/api/notifications/read"
                ? await notificationInbox.markRead(
                    input,
                    store.value,
                    history.events,
                    history.tail_bytes ? "incomplete" : "available",
                  )
                : await notificationInbox.updatePreferences(
                    input,
                    store.value,
                    history.events,
                    history.tail_bytes ? "incomplete" : "available",
                  );
            return json(res, 200, result);
          } catch (error) {
            const status =
              error.code === "notification_changed"
                ? 409
                : error.code === "notification_not_found"
                  ? 404
                  : 400;
            return json(res, status, { error: error.code || "Invalid notification request" });
          }
        }
        if (req.method === "GET" && route === "/api/state")
          return json(res, 200, await visibleState(humanAuthorized));
        if (route === "/api/annotations") {
          if (!humanAnnotations)
            return json(res, 404, { error: "Project annotations are unavailable" });
          if (!humanAuthorized)
            return json(res, 403, { error: "Owner browser credential required" });
          if (req.method === "GET")
            return json(res, 200, await humanAnnotations.inspect(store.value));
          if (req.method === "POST") {
            const input = await readBody(req);
            if (!input || typeof input !== "object" || Array.isArray(input))
              return json(res, 400, { error: "Invalid annotation input" });
            const result =
              input.action === "delete"
                ? await humanAnnotations.remove(input)
                : input.action === "create"
                  ? await humanAnnotations.add(input, store.value)
                  : null;
            if (!result)
              return json(res, 400, { error: "Unknown annotation action" });
            return json(res, input.action === "create" ? 201 : 200, result);
          }
        }
        if (route === "/api/human-metrics") {
          if (!humanAuthorized || !humanMetrics)
            return json(res, 403, {
              error: "Human browser credential required",
            });
          if (req.method === "GET")
            return json(res, 200, {
              ...humanMetrics.snapshot(),
              warning: humanMetricsWarning,
            });
          if (req.method === "POST") {
            const input = await readBody(req);
            const task = updateQueue.then(async () => {
              const result = await humanMetrics.handle(input, store.value);
              humanMetricsWarning = null;
              return result;
            });
            updateQueue = task.catch(() => {});
            return json(res, 200, await task);
          }
          return json(res, 405, { error: "Method not allowed" });
        }
        if (req.method === "POST" && route === "/api/decision-log") {
          if (!humanAuthorized)
            return json(res, 403, {
              error: "Human browser credential required",
            });
          if (!store)
            return json(res, 404, { error: "Project decision log unavailable" });
          return json(
            res,
            200,
            await mutate("decision_log", await readBody(req)),
          );
        }
        if (req.method === "GET" && route === "/api/state")
          return json(res, 200, await visibleState());
        if (req.method === "GET" && route === "/api/changes") {
          if (!humanAuthorized && !adminAuthorized)
            return json(res, 403, {
              error: "Human browser credential required",
            });
          const rawAfter = url.searchParams.get("after_revision");
          const afterRevision = rawAfter === null ? 0 : Number(rawAfter);
          if (!Number.isSafeInteger(afterRevision) || afterRevision < 0)
            return json(res, 400, { error: "Invalid after_revision cursor" });
          return json(res, 200, publicChangeRecords(store.value, afterRevision));
        }
        if (
          kind === "project" &&
          req.method === "GET" &&
          route?.startsWith("/api/artifacts/")
        ) {
          const match = route.match(/^\/api\/artifacts\/(\d+)$/);
          if (!match)
            return json(res, 404, { error: "成果物の記録が見つかりません" });
          const preview = await createArtifactPreview(
            project,
            store.value.events,
            Number(match[1]),
          );
          if (preview.status !== 200)
            return json(res, preview.status, { error: preview.reason });
          res.writeHead(200, {
            "content-type": preview.mime,
            "content-disposition": 'inline; filename="artifact-preview"',
            "content-security-policy": "default-src 'none'; sandbox",
            "x-content-type-options": "nosniff",
            "cache-control": "private, no-store",
            "referrer-policy": "no-referrer",
            "x-rdsh-preview-kind": preview.kind,
            "x-rdsh-preview-redacted": String(preview.redacted),
            "x-rdsh-preview-truncated": String(preview.truncated),
            "content-length": String(preview.bytes.length),
          });
          return res.end(preview.bytes);
        }
        if (kind === "project" && req.method === "GET" && route === "/api/profiles") {
          if (!humanAuthorized)
            return json(res, 403, { error: "Human browser credential required" });
          return json(res, 200, store.value.profile_catalog || emptyProfileCatalog());
        }
        if (
          kind === "project" &&
          req.method === "POST" &&
          ["/api/profiles/save", "/api/profiles/activate"].includes(route)
        ) {
          if (!humanAuthorized)
            return json(res, 403, { error: "Human browser credential required" });
          const operation = route.endsWith("/save") ? "profile_save" : "profile_activate";
          await mutate(operation, await readBody(req));
          return json(res, 200, store.value.profile_catalog);
        }
        if (
          kind === "project" &&
          req.method === "POST" &&
          route === "/api/profiles/preview"
        ) {
          if (!humanAuthorized)
            return json(res, 403, { error: "Human browser credential required" });
          return json(
            res,
            200,
            previewProjectProfile(store.value, await readBody(req)),
          );
        }
        if (req.method === "GET" && route === "/api/projects/overview") {
          if (!humanAuthorized)
            return json(res, 403, {
              error: "Human browser credential required",
            });
          if (!projectCrossOverview)
            return json(res, 404, {
              error: "Cross-project overview is not configured",
            });
          return json(res, 200, await projectCrossOverview.snapshot());
        }
        if (req.method === "POST" && route === "/api/projects/search") {
          if (!humanAuthorized)
            return json(res, 403, {
              error: "Human browser credential required",
            });
          if (!projectCrossSearch)
            return json(res, 404, {
              error: "Cross-project search is not configured",
            });

          try {
            return json(
              res,
              200,
              await projectCrossSearch.search(await readBody(req)),
            );
          } catch (error) {
            return json(res, 400, { error: error.message });
          }
        }
        if (req.method === "GET" && route === "/api/timeline") {
          if (!humanAuthorized && !adminAuthorized)
            return json(res, 403, {
              error: "Human or administrator credential required",
            });
          if (
            [...url.searchParams.keys()].some(
              (key) => !["after", "limit", "trace_id"].includes(key),
            )
          )
            return json(res, 400, { error: "Unknown timeline parameter" });

          try {
            return json(
              res,
              200,
              await readCausalTimeline(project, store.clone(), {
                after: Number(url.searchParams.get("after") || 0),
                limit: Number(url.searchParams.get("limit") || 10),
                trace_id: url.searchParams.get("trace_id"),
              }),
            );
          } catch (error) {
            return json(res, error.status || 400, { error: error.message });
          }
        }
        if (req.method === "GET" && route === "/api/handoff") {
          if (!mcpAuthorized)
            return json(res, 403, { error: "MCP bearer credential required" });
          return json(res, 200, await getHandoff());
        }
        if (req.method === "GET" && route === "/api/acceptance") {
          if (!mcpAuthorized)
            return json(res, 403, { error: "MCP bearer credential required" });
          return json(res, 200, await getAcceptance());
        }
        if (req.method === "POST" && route === "/api/handoff/create") {
          if (!mcpAuthorized)
            return json(res, 403, { error: "MCP bearer credential required" });
          const input = await readBody(req);
          if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).length !== 1 ||
            typeof input.task_id !== "string"
          )
            return json(res, 400, { error: "Expected only a task_id field" });
          return json(res, 200, await createHandoff(input.task_id));
        }
        if (req.method === "GET" && route === "/api/task-outcomes") {
          const entries = [...url.searchParams.entries()];
          if (entries.length !== 1)
            return json(res, 400, {
              error: "Select exactly one task_id or milestone_id",
            });
          const state = store.clone();
          const result = await inspectTaskOutcomes(
            project,
            state,
            Object.fromEntries(entries),
          );
          if (store.value.revision !== state.revision)
            return json(res, 409, {
              error: "Project state changed; refresh and inspect again",
            });
          return json(res, 200, result);
        }
        if (req.method === "POST" && route?.startsWith("/api/update/")) {
          const operation = route.slice("/api/update/".length);
          if (["contract", "policy", "approval_request", "approval_decision", "approval_check", "approval_claim", "approval_start", "approval_finish"].includes(operation))
            return json(res, 403, { error: "Use the administrator contract endpoint" });
          if (
            ![
              "metrics",
              "task",
              "question",
              "answer",
              "event",
              "ui_surface",
              "provider_status",
            ].includes(operation)
          )
            return json(res, 404, { error: "Unknown project operation" });
          if (
            operation === "answer"
              ? !humanAuthorized
              : !(mcpAuthorized || adminAuthorized)
          )
            return json(res, 403, {
              error: "This credential cannot perform that operation",
            });
          const body = await readBody(req);
          if (operation === "ui_surface")
            return json(res, 200, await mutateUiSurface(body));
          return json(res, 200, await mutate(operation, body));
        }
        if (route === "/api/ui/actions") {
          // The browser returns a human action to the same session. The action
          // id came from the server, and no operation is executed here.
          if (req.method !== "POST")
            return json(res, 405, { error: "Method not allowed" });
          if (!humanAuthorized)
            return json(res, 403, {
              error: "Dashboard owner browser required",
            });
          return json(res, 200, await mutateUiAction(await readBody(req, 65536)));
        }
        if (req.method === "GET" && route === "/api/live") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            connection: "keep-alive",
          });
          res.write(": connected\n\n");
          live.set(
            res,
            browserAccess?.role === "device" ? browserAccess.device_id : null,
          );
          const ping = setInterval(() => res.write(": ping\n\n"), 20000);
          req.on("close", () => {
            clearInterval(ping);
            live.delete(res);
          });
          return;
        }
        if (route === "/mcp") {
          // MCP clients use a bearer token; browser cookies are not an MCP credential.
          if (!mcpAuthorized)
            return json(res, 401, { error: "MCP bearer token required" });
          const sessionId = req.headers["mcp-session-id"];
          const body = req.method === "POST" ? await readBody(req) : undefined;
          if (!sessionId && !(await modern.isLegacy(req, body)))
            return await modern.handle(req, res, body);
          let session = sessions.get(sessionId);
          if (!session && sessionId)
            return json(res, 404, {
              error: "Unknown MCP session; initialize again",
            });
          if (!session && req.method === "POST" && isInitializeRequest(body)) {
            const mcp = createMcpServer({
              getState: visibleState,
              mutate,
              createHandoff,
              getHandoff,
              getAcceptance,
              presentUi: mutateUiSurface,
              recordReview,
              checkContract: preflight,
              checkOperation: policyCheck,
              requestApproval,
              checkApproval: approvalCheck,
              claimApproval: approvalClaim,
              executeApproval,
              checkWorkerStart: workerStartCheck,
            });
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: randomUUID,
              onsessioninitialized: (id) =>
                sessions.set(id, { transport, mcp }),
            });
            await mcp.server.connect(transport);
            mcp.server.onclose = () => {
              if (transport.sessionId) sessions.delete(transport.sessionId);
            };
            session = { transport, mcp };
          }
          if (!session)
            return json(res, 400, { error: "MCP initialization required" });
          return await session.transport.handleRequest(req, res, body);
        }
      }
      if (kind === "harness" && !url.pathname.startsWith("/_rdsh"))
        return proxyHarness(req, res, harness.port, cookieName, token);
      json(res, 404, { error: "Not found" });
    } catch (e) {
      if (!res.headersSent)
        json(res, [401, 403, 409, 413, 500, 504].includes(e.status) ? e.status : 400, {
          error: e.message,
        });
      else res.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    const authorizedUpgrade =
      equal(req.headers.authorization, `Bearer ${token}`) ||
      (kind === "harness" && browserAuthorized(req, null, null));
    if (kind !== "harness" || !harness || !trusted(req) || !authorizedUpgrade) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    upgradeHarness(req, socket, head, harness.port, cookieName, token);
  });
  function close() {
    if (closePromise) return closePromise;
    if (closing) return Promise.resolve();
    const attempt = Promise.resolve().then(async () => {
      if (harness && !(await harness.stop()).confirmed)
        throw new Error(
          "Owned Harness exit unverified; dashboard remains available",
        );
      closing = true;
      let failure;
      const cleanup = async (work) => {
        try {
          await work();
        } catch (error) {
          failure ??= error;
        }
      };
      if (deliveryTimer) clearInterval(deliveryTimer);
      for (const response of live.keys()) response.end();
      await cleanup(() => devices?.flush());
      for (const { mcp } of sessions.values())
        await cleanup(() => mcp.server.close());
      await cleanup(() => updateQueue);
      await cleanup(() => instructionQueueWorker?.close());
      await cleanup(() => eventsHub?.queue);
      for (const socket of sockets) socket.destroy();
      await cleanup(() => new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
      }));
      await cleanup(() => removeDashboardLockIfOwned(lockFile, lockContent));
      if (failure) throw failure;
    });
    closePromise = attempt;
    // A failed preflight leaves the dashboard available, so let a later caller retry.
    void attempt.then(undefined, () => {
      if (!closing && closePromise === attempt) closePromise = null;
    });
    return attempt;
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    port = server.address().port;
    localUrl = `http://127.0.0.1:${port}/`;
    if (kind === "harness")
      harness = await startHarness(options.harnessPort || 3081, port, {
        ...options.harnessOptions,
        project: { id: "managed-harness", directory },
      });
    if (harness && options.observeHarness) options.observeHarness(harness);
    await refreshShare();
  } catch (e) {
    await close();
    throw e;
  }
  return {
    server,
    close,
    port,
    localUrl,
    directory,
    browserUrl: browserUrl(localUrl),
    getShare: () => share,
    mutate,
    store,
  };
}
