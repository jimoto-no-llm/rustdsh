import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ReleaseError } from "./release-artifacts.mjs";

export async function qualifyRelease(
  artifact,
  project,
  { requestTimeout = 15000, stopTimeout = 3000 } = {},
) {
  if (process.version !== artifact.manifest.tuple.node)
    throw new ReleaseError("adapter_runtime_changed_use_pinned_cli");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-release-check-"));
  const key = randomBytes(32).toString("hex");
  const ready = [];
  const server = http.createServer(async (req, res) => {
    if (
      req.method !== "POST" ||
      req.url !== "/ready" ||
      req.headers["x-rdsh-release-token"] !== key
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      let data = "";
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 1024) throw new Error();
      }
      const value = JSON.parse(data);
      const tuple = artifact.manifest.tuple;
      if (
        Object.keys(value).length !== 5 ||
        value.plugin !== "rdsh-release-probe" ||
        value.contract !== 1 ||
        value.node !== tuple.node ||
        value.platform !== tuple.platform ||
        value.arch !== tuple.arch
      )
        throw new Error();
      ready.push(value);
      res.writeHead(200).end("{}");
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
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
      ].includes(name),
    ),
  );
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    APPDATA: path.join(root, "data"),
    LOCALAPPDATA: path.join(root, "local"),
    RDSH_RELEASE_PROBE_BASE: `http://127.0.0.1:${server.address().port}/`,
    RDSH_RELEASE_PROBE_KEY: key,
  });
  const patch = path.join(root, "probe.patch.yml");
  const plugin = pathToFileURL(
    path.join(artifact.slot, "adapter/plugins/rdsh-release-probe/index.js"),
  ).href;
  const adapters = [];
  const result = {
    status: "failed",
    release_id: artifact.manifest.release_id,
    project_id: project.id,
    checked_at: new Date().toISOString(),
    checks: {
      start: "not_confirmed",
      plugin_start: "not_confirmed",
      stop: "not_confirmed",
      resume: "not_confirmed",
      plugin_resume: "not_confirmed",
    },
    native_session_id: null,
    authentication: "not_verified",
    model_request: "not_exercised",
    production_adoption: "not_requested",
    error: null,
    cleanup: "not_confirmed",
  };
  const loaded = async (count) => {
    const deadline = Date.now() + requestTimeout;
    while (ready.length < count && Date.now() < deadline) await delay(20);
    if (ready.length !== count)
      throw new ReleaseError("native_plugin_load_unconfirmed");
  };
  try {
    await fs.writeFile(
      patch,
      `- insert:\n    - id: rdsh-release-probe\n      name: ${JSON.stringify(plugin)}\n      config: {}\n`,
      { mode: 0o600 },
    );
    // Import the captured adapter, never a mutable globally installed adapter.
    const { createCliAdapter } = await import(
      pathToFileURL(path.join(artifact.slot, "adapter/dashboard/adapters.mjs"))
        .href
    );
    const create = () => {
      const adapter = createCliAdapter({
        command: artifact.command,
        cwd: project.root,
        env,
        patch,
        requestTimeout,
        stopTimeout,
      });
      adapters.push(adapter);
      return adapter;
    };
    const first = create();
    const started = await first.start();
    if (started.cli_version !== artifact.manifest.tuple.dsh)
      throw new ReleaseError("native_version_changed");
    result.native_session_id = started.session_id;
    result.checks.start = "acknowledged";
    await loaded(1);
    result.checks.plugin_start = "native_injection_observed";
    if (!(await first.stop()).confirmed)
      throw new ReleaseError("native_stop_unconfirmed");
    const second = create();
    const resumed = await second.resume(started.session_id);
    if (resumed.session_id !== started.session_id)
      throw new ReleaseError("native_session_changed");
    result.checks.resume = "same_native_id_acknowledged";
    await loaded(2);
    result.checks.plugin_resume = "native_injection_observed";
    if (!(await second.stop()).confirmed)
      throw new ReleaseError("native_stop_unconfirmed");
    result.checks.stop = "both_owned_exits_confirmed";
    result.status = "passed";
  } catch (error) {
    // Error codes only; provider/profile/log text can contain credentials.
    result.error = /^[a-z0-9_]{1,160}$/.test(error.code || "")
      ? error.code
      : "native_qualification_failed";
  } finally {
    const stops = await Promise.allSettled(adapters.map((a) => a.stop()));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (
      stops.some((r) => r.status === "rejected" || r.value.confirmed !== true)
    ) {
      result.status = "failed";
      result.error = "native_cleanup_unconfirmed";
      result.retained_home = root; // An unknown process may still own this home.
    } else {
      result.cleanup = "owned_exits_confirmed";
      if (
        path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
        !path.basename(root).startsWith("rdsh-release-check-")
      )
        throw new ReleaseError("invalid_owned_cleanup");
      await fs.rm(root, { recursive: true });
    }
  }
  return result;
}
