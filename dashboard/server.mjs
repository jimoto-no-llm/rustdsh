import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ProjectStore, writeJson, stateHome, publicState } from "./state.mjs";
import { createMcpServer } from "./mcp.mjs";
import { enableShare } from "./tailscale.mjs";
import { startHarness, proxyHarness, upgradeHarness } from "./harness.mjs";
import { EventsHub } from "./webhooks.mjs";
import { modernMcpHandler } from "./mcp2.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  let size = 0,
    chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 131072) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
export async function startDashboard(options) {
  const { kind = "project", project, tailscale = true } = options;
  const port =
    options.port ||
    (kind === "harness"
      ? 38081
      : 38100 + (parseInt(project.id.slice(0, 4), 16) % 1000));
  const directory =
    kind === "project" ? project.directory : path.join(stateHome(), "harness");
  await fs.mkdir(directory, { recursive: true });
  // Exclusive live-instance lock: never launch two writers for the same project.
  const lockFile = path.join(directory, "server.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(lockFile, String(process.pid), {
        flag: "wx",
        mode: 0o600,
      });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(await fs.readFile(lockFile, "utf8"));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        if (error.code === "EPERM") alive = true;
      }
      if (alive)
        throw new Error(
          "This dashboard is already running; use rdsh-dashboard open with the same project",
        );
      await fs.unlink(lockFile);
      if (attempt === 1) throw new Error("Could not acquire dashboard lock");
    }
  }
  const token = randomBytes(32).toString("hex"); // local administrator
  const mcpToken = randomBytes(32).toString("hex");
  const browserToken = randomBytes(32).toString("hex");
  const localUrl = `http://127.0.0.1:${port}/`;
  const cookieName = `rdsh_${kind === "project" ? project.id : "harness"}`;
  let store, eventsHub;
  try {
    store = kind === "project" ? await ProjectStore.open(project) : null;
    eventsHub = store
      ? await EventsHub.open(project, () => store.value, options.webhookPost)
      : null;
  } catch (error) {
    await fs.unlink(lockFile);
    throw error;
  }
  const live = new Set(),
    sessions = new Map();
  const sockets = new Set();
  const modern = store
    ? modernMcpHandler(
        { getState: async () => publicState(store.value), mutate },
        eventsHub,
      )
    : null;
  const deliveryTimer = eventsHub
    ? setInterval(() => {
        void eventsHub.flush().catch(() => {});
      }, 2000)
    : null;
  deliveryTimer?.unref();
  let harness = null;
  let share = {
    state: "disabled",
    message: "ローカル接続のみ。Tailscale共有は起動時に有効にできます。",
    url: null,
  };
  let updateQueue = Promise.resolve();
  let refreshPromise = null;
  let closing = false;
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
      return equal(req.headers["x-rdsh-browser-token"], browserToken) ||
        (route === "/api/live" && equal(url.searchParams.get("key"), browserToken));
    return (req.headers.cookie || "").split(";").some((item) => {
      const [name, value] = item.trim().split("=");
      return name === cookieName && equal(value, browserToken);
    });
  }
  function trusted(req) {
    const host = req.headers.host;
    const allowed = allowedOrigins();
    return (
      allowed.hosts.has(host) &&
      (!req.headers.origin || allowed.origins.has(req.headers.origin))
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
      pid: process.pid,
      port,
      local_url: localUrl,
      browser_url: browserUrl(localUrl),
      token,
      mcp_token: mcpToken,
      share,
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
  async function mutate(operation, input) {
    if (!store)
      throw new Error("Project operations are unavailable in Harness mode");
    const task = updateQueue.then(async () => {
      const state = await store.mutate(operation, input);
      for (const response of live)
        response.write(`event: changed\ndata: ${state.revision}\n\n`);
      for (const { mcp } of sessions.values()) void mcp.notify();
      void eventsHub.flush().catch(() => {});
      return publicState(state);
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    try {
      if (!trusted(req))
        return json(res, 403, { error: "Untrusted host or origin" });
      const url = new URL(req.url, localUrl);
      if (kind === "harness" && req.method === "GET" && equal(url.searchParams.get("rdsh_dashboard_key"), browserToken)) {
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
      const adminAuthorized = equal(req.headers.authorization, `Bearer ${token}`);
      const agentRoute = route === "/mcp" || route === "/api/state" ||
        (req.method === "POST" && ["metrics", "task", "question", "event"].some((operation) => route === `/api/update/${operation}`));
      const mcpAuthorized = kind === "project" && agentRoute && equal(req.headers.authorization, `Bearer ${mcpToken}`);
      const humanAuthorized = browserAuthorized(req, url, route);
      const publicAsset = kind === "project" && req.method === "GET" && (route === "/" || route === "/app.mjs" || route === "/favicon.ico");
      if (!publicAsset && !adminAuthorized && !mcpAuthorized && !humanAuthorized)
        return json(res, 401, {
          error:
            "Open this dashboard through rdsh-dashboard open or its QR code",
        });
      if (closing) return json(res, 503, { error: "Dashboard is stopping" });
      if (publicAsset && route === "/favicon.ico") {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "POST" && route === "/api/stop") {
        if (!adminAuthorized)
          return json(res, 401, {
            error: "Administrator bearer token required",
          });
        res.once("finish", () => {
          void close();
        });
        return json(res, 200, { stopping: true });
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
        return res.end(await fs.readFile(path.join(here, "ui.html")));
      }
      if (req.method === "GET" && route === "/app.mjs") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
        });
        return res.end(await fs.readFile(path.join(here, "app.mjs")));
      }
      if (req.method === "GET" && route === "/api/config")
        return json(res, 200, {
          kind,
          project: project
            ? { id: project.id, name: project.name, root: project.root }
            : null,
          share,
          events: eventsHub?.status() || null,
          mcp_url: kind === "project" && share.url ? `${share.url}mcp` : null,
          harness_url: harness
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
        if (req.method === "GET" && route === "/api/state")
          return json(res, 200, publicState(store.value));
        if (req.method === "POST" && route?.startsWith("/api/update/")) {
          const operation = route.slice("/api/update/".length);
          if (operation === "answer" ? !humanAuthorized : !(mcpAuthorized || adminAuthorized))
            return json(res, 403, { error: "This credential cannot perform that operation" });
          return json(
            res,
            200,
            await mutate(operation, await readBody(req)),
          );
        }
        if (req.method === "GET" && route === "/api/live") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            connection: "keep-alive",
          });
          res.write(": connected\n\n");
          live.add(res);
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
              getState: async () => publicState(store.value),
              mutate,
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
      if (!res.headersSent) json(res, 400, { error: e.message });
      else res.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    const authorizedUpgrade = equal(req.headers.authorization, `Bearer ${token}`) ||
      (kind === "harness" && browserAuthorized(req, null, null));
    if (kind !== "harness" || !harness || !trusted(req) || !authorizedUpgrade) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    upgradeHarness(req, socket, head, harness.port, cookieName, token);
  });
  async function close() {
    if (closing) return;
    closing = true;
    if (deliveryTimer) clearInterval(deliveryTimer);
    for (const response of live) response.end();
    for (const { mcp } of sessions.values()) await mcp.server.close();
    await updateQueue;
    await eventsHub?.queue;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (harness) await harness.stop();
    await fs.unlink(lockFile).catch(() => {});
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    if (kind === "harness")
      harness = await startHarness(options.harnessPort || 3081, port);
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
