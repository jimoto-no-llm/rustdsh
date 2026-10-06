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
import { ModelRouting } from "./model-routing.mjs";
import { requestedSelection, validSelection } from "./model-selection.mjs";
import { ReplyConsumer } from "./reply-consumer.mjs";
import { instructionRequest } from "./instruction-client.mjs";
import { costRequest } from "./cost-client.mjs";
import { budgetRequest } from "./budget-client.mjs";
import { backupRequest } from "./backup-client.mjs";
import {
  readBackupJson,
  writeHistoryBackup,
  backupInspection,
} from "./backup-files.mjs";
import { allInputCommands } from "./instruction-queue.mjs";
import { ProjectStore, publicState } from "./state.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Releases } from "./releases.mjs";
import {
  loopbackBase,
  recordTunnel,
  finishTunnel,
} from "./connection-diagnostics.mjs";

const help = `rdsh-dashboard project --project <directory> [--port <port>] [--no-tailscale] [--open]
rdsh-dashboard harness [--port 38081] [--harness-port 3081] [--no-tailscale] [--open]
rdsh-dashboard open --project <directory> | --harness
rdsh-dashboard stop --project <directory> | --harness
rdsh-dashboard revoke-events --project <directory>
rdsh-dashboard tunnel --project <directory> --tunnel-id <tunnel_id>
rdsh-dashboard diagnostics --project <directory>
rdsh-dashboard mcp --project <directory>
rdsh-dashboard adapters [--cli dsh] [--executable <original-dsh>] [--entrypoint <bin.js>] [--project <directory>] [--retry] [--retry-attempts <n>] [--retry-total-ms <ms>]
rdsh-dashboard adapter-smoke --executable <original-dsh> [--entrypoint <bin.js>] [--project <directory>]
rdsh-dashboard preflight --project <directory> [--requirements <json>] [--executable <original-dsh>] [--entrypoint <bin.js>] [--verify-auth]
rdsh-dashboard run-history list|inspect|events --project <directory> [--run-id <run_id>] [--cursor <number>] [--limit <number>]
rdsh-dashboard retry-history list|inspect --project <directory> [--operation-id <id>]
rdsh-dashboard checkpoint record|list|inspect|resume|start-new --project <directory> [--run-id <id>] [--checkpoint-id <id>] [--executable <original-dsh>] [--entrypoint <bin.js>] [--verify-native] [--retry-operation-id <id>] [--summary-file <file> --accept-context-loss]
rdsh-dashboard acceptance define|run|report|inspect --project <directory> --task-id <id> [--criterion-id <id>] [--criteria-file <json>] [--argv-file <json>] [--result-file <json>] [--scope full|partial] [--timeout-ms <ms>] [--image <relative-path>]
rdsh-dashboard routing bind|inspect|probe|allow-change --project <directory> --run-id <id> [--route-file <json>] [--authorization-file <json>] [--executable <original-dsh>] [--entrypoint <bin.js>]
rdsh-dashboard session-ledger list|record|resolve|start|resume --project <directory> [--run-id <run_id>] [--task-id <id>] [--session-id <id>] [--label <name>] [--provider <name>] [--cwd <directory>] [--cli <name>] [--executable <original-dsh>] [--entrypoint <bin.js>]
rdsh-dashboard reply-consumer inspect|once|serve --project <directory> [--run-id <run_id>] [--command-id <reply_id>] [--executable <original-dsh>] [--entrypoint <bin.js>]
rdsh-dashboard instruction context --project <directory> --consumer-id <consumer_id>
rdsh-dashboard instruction submit|resolve --project <directory> --input-file <json>
rdsh-dashboard cost-ledger declare|report --project <directory> --input-file <json>
rdsh-dashboard cost-ledger inspect --project <directory>
rdsh-dashboard budget policy|usage --project <directory> --input-file <json>
rdsh-dashboard budget inspect --project <directory>
rdsh-dashboard backup preview|export --project <directory> --selection-file <json> [--review-file <json>] [--output-file <new-json>]
rdsh-dashboard backup inspect --archive-file <json>
rdsh-dashboard backup restore --project <directory> --archive-file <json> --expected-revision <n>
rdsh-dashboard backup history --project <directory>
rdsh-dashboard backup export --project <directory> --archive-id <backup_id> --output-file <new-json>
rdsh-dashboard release stage --input-file <trusted-code-roots-json>
rdsh-dashboard release inspect --project <directory>
rdsh-dashboard release canary|promote|rollback --project <directory> --release-id <rel_sha256> --selection-revision <n>
rdsh-dashboard session-ledger start|resume --project <directory> [--run-id <id>] # selected/pinned managed release
rdsh-dashboard session-ledger start|resume --budget-guard --worker-id <id> --project <directory> --executable <original-dsh> [--entrypoint <bin.js>] [--run-id <id>]
rdsh-dashboard reply-consumer once|serve --budget-guard --worker-id <id> --project <directory> --run-id <id> --executable <original-dsh> [--entrypoint <bin.js>]

Project mode: project metrics, tasks, questions, human feedback, and /mcp.
Harness mode: a separate managed DeepSeek Harness Web UI and QR landing page.
Tailscale Serve shares each loopback server privately over HTTPS.
Session-ledger start/resume confirms the native ID then stops its owned ACP process; it sends no prompt.
Reply-consumer once/serve explicitly resumes that exact native session and sends current human replies once. Replies grant no new execution permissions. Missing results block replay.
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
    "route-file": { type: "string" },
    "authorization-file": { type: "string" },
    "command-id": { type: "string" },
    "consumer-id": { type: "string" },
    "input-file": { type: "string" },
    "budget-guard": { type: "boolean" },
    "worker-id": { type: "string" },
    "selection-file": { type: "string" },
    "review-file": { type: "string" },
    "archive-file": { type: "string" },
    "output-file": { type: "string" },
    "expected-revision": { type: "string" },
    "archive-id": { type: "string" },
    "release-id": { type: "string" },
    "selection-revision": { type: "string" },
    "managed-release-id": { type: "string" },
    "managed-revision": { type: "string" },
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
async function inPinnedCli(artifact, selectionRevision) {
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH)
    throw new Error(
      "Managed Node injection is unsupported; resolve NODE_OPTIONS/NODE_PATH before using the pinned runtime",
    );
  const pinnedCli = path.join(artifact.slot, "adapter/dashboard/cli.mjs");
  const supplied = values["managed-release-id"];
  if (
    supplied !== undefined &&
    (supplied !== artifact.manifest.release_id ||
      Number(values["managed-revision"]) !== selectionRevision)
  )
    throw new Error(
      "Managed selection changed before pinned CLI dispatch; refresh the selection",
    );
  if (
    path.resolve(fileURLToPath(import.meta.url)) === path.resolve(pinnedCli) &&
    path.resolve(process.execPath) === path.resolve(artifact.command[0])
  )
    return true;
  if (supplied !== undefined)
    throw new Error(
      "Pinned CLI/runtime path changed; restore the captured release",
    );
  const args = [
    pinnedCli,
    ...process.argv.slice(2),
    "--managed-release-id",
    artifact.manifest.release_id,
    "--managed-revision",
    String(selectionRevision),
  ];
  const child = spawn(artifact.command[0], args, {
    shell: false,
    windowsHide: true,
    stdio: "inherit",
    env: process.env,
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
  return false;
}
async function pinnedAttachment(project, options) {
  const releases = new Releases();
  const plan = await releases.plan(project, options.run_id || null);
  if (plan === null) {
    if (values["managed-release-id"] !== undefined)
      throw new Error("Managed run/default no longer exists");
    if (!options.command)
      throw new Error("Specify the original DSH executable with --executable");
    return { attached: await attachRecordedSession(options) };
  }
  if (values.executable || values.entrypoint)
    throw new Error(
      "This run/project pins a managed release; omit executable/entrypoint to use its captured command",
    );
  if (!(await inPinnedCli(plan, plan.selection_revision)))
    return { delegated: true };
  return { attached: await releases.attach(project, plan, options) };
}
try {
  const command = positionals[0];
  if (
    command !== "release" &&
    ["release-id", "selection-revision"].some((k) => values[k] !== undefined)
  )
    throw new Error("Release selection options require release");
  if (
    ["managed-release-id", "managed-revision"].some(
      (k) => values[k] !== undefined,
    ) &&
    (!values["managed-release-id"] ||
      values["managed-revision"] === undefined ||
      (!(
        command === "release" && ["canary", "rollback"].includes(positionals[1])
      ) &&
        !(
          command === "session-ledger" &&
          ["start", "resume"].includes(positionals[1])
        ) &&
        !(
          command === "reply-consumer" &&
          ["once", "serve"].includes(positionals[1])
        )))
  )
    throw new Error(
      "Managed dispatch requires a captured CLI attachment or native qualification",
    );
  if (
    command !== "backup" &&
    [
      "selection-file",
      "review-file",
      "archive-file",
      "output-file",
      "expected-revision",
      "archive-id",
    ].some((k) => values[k] !== undefined)
  )
    throw new Error("Backup options require backup");
  if (
    values["budget-guard"] !== undefined ||
    values["worker-id"] !== undefined
  ) {
    const permitted =
      (command === "session-ledger" &&
        ["start", "resume"].includes(positionals[1])) ||
      (command === "reply-consumer" &&
        ["once", "serve"].includes(positionals[1]));
    if (!permitted || !values["budget-guard"] || !values["worker-id"])
      throw new Error(
        "Budget enforcement requires --budget-guard and --worker-id on session-ledger start/resume or reply-consumer once/serve",
      );
  }
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
  if (
    command !== "routing" &&
    [values["route-file"], values["authorization-file"]].some(
      (value) => value !== undefined,
    )
  )
    throw new Error("Model route options require routing");
  if (values.help || !command) {
    console.log(help);
  } else if (command === "release") {
    const action = positionals[1];
    const allowed = new Set([
      "project",
      "release-id",
      "selection-revision",
      "input-file",
      "help",
      "managed-release-id",
      "managed-revision",
    ]);
    if (
      positionals.length !== 2 ||
      !["stage", "inspect", "canary", "promote", "rollback"].includes(action) ||
      Object.keys(values).some((key) => !allowed.has(key))
    )
      throw new Error(
        "Specify release stage, inspect, canary, promote or rollback",
      );
    const releases = new Releases();
    let result;
    if (action === "stage") {
      if (
        !values["input-file"] ||
        values["release-id"] ||
        values["selection-revision"] ||
        values.project
      )
        throw new Error(
          "Stage requires only an explicit trusted code input file",
        );
      result = await releases.stage(await localJson(values["input-file"]));
    } else {
      if (values["input-file"])
        throw new Error("Code capture input is for release stage only");
      const project = await identity(values.project || process.cwd());
      if (action === "inspect") {
        if (values["release-id"] || values["selection-revision"])
          throw new Error("Inspect uses the project registry");
        result = await releases.inspect(project);
      } else {
        const rev = Number(values["selection-revision"]);
        if (
          !values["release-id"] ||
          values["selection-revision"] === undefined ||
          !Number.isSafeInteger(rev) ||
          rev < 0
        )
          throw new Error(
            "Select an exact release ID and current project selection revision",
          );
        if (action === "promote")
          result = await releases.promote(project, values["release-id"], rev);
        else {
          let artifact;
          try {
            artifact = await releases.verify(values["release-id"]);
          } catch {
            // No captured code can run when its bytes are unavailable. The
            // controller still retains the failed verification below.
          }
          if (artifact && !(await inPinnedCli(artifact, rev)))
            process.exit(process.exitCode || 0);
          result = await releases.check(project, values["release-id"], rev, {
            rollback: action === "rollback",
          });
          if (result.qualification.status !== "passed" || !result.changed)
            process.exitCode = 1;
        }
      }
    }
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "backup") {
    const action = positionals[1];
    const optionSets = {
      preview: ["project", "selection-file", "review-file"],
      export: [
        "project",
        "selection-file",
        "review-file",
        "output-file",
        "archive-id",
      ],
      inspect: ["archive-file"],
      restore: ["project", "archive-file", "expected-revision"],
      history: ["project"],
    };
    if (
      positionals.length !== 2 ||
      !Object.hasOwn(optionSets, action) ||
      Object.keys(values).some((k) => !optionSets[action].includes(k))
    )
      throw new Error("Invalid backup action/options");
    let result;
    if (action === "inspect") {
      if (!values["archive-file"]) throw new Error("Specify --archive-file");
      result = backupInspection(await readBackupJson(values["archive-file"]));
    } else {
      const project = await identity(values.project || process.cwd());
      if (action === "export" && values["archive-id"]) {
        if (
          values["selection-file"] ||
          values["review-file"] ||
          !values["output-file"]
        )
          throw new Error(
            "Re-export requires --archive-id and --output-file only",
          );
        const history = await backupRequest(project, "history");
        const archive = history.history_backups.find(
          (e) => e.archive.archive_id === values["archive-id"],
        )?.archive;
        if (!archive) throw new Error("Restored archive not found");
        result = await writeHistoryBackup(values["output-file"], archive);
      } else if (["preview", "export"].includes(action)) {
        if (
          !values["selection-file"] ||
          (action === "export" && !values["output-file"])
        )
          throw new Error("Specify --selection-file and export --output-file");
        const archive = await backupRequest(project, "preview", {
          selection: await readBackupJson(values["selection-file"]),
          ...(values["review-file"]
            ? { review: await readBackupJson(values["review-file"]) }
            : {}),
        });
        result =
          action === "export"
            ? await writeHistoryBackup(values["output-file"], archive)
            : backupInspection(archive);
      } else if (action === "restore") {
        if (
          !values["archive-file"] ||
          !/^\d+$/.test(values["expected-revision"] || "")
        )
          throw new Error("Specify --archive-file and --expected-revision");
        result = await backupRequest(project, "restore", {
          archive: await readBackupJson(values["archive-file"]),
          expected_revision: Number(values["expected-revision"]),
        });
      } else result = await backupRequest(project, "history");
    }
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "cost-ledger") {
    const action = positionals[1],
      allowed = new Set(["project", "input-file", "help"]);
    if (
      positionals.length !== 2 ||
      !["declare", "report", "inspect"].includes(action) ||
      Object.keys(values).some((key) => !allowed.has(key)) ||
      (action === "inspect"
        ? values["input-file"] !== undefined
        : !values["input-file"])
    )
      throw new Error(
        "Cost ledger declare/report requires --input-file; inspect takes no input file",
      );
    const project = await identity(values.project || process.cwd());
    console.log(
      JSON.stringify(
        await costRequest(
          project,
          action,
          action === "inspect"
            ? undefined
            : await localJson(values["input-file"]),
        ),
        null,
        2,
      ),
    );
  } else if (command === "budget") {
    const action = positionals[1];
    const allowed = new Set(["project", "input-file", "help"]);
    if (
      positionals.length !== 2 ||
      !["policy", "usage", "inspect"].includes(action) ||
      Object.keys(values).some((key) => !allowed.has(key)) ||
      (action === "inspect"
        ? values["input-file"] !== undefined
        : !values["input-file"])
    )
      throw new Error(
        "Budget policy/usage requires --input-file; inspect is read only",
      );
    console.log(
      JSON.stringify(
        await budgetRequest(
          await identity(values.project || process.cwd()),
          action,
          action === "inspect"
            ? undefined
            : await localJson(values["input-file"]),
        ),
        null,
        2,
      ),
    );
  } else if (command === "instruction") {
    const action = positionals[1],
      allowed = new Set(["project", "consumer-id", "input-file", "help"]);
    if (
      positionals.length !== 2 ||
      !["context", "submit", "resolve"].includes(action) ||
      Object.keys(values).some((key) => !allowed.has(key)) ||
      (action === "context"
        ? !values["consumer-id"] || values["input-file"]
        : !values["input-file"] || values["consumer-id"])
    )
      throw new Error(
        "Instruction context requires --consumer-id; submit/resolve requires --input-file",
      );
    const project = await identity(values.project || process.cwd());
    const input =
      action === "context"
        ? { consumer_id: values["consumer-id"] }
        : await localJson(values["input-file"]);
    console.log(
      JSON.stringify(await instructionRequest(project, action, input), null, 2),
    );
  } else if (command === "reply-consumer") {
    const action = positionals[1];
    const allowed = new Set([
      "project",
      "run-id",
      "command-id",
      "executable",
      "entrypoint",
      "help",
      "budget-guard",
      "worker-id",
      "managed-release-id",
      "managed-revision",
    ]);
    if (
      positionals.length !== 2 ||
      !["inspect", "once", "serve"].includes(action) ||
      Object.keys(values).some((key) => !allowed.has(key))
    )
      throw new Error(
        "Specify reply-consumer inspect, once or serve with supported options",
      );
    const project = await identity(values.project || process.cwd());
    if (action === "inspect") {
      if (values.executable || values.entrypoint)
        throw new Error("Reply inspection never launches a CLI");
      const state = publicState((await ProjectStore.open(project)).value);
      const commands = allInputCommands(state).filter(
        (item) =>
          (!values["run-id"] || item.run_id === values["run-id"]) &&
          (!values["command-id"] || item.command_id === values["command-id"]),
      );
      console.log(
        JSON.stringify(
          { project_id: project.id, mode: "read_only", commands },
          null,
          2,
        ),
      );
    } else {
      if (values.entrypoint && !values.executable)
        throw new Error("An entrypoint requires the original executable");
      if (!values["run-id"] || values["command-id"])
        throw new Error(
          "Reply consumption requires an exact --run-id; individual command IDs are for inspection only",
        );
      const ledger = await SessionLedger.open(project);
      const managed = await pinnedAttachment(project, {
        ledger,
        run_id: values["run-id"],
        budget: values["budget-guard"]
          ? { worker_id: values["worker-id"] }
          : null,
        command: values.executable
          ? [
              values.executable,
              ...(values.entrypoint ? [values.entrypoint] : []),
            ]
          : undefined,
      });
      if (managed.delegated) process.exit(process.exitCode || 0);
      const attached = managed.attached;
      const controller = new AbortController();
      const stop = () => {
        controller.abort();
        void attached.adapter.stop().catch(() => {});
      };
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
      try {
        const consumer = await ReplyConsumer.open({ project, attached });
        console.log(
          JSON.stringify({
            consumer_id: consumer.consumer.consumer_id,
            run_id: attached.record.run_id,
            session_id: attached.record.cli_session_id,
          }),
        );
        do {
          const result = await consumer.poll();
          if (result.processed.length || action === "once")
            console.log(JSON.stringify(result));
          if (result.blocked) {
            process.exitCode = 1;
            break;
          }
          if (action === "once" || controller.signal.aborted) break;
          await delay(2000, undefined, { signal: controller.signal }).catch(
            (error) => {
              if (error.name !== "AbortError") throw error;
            },
          );
        } while (!controller.signal.aborted);
      } finally {
        for (const signal of ["SIGINT", "SIGTERM"])
          process.removeListener(signal, stop);
        await attached.adapter.stop();
      }
    }
  } else if (command === "routing") {
    const action = positionals[1];
    if (
      positionals.length !== 2 ||
      !["bind", "inspect", "probe", "allow-change"].includes(action)
    )
      throw new Error("Specify routing bind, inspect, probe or allow-change");
    const allowed = new Set([
      "project",
      "run-id",
      "route-file",
      "authorization-file",
      "executable",
      "entrypoint",
      "help",
    ]);
    if (Object.keys(values).some((key) => !allowed.has(key)))
      throw new Error("Unsupported option for routing");
    if (
      (!["bind", "allow-change"].includes(action) &&
        values["route-file"] !== undefined) ||
      (action !== "allow-change" &&
        values["authorization-file"] !== undefined) ||
      (action !== "probe" &&
        [values.executable, values.entrypoint].some(
          (value) => value !== undefined,
        ))
    )
      throw new Error("Options must match the routing action");
    const ledger = await SessionLedger.open(
      await identity(values.project || process.cwd()),
    );
    const record = await ledger.resolve(values["run-id"]),
      store = ModelRouting.open(ledger.project);
    store.file(record);
    let result;
    if (action === "inspect") result = await store.inspect(record);
    else if (action === "bind") {
      const input = await localJson(values["route-file"]);
      let persisted;
      if (!validSelection(input)) {
        const routePath = path.join(
          record.scope.DSH_HOME ||
            path.join(record.scope.effective_home, ".dsh"),
          "oh-my-dsh",
          "routes.json",
        );
        persisted = await localJson(routePath).catch((error) => {
          if (error.code === "ENOENT") return { version: 1, routes: {} };
          throw error;
        });
      }
      result = await store.bind(
        record,
        requestedSelection(input, process.env, persisted),
      );
    } else if (action === "allow-change")
      result = await store.allowChange(
        record,
        await localJson(values["route-file"]),
        await localJson(values["authorization-file"]),
      );
    else {
      if (!values.executable)
        throw new Error("probe requires the original CLI executable");
      if ((await store.read(record)) === null)
        throw new Error("Bind the model request before probing it");
      const command = [
        values.executable,
        ...(values.entrypoint ? [values.entrypoint] : []),
      ];
      const attached = await attachRecordedSession({
        ledger,
        run_id: record.run_id,
        command,
      });
      try {
        result = await store.observe(attached.record, attached.adapter);
      } finally {
        await attached.adapter.stop();
      }
      result = { ...result, model_prompts_sent: 0, owned_root_stopped: true };
      if (!result.prompt_allowed_by_route_assertion) process.exitCode = 1;
    }
    console.log(JSON.stringify(result, null, 2));
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
      const managed = await pinnedAttachment(ledger.project, {
        ...options,
        run_id: action === "resume" ? values["run-id"] : null,
        budget: values["budget-guard"]
          ? { worker_id: values["worker-id"] }
          : null,
        requirements: values.requirements
          ? await readRequirements(values.requirements)
          : null,
        verifyAuth: values["verify-auth"] || false,
      });
      if (managed.delegated) process.exit(process.exitCode || 0);
      const attached = managed.attached;
      const stopped = await attached.adapter.stop();
      result = {
        run: attached.record,
        command_id: attached.command_id,
        history: await attached.history.inspect(attached.record.run_id),
        lifecycle: "attachment_verified_process_stopped",
        process: stopped,
        ...(attached.release ? { release: attached.release } : {}),
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
  } else if (command === "diagnostics") {
    const project = await identity(values.project || process.cwd());
    let report;
    try {
      const runtime = await localJson(
        path.join(project.directory, "runtime.json"),
      );
      if (
        runtime.kind !== "project" ||
        runtime.project_id !== project.id ||
        typeof runtime.token !== "string" ||
        !/^[0-9a-f]{64}$/.test(runtime.token)
      )
        throw new Error();
      const response = await fetch(
        loopbackBase(runtime.local_url) + "api/diagnostics",
        {
          headers: { authorization: `Bearer ${runtime.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok)
        report = {
          schema: 1,
          project_id: project.id,
          observed_at: new Date().toISOString(),
          state: "unconfirmed",
          reason:
            response.status === 401
              ? "dashboard_authentication_failed"
              : "diagnostics_unavailable",
        };
      else {
        report = await response.json();
        if (report.schema !== 1 || report.project_id !== project.id)
          throw new Error();
      }
    } catch {
      report = {
        schema: 1,
        project_id: project.id,
        observed_at: new Date().toISOString(),
        state: "unconfirmed",
        reason: "dashboard_unreachable_or_runtime_invalid",
      };
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.state === "unconfirmed") process.exitCode = 1;
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
    const base = loopbackBase(runtime.local_url);
    if (!/^[0-9a-f]{64}$/.test(runtime.mcp_token || ""))
      throw new Error(
        "Invalid dashboard MCP credential; restart the dashboard",
      );
    if (runtime.project_id !== project.id || runtime.kind !== "project")
      throw new Error("Wrong project dashboard runtime");
    const response = await fetch(base + "api/config", {
      headers: { authorization: `Bearer ${runtime.token}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        "Start the project dashboard before connecting its tunnel",
      );
    const config = await response.json();
    if (
      !config.instance_id ||
      config.instance_id !== runtime.instance_id ||
      config.project?.id !== project.id
    )
      throw new Error("Restart the dashboard before connecting its tunnel");
    const owner = randomUUID();
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
        base + "mcp",
        "--mcp.extra-headers",
        "Authorization: env:RDSH_DASHBOARD_AUTHORIZATION",
        "--mcp.discovery-extra-headers",
        "Authorization: env:RDSH_DASHBOARD_AUTHORIZATION",
        "--health.listen-addr",
        "127.0.0.1:0",
        "--health.url-file",
        path.join(project.directory, `tunnel-health-${owner}.url`),
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
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    // Attach the rejection handler before the asynchronous process observation.
    void completion.catch(() => {});
    let record;
    try {
      record = await recordTunnel(
        project,
        runtime.instance_id,
        child.pid,
        owner,
      );
      process.exitCode = await completion;
    } catch (error) {
      child.kill();
      throw error;
    } finally {
      if (record) await finishTunnel(project, record);
    }
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
