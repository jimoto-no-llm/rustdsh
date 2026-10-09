import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const foreground = args.includes("--no-tray");
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
if (
  process.platform !== "win32" ||
  foreground ||
  args.includes("--help") ||
  !["project", "harness"].includes(args[0])
) {
  const child = spawn(
    process.execPath,
    [cli, ...args.filter((arg) => arg !== "--no-tray")],
    { stdio: "inherit" },
  );
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  const child = spawn(process.execPath, [cli, ...args, "--tray"], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const timeout = setTimeout(() => {
    console.error(
      "Dashboard startup is unconfirmed; use rdsh-dashboard open/stop for this project.",
    );
    process.exitCode = 1;
    detach();
  }, 60000);
  function detach() {
    clearTimeout(timeout);
    if (child.connected) child.disconnect();
    child.unref();
  }
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
    detach();
  });
  child.once("exit", (code) => {
    clearTimeout(timeout);
    process.exitCode = code || 1;
  });
  child.once("message", (message) => {
    if (message.ready === true)
      console.log(
        "[rdsh-dashboard] Running in the Windows notification area; right-click for Open / Exit.",
      );
    else {
      console.error(`[rdsh-dashboard] ${message.error || "Startup failed"}`);
      if (message.tray_diagnostics)
        console.error(
          `[rdsh-dashboard] tray diagnostics: ${JSON.stringify(message.tray_diagnostics)}`,
        );
      process.exitCode = 1;
    }
    detach();
  });
}
