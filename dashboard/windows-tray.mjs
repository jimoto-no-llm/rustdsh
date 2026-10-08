import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// The tray receives no credentials or URLs. It controls only this server object.
export async function startWindowsTray({
  dashboard,
  open,
  label = "rdsh-dashboard",
  spawnProcess = spawn,
}) {
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
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env },
  );
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
      timer = setTimeout(
        () => reject(new Error("Windows tray did not become ready")),
        15000,
      );
      fail = () =>
        reject(new Error("Windows notification-area tray is unavailable"));
      child.once("error", fail);
      child.once("exit", fail);
      lines.on("line", (line) => {
        if (line === "ready") resolve();
        else if (line === "open" && !disposed) open(dashboard.browserUrl);
        else if (line === "exit") void stop();
      });
    });
  } catch (error) {
    dispose();
    child.kill(); // Only the exact tray helper created above.
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
  return { dispose };
}
