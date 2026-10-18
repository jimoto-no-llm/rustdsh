import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile, mkdir, lstat, rename, unlink } from "node:fs/promises";
import { watch } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const inject = ["webServer", "connection"];

const PLUGIN_DIRECTORY = dirname(realpathSync(fileURLToPath(import.meta.url)));
const DEFAULT_SYNC_SCRIPT = resolve(PLUGIN_DIRECTORY, "../../sync-dsh.sh");
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const updateDirectory = () => join(homedir(), ".local", "share", "rdsh");
const closePath = () => join(updateDirectory(), "update-notice-close.json");
const REMINDER_MS = 2 * 60 * 60 * 1000;
const validTarget = (s) => typeof s?.to === "string" && s.to.length > 0 && s.to.length <= 512 &&
  typeof s.kind === "string" && s.kind.length > 0 && s.kind.length <= 64;
const validClose = (s) => validTarget(s) && typeof s.id === "string" && /^[a-f0-9-]{36}$/.test(s.id) &&
  Number.isFinite(s.at) && s.at > 0 && Number.isSafeInteger(s.cycle) && s.cycle >= 0 && s.cycle <= 1000000;

// Feature switches live in $DSH_HOME/rdsh.json. An absent id (or a missing,
// unreadable or corrupt file) keeps the fallback; an explicit false removes the
// capability without throwing.
function featureEnabled(id, fallback, env = process.env) {
  try {
    const path = join(env.DSH_HOME || join(homedir(), ".dsh"), "rdsh.json");
    const value = JSON.parse(readFileSync(path, "utf8"))?.features?.[id];
    return typeof value === "boolean" ? value : fallback;
  } catch {
    return fallback;
  }
}

async function readClose() {
  try {
    const file = await lstat(closePath());
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 4096) return null;
    const value = JSON.parse(await readFile(closePath(), "utf8"));
    return validClose(value) ? value : null;
  } catch { return null; }
}

async function writeClose(value) {
  const directory = updateDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await lstat(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("invalid notification directory");
  try {
    const file = await lstat(closePath());
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error("invalid close record");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(directory, ".update-close-" + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    // Replacing the leaf is atomic and never follows a planted leaf link.
    await rename(temporary, closePath());
  } finally { await unlink(temporary).catch(() => {}); }
}

function notificationStream(getState) {
  const clients = new Set();
  const ready = new Set();
  let disposed = false, poll, heartbeat, watcher, debounce, refreshing, pending = false;
  let current = { ok: true, updated: false }, fingerprint, lastClose;
  function stop() {
    clearInterval(poll); clearInterval(heartbeat); clearTimeout(debounce);
    watcher?.close(); watcher = poll = heartbeat = debounce = undefined;
  }
  function remove(res) { ready.delete(res); clients.delete(res); if (!clients.size) stop(); }
  function send(res, event, value) {
    if (!clients.has(res)) return;
    try {
      if (!res.write(event ? `event: ${event}\ndata: ${JSON.stringify(value)}\n\n` : ": keepalive\n\n")) {
        remove(res); res.destroy();
      }
    } catch { remove(res); res.destroy(); }
  }
  function emit(event, value) {
    for (const res of clients) if (event !== "close" || ready.has(res)) send(res, event, value);
  }
  async function refresh() {
    if (disposed) return;
    if (refreshing) { pending = true; return refreshing; }
    refreshing = (async () => {
      do {
        pending = false;
        const state = await getState();
        if (disposed) return;
        if (state.ok) {
          const key = JSON.stringify(state);
          current = state;
          if (key !== fingerprint) { fingerprint = key; emit("state", state); }
        }
        const close = await readClose();
        if (disposed) return;
        if (lastClose !== undefined && close && close.id !== lastClose) emit("close", close);
        lastClose = close?.id || null;
      } while (pending && !disposed);
    })();
    try { await refreshing; } finally { refreshing = undefined; }
  }
  function observe() {
    if (watcher || disposed || !clients.size) return;
    try {
      watcher = watch(updateDirectory(), { persistent: false }, (_event, filename) => {
        if (filename && !["update-state.json", "update-notice-close.json"].includes(String(filename))) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => { void refresh(); }, 25);
      });
      watcher.on("error", () => { watcher?.close(); watcher = undefined; });
    } catch { /* The periodic check also discovers a directory created later. */ }
  }
  return {
    get full() { return clients.size >= 32; },
    async subscribe(res) {
      clients.add(res);
      res.once("close", () => remove(res));
      res.once("error", () => remove(res));
      if (!poll) {
        poll = setInterval(() => { observe(); void refresh(); }, 1000); poll.unref?.();
        heartbeat = setInterval(() => emit(null), 15000); heartbeat.unref?.();
      }
      observe();
      await refresh();
      if (!disposed) { send(res, "state", current); if (clients.has(res)) ready.add(res); }
    },
    close(value) { lastClose = value.id; emit("close", value); },
    dispose() {
      disposed = true; stop();
      for (const res of clients) res.end();
      clients.clear();
      ready.clear();
    },
  };
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function authorize(ctx, req, res) {
  const status = typeof ctx.connection?.requestRejection === "function"
    ? ctx.connection.requestRejection(req) : 503;
  if (status === undefined) return true;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ ok: false, error: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "authentication-unavailable" }));
  return false;
}

