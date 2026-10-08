// Observations only. This module never sends signals or reads command lines/env.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const pidValue = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
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
      // The interpolated value is a validated integer, never a caller's script.
      const script = `$ErrorActionPreference='Stop'; $scope=$null; try { $guid=[Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography','MachineGuid',$null); if ($guid -notmatch '^[0-9a-fA-F-]{36}$') { throw 'scope unavailable' }; $scope=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes('win32:'+$guid))).Replace('-','').ToLowerInvariant(); $p=[Diagnostics.Process]::GetProcessById(${pid}); if ($p.HasExited) { @{status='gone';scope=$scope} | ConvertTo-Json -Compress } else { @{status='observed';birth=$p.StartTime.ToUniversalTime().Ticks.ToString();scope=$scope} | ConvertTo-Json -Compress } } catch { if ($scope -and ($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException])) { @{status='gone';scope=$scope} | ConvertTo-Json -Compress } else { '{"status":"unknown"}' } }`;
      const executable = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const result = await exec(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          windowsHide: true,
          shell: false,
          timeout: 5000,
          maxBuffer: 4096,
        },
      );
      const data = JSON.parse(result.stdout);
      if (typeof data.scope !== "string" || !/^[0-9a-f]{64}$/.test(data.scope))
        throw new Error();
      scope = data.scope;
      if (data.status === "gone") return gone();
      const identity = {
        platform: "win32",
        pid,
        birth: data.birth,
        scope,
      };
      if (data.status !== "observed" || !validProcessIdentity(identity))
        throw new Error();
      return { status: "observed", identity };
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
