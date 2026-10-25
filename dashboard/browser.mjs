import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateHome } from "./project-identity.mjs";
import { powershellPath } from "./windows-tray.mjs";

export function openUrl(
  url,
  {
    platform = process.platform,
    spawnProcess = spawn,
    resolvePowerShell = powershellPath,
    directory = stateHome(),
    report = console.error,
    print = console.log,
  } = {},
) {
  if (platform !== "win32") {
    print(url);
    return;
  }
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    report("RustDSH could not open the Windows default browser.");
  };
  const observe = (child) => {
    child.once("error", fail);
    child.once("exit", (code) => {
      if (code !== 0) fail();
    });
    child.unref();
  };
  try {
    let powershell;
    try {
      powershell = resolvePowerShell();
    } catch {
      // --no-tray/open worked without PowerShell 7 before app windows were
      // supported. Retain that Windows URL activation as the fallback.
      const rundll32 = path.win32.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "rundll32.exe",
      );
      observe(
        spawnProcess(rundll32, ["url.dll,FileProtocolHandler", url], {
          windowsHide: true,
          detached: true,
          stdio: "ignore",
        }),
      );
      return;
    }
    const child = spawnProcess(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./open-windows-browser.ps1", import.meta.url)),
      ],
      {
        windowsHide: true,
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ url, stateDirectory: directory }));
    observe(child);
  } catch {
    fail();
  }
}