async function runSync(syncScript) {
  let file;
  try {
    file = await lstat(syncScript);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ok: false, message: "updater not found; install from a local rustdsh checkout or set syncScript" };
    }
    return { ok: false, message: "could not inspect updater; check the local rustdsh installation" };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || uid === undefined || file.uid !== uid) {
    return { ok: false, message: "updater must be a regular file owned by the current user" };
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        "/bin/sh",
        [syncScript],
        { timeout: RUN_TIMEOUT_MS, maxBuffer: 256 * 1024 },
        (err, stdout, stderr) => {
          const tail = (chunk) => String(chunk || "").split("\n").slice(-6).join("\n").trim();
          if (err) {
            // The reason can be written to stderr only; keep both so it is not lost.
            const reason = [tail(stdout), tail(stderr)].filter((part) => part !== "").join("\n");
            resolve({ ok: false, message: "update failed: " + reason });
            return;
          }
          resolve({ ok: true, message: tail(stdout) || "update finished" });
        },
      );
    } catch (e) {
      resolve({ ok: false, message: "could not start updater" });
      return;
    }
    child.on("error", () => resolve({ ok: false, message: "could not start updater" }));
  });
}

export function apply(ctx, config) {
  const updateCheck = featureEnabled("update_check", true);
  const updateNotifications = featureEnabled("update_notifications", true);
  const demo = config && config.demo === true;
  const configuredSyncScript = typeof config?.syncScript === "string" && config.syncScript.trim()
    ? resolve(PLUGIN_DIRECTORY, config.syncScript.trim())
    : DEFAULT_SYNC_SCRIPT;
  return ctx.effect(() => {
    if (!ctx.webServer) return;
    if (!updateCheck) return;
    const demoState = { ok: true, updated: true, kind: "demo", from: "0.2.0-rc.2", to: "0.2.1-rc.1", at: Date.now(), demo: true };
    const getState = () => demo ? Promise.resolve(demoState) : readState();
    const stream = notificationStream(getState);
    const off1 = ctx.webServer.register({
      kind: "exact",
      path: "/api/rdsh-update/run",
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "method-not-allowed" }));
          return;
        }
        try {
          const out = await runSync(configuredSyncScript);
          const body = JSON.stringify(out);
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-length": Buffer.byteLength(body),
          });
          res.end(body);
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false }));
        }
      },
    });
    const off2 = ctx.webServer.register({
      kind: "exact",
      path: "/api/rdsh-update",
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "method-not-allowed" }));
          return;
        }
        try {
          let body;
          if (demo) {
            body = JSON.stringify({ ...demoState, dsh: await readDshStatus() });
          } else {
            const state = await readState();
            body = JSON.stringify({ ...state, dsh: await readDshStatus() });
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
          res.end(body);
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false }));
        }
      },
    });
    const offDsh = ctx.webServer.register({
      kind: "exact",
      path: "/api/rdsh-update/dsh/run",
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "method-not-allowed" });
        try {
          const status = await readDshStatus();
          if (!status.available || !status.to) return json(res, 200, { ok: false, message: "no dsh update available" });
          json(res, 200, await runDshUpdate(status.to));
        } catch (error) {
          json(res, 500, { ok: false });
        }
      },
    });
    const off3 = ctx.webServer.register({
      kind: "exact",
      path: "/api/rdsh-update/dismiss",
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== "POST") return json(res, 405, { ok: false, error: "method-not-allowed" });
        let input;
        try {
          let size = 0; const chunks = [];
          for await (const chunk of req) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > 4096) throw new Error("body too large");
            chunks.push(bytes);
          }
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!input || typeof input.to !== "string" || !input.to || input.to.length > 512 ||
              typeof input.kind !== "string" || !input.kind || input.kind.length > 64) throw new Error("invalid target");
        } catch (error) { return json(res, 400, { ok: false, error: "invalid-target" }); }
        try {
          const current = await getState();
          if (!current.updated || current.to !== input.to || current.kind !== input.kind ||
              (input.at !== undefined && input.at !== current.at)) {
            return json(res, 409, { ok: false, error: "update-changed" });
          }
          const close = { id: randomUUID(), kind: current.kind, to: current.to, at: current.at,
            cycle: input.cycle ?? Math.max(0, Math.floor((Date.now() - current.at) / REMINDER_MS)) };
          if (!validClose(close)) return json(res, 400, { ok: false, error: "invalid-target" });
          if (!demo) await writeClose(close);
          stream.close(close);
          json(res, 200, { ok: true });
        } catch (error) { json(res, 500, { ok: false, error: "dismiss-failed" }); }
      },
    });
    // Without notifications the client keeps polling /api/rdsh-update.
    const off4 = updateNotifications ? ctx.webServer.register({
      kind: "exact", path: "/api/rdsh-update/events",
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== "GET") return json(res, 405, { ok: false, error: "method-not-allowed" });
        if (stream.full) return json(res, 429, { ok: false, error: "too-many-streams" });
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform",
          "x-content-type-options": "nosniff" });
        res.flushHeaders?.();
        await stream.subscribe(res);
      },
    }) : undefined;
    return () => {
      stream.dispose();
      try {
        if (typeof off1 === "function") off1();
      } catch (e) {}
      try {
        if (typeof off2 === "function") off2();
      } catch (e) {}
      try { if (typeof offDsh === "function") offDsh(); } catch (e) {}
      try { if (typeof off3 === "function") off3(); } catch (e) {}
      try { if (typeof off4 === "function") off4(); } catch (e) {}
    };
  });
}

