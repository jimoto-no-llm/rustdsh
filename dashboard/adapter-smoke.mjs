import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdapterError, createCliAdapter } from "./adapters.mjs";

export async function smokeAdapter({
  command = null,
  cwd = process.cwd(),
  requestTimeout = 15000,
  stopTimeout = 3000,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-acp-smoke-"));
  // No production home, credentials, provider keys, remote MCP or model request.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        "PATH",
        "Path",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "PATHEXT",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
      ].includes(key),
    ),
  );
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "data"),
  });
  const adapters = [];
  const create = () => {
    const adapter = createCliAdapter({
      command,
      cwd,
      env,
      requestTimeout,
      stopTimeout,
    });
    adapters.push(adapter);
    return adapter;
  };
  try {
    const first = create();
    const started = await first.start();
    const interrupt = await first.interrupt(started.session_id);
    const usage = first.usage(started.session_id);
    const firstStop = await first.stop();
    const second = create();
    await second.resume(started.session_id);
    const capabilities = second.capabilities();
    const secondStop = await second.stop();
    return {
      status: "passed",
      cli: "dsh",
      cli_version: first.version,
      protocol: capabilities.protocol,
      checks: {
        start: "acknowledged",
        resume: "acknowledged",
        send: "not_exercised_no_model_request",
        interrupt: interrupt.acknowledged
          ? "acknowledged"
          : "notification_written",
        stop:
          firstStop.confirmed && secondStop.confirmed
            ? "exit_confirmed"
            : "unconfirmed",
        usage: usage.status,
      },
      negotiated_capabilities: capabilities,
      runtime_state: "stopped",
      authentication: "not_verified",
      isolation: "temporary home, no inherited provider credentials",
    };
  } finally {
    const results = await Promise.allSettled(adapters.map((a) => a.stop()));
    // Keep the owned temp home when a process could still be using it.
    if (results.some((r) => r.status === "rejected"))
      throw new AdapterError("smoke_cleanup_unconfirmed");
    await fs.rm(root, { recursive: true, force: true });
  }
}
