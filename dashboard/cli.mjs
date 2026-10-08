#!/usr/bin/env node
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { identity, stateHome } from "./state.mjs";
import { startDashboard } from "./server.mjs";
import { runStdio } from "./mcp.mjs";
import { adapterCatalog, createCliAdapter } from "./adapters.mjs";
import { smokeAdapter } from "./adapter-smoke.mjs";
import { SessionLedger, attachRecordedSession } from "./session-ledger.mjs";
import { preflightCli, readRequirements } from "./preflight.mjs";
import { RunHistory } from "./run-history.mjs";
import { RetryHistory } from "./retry.mjs";
import { probeCliWithRetry } from "./retry-probe.mjs";
import { Checkpoints } from "./checkpoints.mjs";
import { AcceptanceStore } from "./acceptance.mjs";

const help = `rdsh-dashboard project --project <directory> [--port <port>] [--no-tailscale] [--open]
rdsh-dashboard harness [--port 38081] [--harness-port 3081] [--no-tailscale] [--open]
rdsh-dashboard open --project <directory> | --harness
rdsh-dashboard stop --project <directory> | --harness
rdsh-dashboard revoke-events --project <directory>
rdsh-dashboard tunnel --project <directory> --tunnel-id <tunnel_id>
rdsh-dashboard mcp --project <directory>
rdsh-dashboard adapters [--cli dsh] [--executable <original-dsh>] [--entrypoint <bin.js>] [--project <directory>] [--retry] [--retry-attempts <n>] [--retry-total-ms <ms>]
rdsh-dashboard adapter-smoke --executable <original-dsh> [--entrypoint <bin.js>] [--project <directory>]
rdsh-dashboard preflight --project <directory> [--requirements <json>] [--executable <original-dsh>] [--entrypoint <bin.js>] [--verify-auth]
rdsh-dashboard run-history list|inspect|events --project <directory> [--run-id <run_id>] [--cursor <number>] [--limit <number>]
rdsh-dashboard retry-history list|inspect --project <directory> [--operation-id <id>]
rdsh-dashboard checkpoint record|list|inspect|resume|start-new --project <directory> [--run-id <id>] [--checkpoint-id <id>] [--executable <original-dsh>] [--entrypoint <bin.js>] [--verify-native] [--retry-operation-id <id>] [--summary-file <file> --accept-context-loss]
rdsh-dashboard acceptance define|run|report|inspect --project <directory> --task-id <id> [--criterion-id <id>] [--criteria-file <json>] [--argv-file <json>] [--result-file <json>] [--scope full|partial] [--timeout-ms <ms>] [--image <relative-path>]
rdsh-dashboard session-ledger list|record|resolve|start|resume --project <directory> [--run-id <run_id>] [--task-id <id>] [--session-id <id>] [--label <name>] [--provider <name>] [--cwd <directory>] [--cli <name>] [--executable <original-dsh>] [--entrypoint <bin.js>]

Project mode: project metrics, tasks, questions, human feedback, and /mcp.
Harness mode: a separate managed DeepSeek Harness Web UI and QR landing page.
Tailscale Serve shares each loopback server privately over HTTPS.
Session-ledger start/resume confirms the native ID then stops its owned ACP process; it sends no prompt.
`;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    port: { type: "string" },
    "harness-port": { type: "string" },
    "no-tailscale": { type: "boolean" },
    "tunnel-id": { type: "string" },
    open: { type: "boolean" },
    harness: { type: "boolean" },
    cli: { type: "string" },
    executable: { type: "string" },
    entrypoint: { type: "string" },
    "run-id": { type: "string" },
    "task-id": { type: "string" },
    "session-id": { type: "string" },
    label: { type: "string" },
    provider: { type: "string" },
    cwd: { type: "string" },
    requirements: { type: "string" },
    "verify-auth": { type: "boolean" },
    cursor: { type: "string" },
    limit: { type: "string" },
    retry: { type: "boolean" },
    "retry-attempts": { type: "string" },
    "retry-total-ms": { type: "string" },
    "operation-id": { type: "string" },
    "checkpoint-id": { type: "string" },
    "retry-operation-id": { type: "string", multiple: true },
    "verify-native": { type: "boolean" },
    "summary-file": { type: "string" },
    "accept-context-loss": { type: "boolean" },
    "criterion-id": { type: "string" },
    "criteria-file": { type: "string" },
    "argv-file": { type: "string" },
    "result-file": { type: "string" },
    scope: { type: "string" },
    "timeout-ms": { type: "string" },
    image: { type: "string", multiple: true },
    help: { type: "boolean", short: "h" },
  },
});
function openUrl(url) {
  // Non-Windows shells can't hand a URL to a browser here; print it so
  // `rdsh-dashboard open` still resolves to something usable.
  if (process.platform !== "win32") {
    console.log(url);
    return;
  }
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
function portValue(value) {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Port must be an integer between 1024 and 65535");
  return port;
}
async function localJson(file) {
  if (!file) throw new Error("Specify the input JSON file");
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024)
      throw new Error("Input JSON must be a regular file of at most 256 KiB");
    const bytes = await handle.readFile();
    if (bytes.length > 256 * 1024)
      throw new Error("Input JSON exceeds 256 KiB");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new Error("Input JSON is invalid");
    }
  } finally {
    await handle.close();
  }
}
try {
  const command = positionals[0];
  if (
    command !== "retry-history" &&
    !values.retry &&
    (values["retry-attempts"] !== undefined ||
      values["retry-total-ms"] !== undefined ||
      values["operation-id"] !== undefined)
  )
    throw new Error("Retry options require --retry");
  if (values.retry && command !== "adapters")
    throw new Error("--retry is available for adapters only");
  if (
    command !== "checkpoint" &&
    [
      values["checkpoint-id"],
      values["retry-operation-id"],
      values["verify-native"],
      values["summary-file"],
      values["accept-context-loss"],
    ].some((value) => value !== undefined)
  )
    throw new Error("Checkpoint options require checkpoint");
  if (
    command !== "acceptance" &&
    [
      "criterion-id",
      "criteria-file",
      "argv-file",
      "result-file",
      "scope",
      "timeout-ms",
      "image",
    ].some((key) => values[key] !== undefined)
  )
    throw new Error("Acceptance options require acceptance");
  if (values.help || !command) {
    console.log(help);
  } else if (command === "acceptance") {
    const action = positionals[1];
    if (
      positionals.length !== 2 ||
      !["define", "run", "report", "inspect"].includes(action)
    )
      throw new Error("Specify acceptance define, run, report or inspect");
    const acceptanceOptions = new Set([
      "project",
      "task-id",
      "criterion-id",
      "criteria-file",
      "argv-file",
      "result-file",
      "scope",
      "timeout-ms",
      "image",
      "help",
    ]);
    if (Object.keys(values).some((key) => !acceptanceOptions.has(key)))
      throw new Error("Unsupported option for acceptance");
    const store = await AcceptanceStore.open(
        await identity(values.project || process.cwd()),
      ),
      task = values["task-id"];
    if (
      (action !== "define" && values["criteria-file"] !== undefined) ||
      (action !== "run" &&
        (values["argv-file"] !== undefined ||
          values["timeout-ms"] !== undefined)) ||
      (action !== "report" && values["result-file"] !== undefined)
    )
      throw new Error("Input options must match the acceptance action");
    if (
      ["define", "inspect"].includes(action) &&
      [values["criterion-id"], values.scope, values.image].some(
        (value) => value !== undefined,
      )
    )
      throw new Error(
        "Criterion, scope and images apply to run or report only",
      );
    let result;
    if (action === "define")
      result = await store.define(
        task,
        await localJson(values["criteria-file"]),
      );
    else if (action === "inspect") result = await store.inspect(task);
    else
      result = await store.perform({
        task_id: task,
        criterion_id: values["criterion-id"],
        scope: values.scope || "full",
        images: values.image || [],
        ...(action === "run"
          ? {
              argv: await localJson(values["argv-file"]),
              timeout_ms:
                values["timeout-ms"] === undefined
                  ? 60000
                  : Number(values["timeout-ms"]),
            }
          : { reported: await localJson(values["result-file"]) }),
      });
    console.log(JSON.stringify(result, null, 2));
    if (
      ["run", "report"].includes(action) &&
      ["fail", "blocked"].includes(result.status)
    )
      process.exitCode = 1;
  } else if (command === "preflight") {
    await preflightCli(process.argv.slice(3));
  } else if (command === "checkpoint") {
    const action = positionals[1];
    if (
      positionals.length !== 2 ||
      !["record", "list", "inspect", "resume", "start-new"].includes(action)
    )
      throw new Error(
        "Specify checkpoint record, list, inspect, resume or start-new",
      );
    const store = await Checkpoints.open(
      await identity(values.project || process.cwd()),
    );
    const argv = values.executable ? [values.executable] : null;
    if (values.entrypoint && !argv)
      throw new Error("--entrypoint requires --executable");
    if (values.entrypoint) argv.push(values.entrypoint);
    if (values.cli && values.cli !== "dsh")
      throw new Error("Checkpoint native recovery supports DSH only");
    if (
      action !== "start-new" &&
      (values["summary-file"] !== undefined || values["accept-context-loss"])
    )
      throw new Error(
        "Summary and context-loss choice apply to start-new only",
      );
    if (
      action !== "record" &&
      (values["run-id"] !== undefined ||
        values["retry-operation-id"] !== undefined)
    )
      throw new Error("Run and retry references apply to record only");
    if (action !== "inspect" && values["verify-native"])
      throw new Error("--verify-native applies to inspect only");
    if (action === "list" && (argv || values["checkpoint-id"]))
      throw new Error("list takes no executable or checkpoint ID");
    let result;
    if (action === "list") result = await store.list();
    else if (action === "record") {
      if (values["checkpoint-id"])
        throw new Error("record allocates a checkpoint ID");
      if (!argv) throw new Error("Specify the original CLI executable");
      result = await store.record({
        run_id: values["run-id"],
        command: argv,
        retry_operations: values["retry-operation-id"] || [],
      });
    } else if (action === "inspect") {
      result = await store.inspect(values["checkpoint-id"], {
        command: argv,
        verify_native: values["verify-native"] || false,
      });
    } else {
      if (!argv) throw new Error("Specify the original CLI executable");
      let summary = null;
      if (action === "start-new") {
        if (!values["summary-file"] || !values["accept-context-loss"])
          throw new Error(
            "start-new requires --summary-file and --accept-context-loss",
          );
        const handle = await fs.open(values["summary-file"], "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 65536)
            throw new Error(
              "Summary must be a regular file of at most 65536 bytes",
            );
          const bytes = await handle.readFile();
          if (bytes.length > 65536)
            throw new Error("Summary exceeds 65536 bytes");
          summary = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } finally {
          await handle.close();
        }
      }
      result = await store.recover(values["checkpoint-id"], {
        mode: action === "resume" ? "resume" : "start_new",
        command: argv,
        summary,
        accept_context_loss: values["accept-context-loss"] || false,
      });
    }
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "retry-history") {
    const action = positionals[1];
    if (positionals.length !== 2 || !["list", "inspect"].includes(action))
      throw new Error("Specify retry-history list or inspect");
    const history = await RetryHistory.open(
      await identity(values.project || process.cwd()),
    );
    const result =
      action === "list"
        ? await history.list()
        : await history.inspect(values["operation-id"]);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "run-history") {
    const action = positionals[1];
    if (
      positionals.length !== 2 ||
      !["list", "inspect", "events"].includes(action)
    )
      throw new Error("Specify run-history list, inspect or events");
    const history = await RunHistory.open(
      await identity(values.project || process.cwd()),
    );
    const paging = {
      after: values.cursor === undefined ? 0 : Number(values.cursor),
      ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
    };
    if (
      action === "inspect" &&
      (values.cursor !== undefined || values.limit !== undefined)
    )
      throw new Error("Paging applies to list or events");
    const result =
      action === "list"
        ? await history.list(paging)
        : action === "events"
          ? await history.events(values["run-id"], paging)
          : await history.inspect(values["run-id"]);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "session-ledger") {
    const action = positionals[1];
    if (
      positionals.length !== 2 ||
      !["list", "record", "resolve", "start", "resume"].includes(action)
    )
      throw new Error(
        "Specify session-ledger list, record, resolve, start or resume",
      );
    const ledger = await SessionLedger.open(
      await identity(values.project || process.cwd()),
    );
    const argv = values.executable ? [values.executable] : null;
    if (values.entrypoint && !argv)
      throw new Error("--entrypoint requires --executable");
    if (values.entrypoint) argv.push(values.entrypoint);
    const options = {
      ledger,
      command: argv,
      cwd: values.cwd || ledger.project.root,
      task_id: values["task-id"] || null,
      label: values.label || null,
      provider: values.provider || null,
    };
    let result;
    if (action === "list") result = { runs: await ledger.list() };
    else if (action === "resolve")
      result = await ledger.resolve(values["run-id"]);
    else if (action === "record") {
      if (values["run-id"]) throw new Error("record allocates a new run ID");
      result = await ledger.record({
        ...options,
        cli: values.cli || "dsh",
        cli_session_id: values["session-id"] || null,
      });
    } else {
      if (!argv)
        throw new Error(
          "Specify the original DSH executable with --executable",
        );
      if (values.cli && values.cli !== "dsh")
        throw new Error("Only DSH ACP can be attached");
      if (values["session-id"])
        throw new Error(
          "Use run-id for resume; session IDs come from the native CLI",
        );
      if (action === "start" && values["run-id"])
        throw new Error("start allocates a new run ID");
      if (action === "resume" && !values["run-id"])
        throw new Error("resume requires --run-id");
      if (
        action === "resume" &&
        [values.cwd, values["task-id"], values.label, values.provider].some(
          (value) => value !== undefined,
        )
      )
        throw new Error("resume uses the recorded cwd, task and provider");
      const attached = await attachRecordedSession({
        ...options,
        run_id: action === "resume" ? values["run-id"] : null,
        requirements: values.requirements
          ? await readRequirements(values.requirements)
          : null,
        verifyAuth: values["verify-auth"] || false,
      });
      const stopped = await attached.adapter.stop();
      result = {
        run: attached.record,
        command_id: attached.command_id,
        history: await attached.history.inspect(attached.record.run_id),
        lifecycle: "attachment_verified_process_stopped",
        process: stopped,
      };
    }
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "adapters" || command === "adapter-smoke") {
    const argv = values.executable ? [values.executable] : null;
    if (values.entrypoint && !argv)
      throw new Error("--entrypoint requires --executable");
    if (values.entrypoint) argv.push(values.entrypoint);
    if (values.retry) {
      if (command !== "adapters" || values.cli !== "dsh" || !argv)
        throw new Error(
          "--retry requires adapters --cli dsh and explicit original CLI paths",
        );
      const budget = {
        ...(values["retry-attempts"] === undefined
          ? {}
          : { max_attempts: Number(values["retry-attempts"]) }),
        ...(values["retry-total-ms"] === undefined
          ? {}
          : { total_ms: Number(values["retry-total-ms"]) }),
      };
      const report = await probeCliWithRetry({
        history: await RetryHistory.open(
          await identity(values.project || process.cwd()),
        ),
        operation_id: values["operation-id"],
        command: argv,
        cwd: values.project || process.cwd(),
        budget,
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.retry.status !== "completed" || report.adapter === null)
        process.exitCode = 1;
    } else if (command === "adapter-smoke") {
      if (!argv)
        throw new Error(
          "Specify the original DSH executable with --executable",
        );
      if (values.cli && values.cli !== "dsh")
        throw new Error("Smoke supports the DSH ACP adapter only");
      console.log(
        JSON.stringify(
          await smokeAdapter({
            command: argv,
            cwd: values.project || process.cwd(),
          }),
          null,
          2,
        ),
      );
    } else if (values.cli) {
      const adapter = createCliAdapter({
        cli: values.cli,
        command: argv,
        cwd: values.project || process.cwd(),
      });
      const report = await adapter.probe();
      console.log(JSON.stringify(report, null, 2));
      if (!["version_matched", "compatible"].includes(report.health))
        process.exitCode = 1;
    } else {
      if (values.executable || values.entrypoint)
        throw new Error("Specify --cli when probing an executable");
      console.log(JSON.stringify({ adapters: adapterCatalog() }, null, 2));
    }
  } else if (["open", "stop", "revoke-events"].includes(command)) {
    const project = values.harness
      ? null
      : await identity(values.project || process.cwd());
    const directory = project
      ? project.directory
      : path.join(stateHome(), "harness");
    const runtime = JSON.parse(
      await fs.readFile(path.join(directory, "runtime.json"), "utf8"),
    );
    try {
      process.kill(runtime.pid, 0);
    } catch {
      throw new Error("Dashboard is stopped; start it first");
    }
    if (command === "open") openUrl(runtime.browser_url);
    else {
      if (command === "revoke-events" && values.harness)
        throw new Error("Events are available in project mode only");
      const prefix = values.harness ? "_rdsh/" : "";
      const response = await fetch(
        runtime.local_url +
          prefix +
          "api/" +
          (command === "stop" ? "stop" : "events/revoke"),
        {
          method: "POST",
          headers: { authorization: `Bearer ${runtime.token}` },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok)
        throw new Error(
          (await response.json()).error || `HTTP ${response.status}`,
        );
      console.log(
        `[rdsh-dashboard] ${command === "stop" ? "Stopping dashboard" : "Event subscriptions revoked"}`,
      );
    }
  } else if (command === "tunnel") {
    if (!/^tunnel_[a-z0-9]{32}$/.test(values["tunnel-id"] || ""))
      throw new Error(
        "Provide the tunnel_id from OpenAI Platform tunnel settings",
      );
    if (!process.env.CONTROL_PLANE_API_KEY)
      throw new Error(
        "Set CONTROL_PLANE_API_KEY locally before connecting; do not put keys in command arguments or chat",
      );
    const project = await identity(values.project || process.cwd());
    const runtime = JSON.parse(
      await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
    );
    const response = await fetch(runtime.local_url + "api/state", {
      headers: { authorization: `Bearer ${runtime.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(
        "Start the project dashboard before connecting its tunnel",
      );
    const command =
      process.env.RDSH_TUNNEL_CLIENT ||
      (process.platform === "win32"
        ? path.join(
            process.env.LOCALAPPDATA,
            "rdsh",
            "tunnel-client",
            "tunnel-client.exe",
          )
        : "tunnel-client");
    const child = spawn(
      command,
      [
        "run",
        "--control-plane.tunnel-id",
        values["tunnel-id"],
        "--control-plane.api-key",
        "env:CONTROL_PLANE_API_KEY",
        "--mcp.server-url",
        runtime.local_url + "mcp",
        "--mcp.extra-headers",
        "Authorization: env:RDSH_DASHBOARD_AUTHORIZATION",
        "--mcp.discovery-extra-headers",
        "Authorization: env:RDSH_DASHBOARD_AUTHORIZATION",
        "--health.listen-addr",
        "127.0.0.1:0",
        "--health.url-file",
        path.join(project.directory, "tunnel-health.url"),
      ],
      {
        windowsHide: true,
        stdio: "inherit",
        env: {
          ...process.env,
          RDSH_DASHBOARD_AUTHORIZATION: `Bearer ${runtime.mcp_token}`,
        },
      },
    );
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } else if (command === "mcp") {
    await runStdio(await identity(values.project || process.cwd()));
  } else if (command === "project" || command === "harness") {
    const dashboard = await startDashboard({
      kind: command,
      project:
        command === "project"
          ? await identity(values.project || process.cwd())
          : null,
      port: portValue(values.port),
      harnessPort: portValue(values["harness-port"]),
      tailscale: !values["no-tailscale"],
    });
    console.log(`[rdsh-dashboard] ${command}: ${dashboard.localUrl}`);
    console.log(`[rdsh-dashboard] Tailscale: ${dashboard.getShare().state}`);
    console.log(`[rdsh-dashboard] ${dashboard.getShare().message}`);
    console.log(
      "[rdsh-dashboard] Open with rdsh-dashboard open; Ctrl-C to stop.",
    );
    if (values.open) openUrl(dashboard.browserUrl);
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, async () => {
        await dashboard.close();
        process.exit(0);
      });
  } else throw new Error("Unknown command; use --help");
} catch (e) {
  if (e.report) console.log(JSON.stringify(e.report, null, 2));
  else console.error(`[rdsh-dashboard] ${e.message}`);
  process.exitCode = 1;
}
