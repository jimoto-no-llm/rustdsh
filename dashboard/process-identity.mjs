// Observations only. This module never sends signals or reads command lines/env.
import fs from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const pidValue = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const windowsIdentityHelper = fileURLToPath(
  new URL("./process-identity-windows.mjs", import.meta.url),
);

export function validProcessIdentity(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    ["win32", "linux"].includes(value.platform) &&
    pidValue(value.pid) &&
    typeof value.birth === "string" &&
    /^[1-9][0-9]{0,29}$/.test(value.birth) &&
    typeof value.scope === "string" &&
    /^[0-9a-f]{64}$/.test(value.scope)
  );
}
export async function readProcessIdentity(pid) {
  if (!pidValue(pid)) return { status: "unknown", identity: null };
  let scope = null;
  const gone = () => ({
    status: "gone",
    identity: null,
    platform: process.platform,
    scope,
  });
  try {
    if (process.platform === "linux") {
      const [boot, namespace] = await Promise.all([
        fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        fs.readlink("/proc/self/ns/pid"),
      ]);
      if (!/^[0-9a-f-]{36}\s*$/.test(boot) || !/^pid:\[\d+\]$/.test(namespace))
        throw new Error();
      scope = digest(os.hostname() + "\n" + boot.trim() + "\n" + namespace);
      // comm can contain spaces and ')' characters: split after its final ')'.
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const closing = stat.lastIndexOf(")");
      if (closing < 0 || !stat.startsWith(pid + " (")) throw new Error();
      const fields = stat
        .slice(closing + 2)
        .trim()
        .split(/\s+/);
      if (["Z", "X", "x"].includes(fields[0])) return gone();
      const identity = {
        platform: "linux",
        pid,
        birth: fields[19],
        scope,
      };
      if (!validProcessIdentity(identity)) throw new Error();
      return { status: "observed", identity };
    }
    if (process.platform === "win32") {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC)$/i.test(key),
        ),
      );
      const { stdout } = await exec(
        process.execPath,
        [windowsIdentityHelper, String(pid)],
        {
          env,
          windowsHide: true,
          shell: false,
          timeout: 5000,
          maxBuffer: 4096,
        },
      );
      const observed = JSON.parse(stdout);
      if (
        observed.status === "gone" &&
        observed.platform === "win32" &&
        typeof observed.scope === "string" &&
        /^[0-9a-f]{64}$/.test(observed.scope)
      )
        return observed;
      if (
        observed.status === "observed" &&
        validProcessIdentity(observed.identity)
      )
        return observed;
    }
  } catch (error) {
    // ENOENT for an absent /proc/PID is an observation, not a guessed exit code.
    if (process.platform === "linux" && error.code === "ENOENT") {
      try {
        await fs.stat(`/proc/${pid}`);
      } catch (missing) {
        if (missing.code === "ENOENT" && scope) return gone();
      }
    }
  }
  return { status: "unknown", identity: null };
}
export function matchProcessIdentity(expected, observation) {
  if (!validProcessIdentity(expected)) return "unknown";
  if (observation?.status === "gone")
    return observation.platform === expected.platform &&
      observation.scope === expected.scope
      ? "gone"
      : "unknown";
  if (
    observation?.status !== "observed" ||
    !validProcessIdentity(observation.identity)
  )
    return "unknown";
  const current = observation.identity;
  // A different host/boot/PID namespace cannot establish absence in the old one.
  if (
    current.platform !== expected.platform ||
    current.scope !== expected.scope ||
    current.pid !== expected.pid
  )
    return "unknown";
  return current.birth === expected.birth ? "alive" : "pid_reused";
}
