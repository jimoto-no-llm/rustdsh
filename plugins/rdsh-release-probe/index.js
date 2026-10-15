// Qualification only. Original Cordis injection is the plugin-load observation.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const inject = ["llm"];
export const name = "rdsh-release-probe";

// Feature switches live in $DSH_HOME/rdsh.json. An absent id (or a missing,
// unreadable or corrupt file) keeps the fallback; an explicit false disables
// the probe before any URL parsing or POST.
function featureEnabled(id, fallback, env = process.env) {
  try {
    const path = join(env.DSH_HOME || join(homedir(), ".dsh"), "rdsh.json");
    const value = JSON.parse(readFileSync(path, "utf8"))?.features?.[id];
    return typeof value === "boolean" ? value : fallback;
  } catch {
    return fallback;
  }
}

export function apply() {
  // Absent keeps the legacy behavior (run when the qualification env is set);
  // an explicit features.release_probe=false is the kill switch.
  if (!featureEnabled("release_probe", true)) return;
  const base = new URL(process.env.RDSH_RELEASE_PROBE_BASE);
  const key = process.env.RDSH_RELEASE_PROBE_KEY;
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !/^[a-f0-9]{64}$/.test(key || "")
  )
    throw new Error("Release probe requires a scoped loopback callback");
  void fetch(new URL("ready", base), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      "content-type": "application/json",
      "x-rdsh-release-token": key,
    },
    body: JSON.stringify({
      plugin: name,
      contract: 1,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
  }).catch(() => {});
}
