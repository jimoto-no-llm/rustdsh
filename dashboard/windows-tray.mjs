import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// The tray receives no credentials or URLs. It controls only this server object.
export async function startWindowsTray({
  dashboard,
  open,
  label = "rdsh-dashboard",
  spawnProcess = spawn,
}) {
  const started = performance.now();
  const phases = [{ phase: "spawn-requested", elapsed_ms: 0 }];
  let helperExit = null,
    spawnError = null,
    powershellVersion = null;
  let stderrBytes = 0,
    stderrTruncated = false;
  const stderrHash = createHash("sha256");
  let cleanup = { requested: false, exit_observed: false };
  const record = (phase) => {
    if (phases.length < 16)
      phases.push({
        phase,
        elapsed_ms: Math.round((performance.now() - started) * 1000) / 1000,
      });
  };
  const diagnostics = () => ({
    schema: 1,
    node: process.version,
    powershell: powershellVersion,
    elapsed_ms: Math.round((performance.now() - started) * 1000) / 1000,
    phases: phases.map((item) => ({ ...item })),
    helper_exit: helperExit ? { ...helperExit } : null,
    spawn_error_code: spawnError,
    stderr: {
      bytes: stderrBytes,
      sha256: stderrHash.copy().digest("hex"),
      truncated: stderrTruncated,
    },
    cleanup: { ...cleanup },
  });
  const env = Object.fromEntries(
    [
      "PATH",
      "Path",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "PATHEXT",
      "COMSPEC",
      "USERPROFILE",
      "LOCALAPPDATA",
      "APPDATA",
    ]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  env.RDSH_TRAY_LABEL = String(label)
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 63)
    .replace(/[\uD800-\uDBFF]$/, "");
  // Process-local policy permits this checkout's script (including WSL UNC paths).
  // Machine/user policy is never changed; enforced group policy still applies.
  const child = spawnProcess(
    "pwsh.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./windows-tray.ps1", import.meta.url)),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env },
  );
  child.once("spawn", () => record("process-spawned"));
  child.once("exit", (code, signal) => {
    helperExit = { code, signal: signal ?? null };
    record("process-exited");
  });
  child.on("error", (error) => {
    spawnError = /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code ?? "")
      ? error.code
      : "UNKNOWN";
  });
  child.stderr?.on("data", (data) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const remaining = 16384 - stderrBytes;
    if (remaining > 0) {
      const bounded = bytes.subarray(0, remaining);
      stderrHash.update(bounded);
      stderrBytes += bounded.length;
    }
    if (bytes.length > remaining) stderrTruncated = true;
  });
  const lines = createInterface({ input: child.stdout });
  let stopping = false,
    disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    child.stdin.end();
    lines.close();
    dashboard.server.off("close", dispose);
  }
  child.stdin.on("error", () => {});
  dashboard.server.once("close", dispose);
  async function stop() {
    if (stopping || disposed) return;
    stopping = true;
    try {
      await dashboard.close();
      dispose();
    } catch {
      // Failed ownership verification must retain the server and allow a retry.
      try {
        if (!disposed && child.stdin.writable)
          child.stdin.write(
            JSON.stringify({
              error:
                "Exit could not confirm that the owned run stopped. Dashboard remains available; retry Exit or inspect its stop status.",
            }) + "\n",
          );
      } catch {
        /* A lost tray pipe cannot turn an unverified stop into success. */
      }
    } finally {
      stopping = false;
    }
  }
  let timer, fail;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        record("ready-timeout");
        reject(new Error("Windows tray did not become ready"));
      }, 15000);
      fail = () =>
        reject(new Error("Windows notification-area tray is unavailable"));
      child.once("error", fail);
      child.once("exit", fail);
      lines.on("line", (line) => {
        if (line === "ready") {
          record("ready");
          resolve();
        } else if (
          /^phase:(powershell-start|forms-loaded|drawing-loaded|stdin-reader-started)(?::[0-9A-Za-z.+-]{1,32})?$/.test(
            line,
          )
        ) {
          const [, phase, version] = line.split(":");
          if (phase === "powershell-start") powershellVersion = version ?? null;
          record(phase);
        } else if (line === "open" && !disposed) open(dashboard.browserUrl);
        else if (line === "exit") void stop();
      });
    });
  } catch (error) {
    dispose();
    // Observe the exact helper's exit after killing it; timeout is never proof.
    cleanup.requested = true;
    if (typeof child.pid === "number" && !helperExit) {
      cleanup.exit_observed = await new Promise((resolve) => {
        const finished = () => {
          clearTimeout(limit);
          child.off("exit", finished);
          resolve(true);
        };
        const limit = setTimeout(() => {
          child.off("exit", finished);
          resolve(false);
        }, 5000);
        child.once("exit", finished);
        child.kill();
      });
    } else {
      child.kill(); // Only the exact tray helper created above, including fixtures.
      cleanup.exit_observed = helperExit !== null;
    }
    error.trayDiagnostics = diagnostics();
    throw error;
  } finally {
    clearTimeout(timer);
    child.off("error", fail);
    child.off("exit", fail);
  }
  child.on("error", () => {
    void stop();
  });
  child.once("exit", () => {
    void stop();
  });
  return { dispose, diagnostics };
}
