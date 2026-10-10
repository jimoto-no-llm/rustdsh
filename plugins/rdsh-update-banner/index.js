import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
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
          const tail = String(stdout || "").split("\n").slice(-6).join("\n");
          if (err) resolve({ ok: false, message: "update failed: " + tail });
          else resolve({ ok: true, message: tail || "update finished" });
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
  const demo = config && config.demo === true;
  const configuredSyncScript = typeof config?.syncScript === "string" && config.syncScript.trim()
    ? resolve(PLUGIN_DIRECTORY, config.syncScript.trim())
    : DEFAULT_SYNC_SCRIPT;
  return ctx.effect(() => {
    if (!ctx.webServer) return;
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
            body = JSON.stringify(demoState);
          } else {
            body = JSON.stringify(await readState());
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
          res.end(body);
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false }));
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
    const off4 = ctx.webServer.register({
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
    });
    return () => {
      stream.dispose();
      try {
        if (typeof off1 === "function") off1();
      } catch (e) {}
      try {
        if (typeof off2 === "function") off2();
      } catch (e) {}
      try { if (typeof off3 === "function") off3(); } catch (e) {}
      try { if (typeof off4 === "function") off4(); } catch (e) {}
    };
  });
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
