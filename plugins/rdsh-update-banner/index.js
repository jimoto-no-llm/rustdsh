import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";

export const inject = ["webServer", "connection"];

const SYNC_SCRIPT = "/home/sahen/File/Prog/rustdsh/sync-dsh.sh";
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

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
            body = JSON.stringify({ ok: true, updated: true, from: "0.2.0-rc.2", to: "0.2.1-rc.1", at: Date.now(), demo: true });
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
    return () => {
      try {
        if (typeof off1 === "function") off1();
      } catch (e) {}
      try {
        if (typeof off2 === "function") off2();
      } catch (e) {}
    };
  });
}

async function readState() {
  try {
    const raw = await readFile(join(homedir(), ".local", "share", "rdsh", "update-state.json"), "utf8");
    const s = JSON.parse(raw);
    return { ok: true, updated: !!s.updated, from: s.from || null, to: s.to || null, at: s.at || null };
  } catch (e) {
    return { ok: true, updated: false };
  }
}
