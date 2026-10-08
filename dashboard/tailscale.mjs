import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function tailscaleExecutable() {
  const choices = process.env.RDSH_TAILSCALE_BIN
    ? [process.env.RDSH_TAILSCALE_BIN]
    : process.platform === "win32"
      ? ["C:/Program Files/Tailscale/tailscale.exe"]
      : ["tailscale"];
  for (const command of choices) {
    try {
      await exec(command, ["version"], { timeout: 5000, windowsHide: true });
      return command;
    } catch {}
  }
  return null;
}
export function checkPortConfig(config, hostname, port, target) {
  const authority = `${hostname}:${port}`;
  const visit = (entry) => {
    if (entry?.AllowFunnel?.[authority])
      throw new Error(
        "This port has public Funnel enabled; use a separate private Serve port",
      );
    const web = entry?.Web?.[authority];
    if (web) {
      const handlers = web.Handlers || {};
      if (Object.keys(handlers).length !== 1 || handlers["/"]?.Proxy !== target)
        throw new Error(
          "This Tailscale port already serves another application",
        );
    }
    const tcp = entry?.TCP?.[String(port)];
    if (tcp && (!tcp.HTTPS || !web))
      throw new Error("This Tailscale port already has another TCP service");
    for (const foreground of Object.values(entry?.Foreground || {}))
      visit(foreground);
  };
  visit(config);
  return Boolean(
    config?.TCP?.[String(port)]?.HTTPS &&
    config?.Web?.[authority]?.Handlers?.["/"]?.Proxy === target,
  );
}
export async function enableShare(port) {
  const command = await tailscaleExecutable();
  if (!command)
    return {
      state: "not_installed",
      message: "このPCにTailscaleをインストールしてください。",
      url: null,
    };
  try {
    const status = JSON.parse(
      (
        await exec(command, ["status", "--json"], {
          timeout: 5000,
          windowsHide: true,
        })
      ).stdout,
    );
    if (status.BackendState !== "Running" || !status.Self?.Online)
      return {
        state: "login_required",
        message:
          "このPCとスマホでTailscaleにログインし、接続してください。接続後に「接続を更新」を押すとQRコードが表示されます。",
        url: null,
      };
    const hostname = status.Self?.DNSName?.replace(/\.$/, "");
    if (!hostname || !/^[a-z0-9.-]+\.ts\.net$/i.test(hostname))
      return {
        state: "dns_required",
        message: "TailscaleのMagicDNSを有効にしてください。",
        url: null,
      };
    const target = `http://127.0.0.1:${port}`;
    const config = JSON.parse(
      (
        await exec(command, ["serve", "status", "--json"], {
          timeout: 5000,
          windowsHide: true,
        })
      ).stdout || "{}",
    );
    if (!checkPortConfig(config, hostname, port, target)) {
      await exec(
        command,
        ["serve", "--bg", `--https=${port}`, "--yes", target],
        { timeout: 15000, windowsHide: true },
      );
    }
    const verified = JSON.parse(
      (
        await exec(command, ["serve", "status", "--json"], {
          timeout: 5000,
          windowsHide: true,
        })
      ).stdout || "{}",
    );
    if (!checkPortConfig(verified, hostname, port, target))
      throw new Error("Tailscale Serve route could not be verified");
    return {
      state: "ready",
      message:
        "スマホでTailscaleに接続してから、QRコードを読み取ってください。",
      url: `https://${hostname}:${port}/`,
    };
  } catch (e) {
    // CLI output can contain a web consent URL; present it without storing account credentials.
    const consentUrl = `${e.stdout || ""}\n${e.stderr || ""}`.match(
      /https:\/\/login\.tailscale\.com\/[^\s<>"']+/,
    )?.[0];
    return {
      state: consentUrl ? "consent_required" : "setup_required",
      message: consentUrl
        ? "Tailscale Serveの利用設定が必要です。「利用設定を開く」で設定後、接続を更新してください。"
        : `Tailscale接続を確認してください: ${e.message.split("\n")[0]}`,
      consent_url: consentUrl || null,
      url: null,
    };
  }
}

// Read-only route inspection. Unlike enableShare, this never runs `serve --bg`.
export async function inspectShare(port, { executable, execute = exec } = {}) {
  const observed_at = new Date().toISOString();
  const command = executable || (await tailscaleExecutable());
  if (!command) return { state: "not_installed", observed_at };
  try {
    const status = JSON.parse(
      (
        await execute(command, ["status", "--json"], {
          timeout: 5000,
          windowsHide: true,
        })
      ).stdout,
    );
    if (status.BackendState !== "Running" || !status.Self?.Online)
      return { state: "login_required", observed_at };
    const hostname = status.Self?.DNSName?.replace(/\.$/, "");
    if (!hostname || !/^[a-z0-9.-]+\.ts\.net$/i.test(hostname))
      return { state: "dns_required", observed_at };
    const config = JSON.parse(
      (
        await execute(command, ["serve", "status", "--json"], {
          timeout: 5000,
          windowsHide: true,
        })
      ).stdout || "{}",
    );
    return {
      state: checkPortConfig(config, hostname, port, `http://127.0.0.1:${port}`)
        ? "ready"
        : "route_missing",
      observed_at,
    };
  } catch {
    return { state: "unconfirmed", reason: "route_check_failed", observed_at };
  }
}
