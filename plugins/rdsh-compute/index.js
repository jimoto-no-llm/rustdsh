// rdsh-compute: opt-in bridge from DSH Web plugins to the resident
// `rdsh compute` worker. Default OFF: unless RDSH_COMPUTE=1 the caller must
// use its original in-Node implementation. Any worker failure falls back
// (fail-open for pure compute, fail-closed is the caller's display choice).
//
// Only pure string ops are exposed: tokens.estimate / tokens.prune.
// No paths, no session ids, no credentials cross this boundary.
// Large inputs are rejected here (1 MiB) so one giant history JSON is never
// sent in a single round-trip; callers chunk first.
//
// Timing split (for the T_total decision in docs/WEB-COMPUTE.md):
//   elapsed = serialize + ipc_roundtrip(rust elapsed_us inside) + deserialize
// The worker reports its own elapsed_us; the bridge reports the rest.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 5000;

// Feature switches live in $DSH_HOME/rdsh.json. An id that is absent (or a
// missing, unreadable or corrupt file) keeps the caller's fallback; an explicit
// false disables the capability and must never throw.
function featureEnabled(id, fallback, env = process.env) {
  try {
    const path = join(env.DSH_HOME || join(homedir(), ".dsh"), "rdsh.json");
    const value = JSON.parse(readFileSync(path, "utf8"))?.features?.[id];
    return typeof value === "boolean" ? value : fallback;
  } catch {
    return fallback;
  }
}

function jsEstimate(text) {
  // Same heuristic as src/tokens.rs: ASCII 4 bytes = 1 token,
  // each non-ASCII scalar = 1 token. Fallback path only.
  let tokens = 0;
  let asciiRun = 0;
  const buf = Buffer.from(text, "utf8");
  for (const b of buf) {
    if (b < 0x80) {
      asciiRun += 1;
      if (asciiRun === 4) {
        tokens += 1;
        asciiRun = 0;
      }
    } else if ((b & 0xc0) !== 0x80) {
      if (asciiRun > 0) {
        tokens += Math.ceil(asciiRun / 4);
        asciiRun = 0;
      }
      tokens += 1;
    }
  }
  return tokens + Math.ceil(asciiRun / 4);
}

export function isEnabled(env = process.env) {
  // features.compute wins in both directions; without the key the historical
  // RDSH_COMPUTE=1 opt-in still decides.
  return featureEnabled("compute", env.RDSH_COMPUTE === "1", env);
}

function defaultExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function wellKnownBins(env, platform, name) {
  const home = platform === "win32" ? env.USERPROFILE || env.HOME || homedir() : env.HOME || homedir();
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
    const cargoHome = env.CARGO_HOME || join(home, ".cargo");
    return [
      join(localAppData, "rdsh", "bin", name),
      join(home, ".local", "bin", name),
      join(cargoHome, "bin", name),
    ];
  }
  return [join(home, ".local", "bin", name), join("/usr/local/bin", name), join(home, ".cargo", "bin", name)];
}

// Desktop ships its own runtime and is not guaranteed to inherit the login
// shell PATH (~/.local/bin can be missing), so a bare "rdsh" is not enough:
// an explicit RDSH_BIN wins, then PATH, then the well-known install locations.
// Nothing resolved returns the historical "rdsh" default, so a later spawn
// failure still falls back to the JS implementation exactly as before.
export function resolveRdshBin(env = process.env, platform = process.platform, exists = defaultExists) {
  if (typeof env.RDSH_BIN === "string" && env.RDSH_BIN.trim() !== "") return env.RDSH_BIN;
  const name = platform === "win32" ? "rdsh.exe" : "rdsh";
  const pathSep = platform === "win32" ? ";" : ":";
  for (const dir of (env.PATH || env.Path || "").split(pathSep)) {
    if (dir && exists(join(dir, name))) return "rdsh"; // PATH hit: the bare name spawns as before
  }
  for (const candidate of wellKnownBins(env, platform, name)) {
    if (exists(candidate)) return candidate;
  }
  return "rdsh";
}

