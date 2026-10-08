import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

export const inject = ["webServer", "connection"];

const SYNC_SCRIPT = "/home/sahen/File/Prog/rustdsh/sync-dsh.sh";
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const updateDirectory = () => join(homedir(), ".local", "share", "rdsh");
const dismissalDirectory = () => join(updateDirectory(), "update-dismissals");

function dismissalPath(state) {
  if (typeof state.to !== "string" || !state.to || state.to.length > 512 ||
      typeof state.kind !== "string" || state.kind.length > 64) return null;
  const key = createHash("sha256").update(JSON.stringify([state.kind, state.to])).digest("hex");
  return join(dismissalDirectory(), key);
}

async function wasDismissed(state) {
  const path = dismissalPath(state);
  if (!path) return false;
  try {
    const directory = await lstat(dismissalDirectory());
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    const file = await lstat(path);
    return file.isFile() && !file.isSymbolicLink() && file.nlink === 1;
  } catch (error) {
    // Unreadable acknowledgement state must not hide a genuine new update.
    return false;
  }
}

async function dismissState(state) {
  const path = dismissalPath(state);
  if (!path) throw new Error("invalid update target");
  await mkdir(dismissalDirectory(), { recursive: true, mode: 0o700 });
  const directory = await lstat(dismissalDirectory());
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("invalid dismissal directory");
  try {
    // One exclusive marker per target: concurrent versions never overwrite each
    // other, and an existing link is never followed or truncated.
    await writeFile(path, "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST" || !await wasDismissed(state)) throw error;
  }
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

function runSync() {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        "/bin/sh",
        [SYNC_SCRIPT],
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
  return ctx.effect(() => {
    if (!ctx.webServer) return;
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
          const out = await runSync();
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
            body = JSON.stringify({ ok: true, updated: true, kind: "demo", from: "0.2.0-rc.2", to: "0.2.1-rc.1", at: Date.now(), demo: true });
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
          // Demo closes locally without creating any account state.
          if (demo && input.kind === "demo" && input.to === "0.2.1-rc.1") return json(res, 200, { ok: true });
          const current = await readState();
          if (!current.updated || current.to !== input.to || current.kind !== input.kind) {
            return json(res, 409, { ok: false, error: "update-changed" });
          }
          await dismissState(current);
          json(res, 200, { ok: true });
        } catch (error) { json(res, 500, { ok: false, error: "dismiss-failed" }); }
      },
    });
    return () => {
      try {
        if (typeof off1 === "function") off1();
      } catch (e) {}
      try {
        if (typeof off2 === "function") off2();
      } catch (e) {}
      try { if (typeof off3 === "function") off3(); } catch (e) {}
    };
  });
}

async function readState() {
  try {
    const raw = await readFile(join(updateDirectory(), "update-state.json"), "utf8");
    const s = JSON.parse(raw);
    const state = { ok: true, updated: !!s.updated, kind: typeof s.kind === "string" && s.kind ? s.kind : "update", from: s.from || null, to: s.to || null, at: s.at || null };
    return { ...state, dismissed: await wasDismissed(state) };
  } catch (e) {
    return { ok: true, updated: false };
  }
}