// ---- dsh update availability ---------------------------------------------
// The rdsh banner watches an update that already happened; this half watches
// the published dsh release so the same card can offer the upgrade.
const DSH_REFRESH_MS = 12 * 60 * 60 * 1000;
const DSH_QUERY_TIMEOUT_MS = 25 * 1000;
const VERSION_PATTERN = /^[0-9]+(\.[0-9]+)*(?:-[0-9A-Za-z.-]+)?$/;
let dshRefreshing = false;

const dshCachePath = () => join(homedir(), ".cache", "rdsh-desktop", "update-check.json");

function compareVersions(left, right) {
  const split = (value) => {
    const parts = String(value).split("-");
    return { base: parts[0].split(".").map((part) => Number(part) || 0), pre: parts.length > 1 ? parts.slice(1).join("-") : null };
  };
  const a = split(left);
  const b = split(right);
  const length = Math.max(a.base.length, b.base.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.base[index] || 0;
    const y = b.base[index] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

async function readDshCache() {
  try {
    const path = dshCachePath();
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 4096) return null;
    const value = JSON.parse(await readFile(path, "utf8"));
    const newest = typeof value?.newest === "string" ? value.newest : "";
    if (!VERSION_PATTERN.test(newest)) return null;
    return { newest, checkedAt: Number(value?.checkedAt) || 0 };
  } catch (error) {
    return null;
  }
}

function queryPublishedDsh() {
  return new Promise((resolve) => {
    execFile("npm", ["view", "@deepseek-ai/dsh", "versions", "--json"], { timeout: DSH_QUERY_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, async (error, stdout) => {
      if (error) { resolve(null); return; }
      try {
        const parsed = JSON.parse(stdout);
        const list = (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => typeof item === "string" && VERSION_PATTERN.test(item));
        if (list.length === 0) { resolve(null); return; }
        const newest = list.reduce((best, item) => (compareVersions(item, best) > 0 ? item : best), list[0]);
        try {
          await mkdir(dirname(dshCachePath()), { recursive: true });
          await writeFile(dshCachePath(), JSON.stringify({ checkedAt: Date.now(), newest }));
        } catch (writeError) {}
        resolve(newest);
      } catch (parseError) {
        resolve(null);
      }
    });
  });
}

// Returns { version, prefix } for the dsh install that is actually running.
// The prefix matters because npm's global prefix here is /usr/local (root),
// while this harness lives in a user-owned directory.
function activeDshInstall() {
  if (typeof process.env.DSH_VERSION === "string" && VERSION_PATTERN.test(process.env.DSH_VERSION)) {
    return process.env.DSH_VERSION;
  }
  // The plugin is loaded by the dsh host, so the host entry script sits inside
  // the installed package. Walk up from it instead of resolving the dependency
  // from this plugin's own directory, which has no dsh in its node_modules.
  const candidates = [];
  try {
    if (process.argv[1]) candidates.push(realpathSync(process.argv[1]));
  } catch (error) {}
  try {
    const url = import.meta.resolve("@deepseek-ai/dsh/package.json");
    if (url) candidates.push(fileURLToPath(url));
  } catch (error) {}
  for (const candidate of candidates) {
    let directory = dirname(candidate);
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const value = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        if (value.name === "@deepseek-ai/dsh" && typeof value.version === "string" && VERSION_PATTERN.test(value.version)) {
          const prefix = dirname(dirname(dirname(dirname(directory))));
          const installable = existsSync(join(prefix, "lib", "node_modules"));
          return { version: value.version, prefix: installable ? prefix : null };
        }
      } catch (error) {}
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return { version: "", prefix: null };
}

async function readDshStatus() {
  const cache = await readDshCache();
  const stale = !cache || Date.now() - cache.checkedAt > DSH_REFRESH_MS;
  if (stale && process.env.RDSH_DESKTOP_UPDATE_CHECK !== "0" && !dshRefreshing) {
    dshRefreshing = true;
    queryPublishedDsh().catch(() => {}).finally(() => { dshRefreshing = false; });
  }
  const newest = cache ? cache.newest : "";
  const install = activeDshInstall();
  const active = install.version;
  return {
    available: Boolean(newest && active && compareVersions(newest, active) > 0),
    from: active || null,
    to: newest || null,
    at: (cache && cache.checkedAt) || Date.now(),
    command: newest ? dshInstallCommand(install.prefix, newest) : null,
    details: newest ? "https://www.npmjs.com/package/@deepseek-ai/dsh/v/" + newest : null,
    installPrefix: install.prefix,
  };
}

function dshInstallCommand(prefix, version) {
  const target = "@deepseek-ai/dsh@" + version;
  return prefix ? "npm install --prefix " + prefix + " " + target : "npm install -g " + target;
}

function runDshUpdate(version) {
  if (!VERSION_PATTERN.test(version)) return Promise.resolve({ ok: false, message: "invalid version" });
  const install = activeDshInstall();
  if (install.prefix && !isWritable(install.prefix)) {
    return Promise.resolve({
      ok: false,
      message: "the install directory is not writable; run: " + dshInstallCommand(install.prefix, version),
    });
  }
  const args = install.prefix
    ? ["install", "--prefix", install.prefix, "@deepseek-ai/dsh@" + version]
    : ["install", "-g", "@deepseek-ai/dsh@" + version];
  return new Promise((resolve) => {
    execFile("npm", args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const tail = String(stderr || stdout || "").trim().split("\n").slice(-3).join(" ");
      if (error) {
        resolve({ ok: false, message: tail || String(error.message || "npm failed") });
        return;
      }
      resolve({ ok: true, message: "installed dsh " + version + " into " + (install.prefix || "the global prefix") + " (restart the web service to use it)" });
    });
  });
}

function isWritable(directory) {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch (error) {
    return false;
  }
}

async function readState() {
  try {
    const path = join(updateDirectory(), "update-state.json");
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 4096) return { ok: false };
    const raw = await readFile(path, "utf8");
    const s = JSON.parse(raw);
    if (!s?.updated) return { ok: true, updated: false };
    const kind = typeof s.kind === "string" && s.kind ? s.kind : "update";
    if (!validTarget({ kind, to: s.to })) return { ok: false };
    const timestamp = Number(s.at);
    const at = Number.isFinite(timestamp) && timestamp > 0 && timestamp <= file.mtimeMs + 60000
      ? timestamp : Math.floor(file.mtimeMs);
    return { ok: true, updated: true, kind, from: typeof s.from === "string" ? s.from.slice(0, 512) : null, to: s.to, at };
  } catch (e) {
    return e.code === "ENOENT" ? { ok: true, updated: false } : { ok: false };
  }
}
