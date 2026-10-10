import { spawnOwnedProcess } from "./process-scope.mjs";

export class UnsupportedHarnessProviderError extends Error {
  constructor(provider, reason) {
    super(
      `Harness provider '${provider}' is unavailable: ${reason}; no fallback was attempted`,
    );
    this.name = "UnsupportedHarnessProviderError";
    this.code = "harness_provider_unavailable";
    this.provider = provider;
    this.reason = reason;
  }
}

function readReadyUrl(child, { timeout = 45_000, port }) {
  return new Promise((resolve, reject) => {
    let output = "";
    const finish = (error, url) => {
      clearTimeout(timer);
      child.stdout.removeListener("data", capture);
      child.stderr.removeListener("data", capture);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve(url);
    };
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-32_000);
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/);
      if (match) {
        const url = new URL(match[1]);
        if (url.port !== String(port)) {
          finish(new Error(`Harness reported an unexpected port; expected ${port}`));
          return;
        }
        finish(null, url);
      }
    };
    const onError = (error) => finish(error);
    const onExit = (code) =>
      finish(
        new Error(
          `Harness exited with code ${code}; port ${port} may already be used`,
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new Error("Harness startup timed out; check the existing dsh web profile"),
        ),
      timeout,
    );
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function provider({ id, label, capabilities, launchOptions }) {
  return Object.freeze({
    id,
    status: Object.freeze({
      id,
      label,
      capabilities: Object.freeze(capabilities),
    }),
    launchOptions,
    start: (options) => spawnOwnedProcess(options),
    waitUntilReady: (child, options) => readReadyUrl(child, options),
    health: (owned) => owned.inspect(),
    stop: (owned, options) => owned.stop(options),
  });
}

function windowsWslProvider({ env, platform }) {
  if (platform !== "win32")
    throw new UnsupportedHarnessProviderError(
      "windows-wsl",
      "the managed Harness currently requires Windows and WSL; project mode remains portable",
    );
  const distro = env.RDSH_WSL_DISTRO || "FlashNext";
  const wrapper = env.RDSH_WSL_HARNESS_BIN || "/root/.local/bin/rdsh-env";
  return provider({
    id: "windows-wsl",
    label: "Windows + WSL",
    capabilities: {
      execution: "wsl",
      connection: "loopback",
      readiness: "dsh-web-url",
      health: "owned-process-scope",
      stop: "verified-owned-descendants",
      remote: false,
    },
    launchOptions: ({ port, frontPort, options }) => ({
      command: [
        wrapper,
        "dsh",
        "--profile",
        "web",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-open",
        "--trusted-host",
        `127.0.0.1:${frontPort}`,
        `localhost:${frontPort}`,
      ],
      cwd: options.cwd ?? "/root",
      env: options.env,
      wsl: options.wsl ?? distro,
      wslNode: env.RDSH_WSL_NODE,
    }),
  });
}

function commandProvider(options) {
  return provider({
    id: "provided-command",
    label: "Provided command",
    capabilities: {
      execution: "provided-command",
      connection: "loopback",
      readiness: "dsh-web-url",
      health: "owned-process-scope",
      stop: "verified-owned-descendants",
      remote: false,
    },
    launchOptions: () => ({
      command: options.command,
      cwd: options.cwd,
      env: options.env,
      wsl: options.wsl,
    }),
  });
}

export function resolveHarnessProvider(options = {}) {
  if (options.command) return commandProvider(options);
  const env = options.providerEnv ?? process.env;
  const id = options.provider ?? env.RDSH_HARNESS_PROVIDER ?? "windows-wsl";
  if (id === "windows-wsl")
    return windowsWslProvider({
      env,
      platform: options.platform ?? process.platform,
    });
  const reason = ["linux-native", "macos-native", "remote"].includes(id)
    ? "this provider has no verified launch, readiness, health, and scoped-stop adapter yet"
    : "the provider name is unknown";
  throw new UnsupportedHarnessProviderError(id, reason);
}