export function createComputeBridge({ bin = "rdsh", timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  let child = null;
  let ready = false;
  let seq = 0;
  const pending = new Map();
  let buffer = "";

  function ensureChild() {
    if (child) return child;
    child = spawnImpl(bin, ["compute"], { stdio: ["pipe", "pipe", "inherit"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // one bad line never resolves pending calls
        }
        const slot = pending.get(msg.id);
        if (slot) {
          pending.delete(msg.id);
          clearTimeout(slot.timer);
          slot.resolve(msg);
        }
      }
    });
    const failAll = (err) => {
      for (const [, slot] of pending) {
        clearTimeout(slot.timer);
        slot.reject(err);
      }
      pending.clear();
      child = null;
      ready = false;
    };
    child.on("exit", () => failAll(new Error("rdsh compute exited")));
    child.on("error", failAll);
    ready = true;
    return child;
  }

  function request(op, payload) {
    const text = payload.text ?? "";
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      return Promise.resolve({
        ok: false,
        code: "too_large",
        error: "text exceeds 1 MiB; chunk before sending",
      });
    }
    const id = `c${++seq}-${randomUUID().slice(0, 8)}`;
    const started = process.hrtime.bigint();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rdsh compute timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, started });
      try {
        ensureChild().stdin.write(JSON.stringify({ v: PROTOCOL_VERSION, id, op, ...payload }) + "\n");
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    }).then((msg) => ({
      ...msg,
      bridge_us: Number(process.hrtime.bigint() - started) / 1000,
    }));
  }

  // High-level helpers: return { result, usedRust, timings }.
  // On any worker error the JS fallback runs and usedRust=false.
  async function estimate(text) {
    const fallback = () => ({ tokens: jsEstimate(text), chars: Buffer.byteLength(text, "utf8") });
    if (!isEnabled()) return { result: fallback(), usedRust: false, timings: null };
    const t0 = process.hrtime.bigint();
    try {
      const msg = await request("tokens.estimate", { text });
      const timings = {
        total_us: Number(process.hrtime.bigint() - t0) / 1000,
        rust_us: msg.elapsed_us ?? null,
      };
      if (msg.ok !== true || typeof msg.tokens !== "number") throw new Error(msg.error ?? "bad response");
      return { result: { tokens: msg.tokens, chars: msg.chars }, usedRust: true, timings };
    } catch {
      return { result: fallback(), usedRust: false, timings: null };
    }
  }

  async function estimateBatch(texts) {
    const fallback = () => ({
      tokens: texts.map(jsEstimate),
      chars: texts.map((t) => Buffer.byteLength(t, "utf8")),
      total: texts.map(jsEstimate).reduce((a, b) => a + b, 0),
    });
    if (!isEnabled()) return { result: fallback(), usedRust: false, timings: null };
    const t0 = process.hrtime.bigint();
    try {
      const msg = await request("tokens.estimate_batch", { texts });
      const timings = {
        total_us: Number(process.hrtime.bigint() - t0) / 1000,
        rust_us: msg.elapsed_us ?? null,
      };
      if (msg.ok !== true || !Array.isArray(msg.tokens)) throw new Error(msg.error ?? "bad response");
      return {
        result: { tokens: msg.tokens, chars: msg.chars, total: msg.total },
        usedRust: true,
        timings,
      };
    } catch {
      return { result: fallback(), usedRust: false, timings: null };
    }
  }

  async function prune(text, maxTokens = 4000) {
    const fallback = () => ({ pruned: text, before: jsEstimate(text), after: jsEstimate(text), budget: maxTokens });
    if (!isEnabled()) return { result: fallback(), usedRust: false, timings: null };
    const t0 = process.hrtime.bigint();
    try {
      const msg = await request("tokens.prune", { text, max_tokens: maxTokens });
      const timings = {
        total_us: Number(process.hrtime.bigint() - t0) / 1000,
        rust_us: msg.elapsed_us ?? null,
      };
      if (msg.ok !== true || typeof msg.pruned !== "string") throw new Error(msg.error ?? "bad response");
      return {
        result: { pruned: msg.pruned, before: msg.before, after: msg.after, budget: msg.budget },
        usedRust: true,
        timings,
      };
    } catch {
      return { result: fallback(), usedRust: false, timings: null };
    }
  }

  function close() {
    try {
      child?.stdin?.end();
      child?.kill();
    } catch {}
    child = null;
  }

  return { estimate, estimateBatch, prune, close, jsEstimate, isEnabled };
}

// Cordis plugin entry: registers nothing by default; exposes the bridge on
// ctx for an explicit opt-in call site. No event subscription, so existing
// Web/API behavior is unchanged while disabled.
export function apply(ctx) {
  const bridge = createComputeBridge({ bin: resolveRdshBin() });
  ctx.rdshCompute = bridge;
  ctx.on?.("dispose", () => bridge.close());
}
