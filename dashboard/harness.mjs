import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawnOwnedProcess } from "./process-scope.mjs";
import { RunHistory } from "./run-history.mjs";

export async function startHarness(port, frontPort, options = {}) {
  // A managed instance keeps the original Harness process token and its browser fence intact.
  if (process.platform !== "win32" && !options.command)
    throw new Error(
      "Harness mode currently requires Windows + WSL; project mode is portable",
    );
  const distro = process.env.RDSH_WSL_DISTRO || "FlashNext";
  const wrapper =
    process.env.RDSH_WSL_HARNESS_BIN || "/root/.local/bin/rdsh-env";
  const command = options.command ?? [
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
  ];
  const history = await RunHistory.open(options.project);
  const run_id = "run_" + randomUUID();
  await history.register(run_id);
  await history.transition(run_id, "starting", "request_recorded");
  await history.scopeIntent(run_id);
  let historyError = null;
  const stages = [];
  const owned = await spawnOwnedProcess({
    command,
    cwd: options.cwd ?? "/root",
    env: options.env,
    wsl: options.wsl ?? (options.command ? null : distro),
    wslNode: process.env.RDSH_WSL_NODE,
    owner_id: history.owner_id,
    onStage: async (stage) => {
      stages.push(stage);
      try {
        await history.stopStage(run_id, stage);
      } catch {
        historyError = "history_write_failed";
      }
    },
  });
  const child = owned.child;
  try {
    await history.bindScope(run_id, owned.descriptor);
    await history.bindProcess(
      run_id,
      owned.descriptor.root_identity,
      child.pid,
    );
  } catch (error) {
    await owned.stop();
    throw error;
  }
  child.on("exit", () => {
    void history.processExited(run_id).catch(() => {
      historyError = "history_write_failed";
    });
  });
  let output = "";
  let stopping = null,
    final = null;
  const stop = () => {
    stopping ??= (async () => {
      const commandId = await history
        .recordCommand(run_id, "stop")
        .catch(() => {
          historyError = "history_write_failed";
        });
      if (commandId) {
        try {
          await history.transition(run_id, "stopping", "owned_stop_requested");
          await history.commandPhase(commandId, "dispatched");
        } catch {
          historyError = "history_write_failed";
        }
      }
      const result = await owned.stop({
        gracefulTimeout: options.stopTimeout ?? 3000,
        killTimeout: options.stopTimeout ?? 3000,
      });
      if (commandId) {
        try {
          await history.commandPhase(
            commandId,
            result.confirmed ? "acknowledged" : "unknown",
            result.confirmed ? "process_exit_confirmed" : null,
          );
        } catch {
          historyError = "history_write_failed";
        }
      }
      final = historyError
        ? {
            ...result,
            status: "unverifiable",
            confirmed: false,
            reason: historyError,
          }
        : result;
      return final;
    })();
    return stopping;
  };
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            "Harness startup timed out; check the existing dsh web profile",
          ),
        ),
      45000,
    );
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-32000);
      const match = output.match(
        /dsh web: (http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/,
      );
      if (match) {
        clearTimeout(timeout);
        resolve(new URL(match[1]));
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Harness exited with code ${code}; port ${port} may already be used`,
        ),
      );
    });
  });
  try {
    await owned.release();
    const url = await ready;
    await history.transition(run_id, "waiting-human", "cli_session_attached");
    return {
      child,
      url,
      port,
      stop,
      run_id,
      inspect: async () => ({
        run_id,
        scope:
          final ??
          (stopping
            ? { ...owned.state, status: "stopping", confirmed: false }
            : await owned.inspect()),
        stages: structuredClone(stages),
      }),
      disconnectMonitor: () => owned.disconnectMonitor(),
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
function upstreamHeaders(req, port, cookieName, adminToken) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  if (headers.cookie) {
    headers.cookie = headers.cookie
      .split(";")
      .map((item) => item.trim())
      .filter((item) => item.split("=", 1)[0] !== cookieName)
      .join("; ");
    if (!headers.cookie) delete headers.cookie;
  }
  if (headers.authorization === `Bearer ${adminToken}`)
    delete headers.authorization;
  return headers;
}
export function proxyHarness(req, res, port, cookieName, adminToken) {
  // Only authenticated same-origin callers reach this proxy. dsh still checks its own process token.
  // #12 contract fence: out-of-contract targets never start here; the proxy
  // only forwards, it never widens the allowed scope.
  // #15 capped plan: no extra workers are spawned here; one upstream per
  // request keeps concurrency bounded by the caller's plan.
  const headers = upstreamHeaders(req, port, cookieName, adminToken);
  if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
  if (headers.referer) headers.referer = `http://127.0.0.1:${port}/`;
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  const upstream = http.request(
    { hostname: "127.0.0.1", port, path: req.url, method: req.method, headers },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("Harness is not available; confirm it is running and retry");
  });
  req.pipe(upstream);
}
export function upgradeHarness(
  req,
  socket,
  head,
  port,
  cookieName,
  adminToken,
) {
  const upstream = net.connect(port, "127.0.0.1", () => {
    const headers = upstreamHeaders(req, port, cookieName, adminToken);
    if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
    const raw = `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n")}\r\n\r\n`;
    upstream.write(raw);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
}
