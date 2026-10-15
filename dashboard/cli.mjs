#!/usr/bin/env node
import {
  cliText,
  cliErrorText,
  shareText,
  shareStateText,
  CliDiagnosticError,
} from "./cli-locale.mjs";
import { loadProductLocale, resolveProductLocale } from "./product-locale.mjs";
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import { constants } from "node:fs";
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
import { registerDashboardShutdown } from "./shutdown.mjs";
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
import { createPrivateJsonFile, PrivateJsonFileError } from "./private-json-file.mjs";
import { ProjectStore, publicState } from "./state.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Releases } from "./releases.mjs";
import { IntegrationQueue } from "./integration.mjs";
import { WorkerWorkspaces } from "./workers.mjs";
import * as agentRunners from "./agent-runners.mjs";
import {
  loopbackBase,
  recordTunnel,
  finishTunnel,
} from "./connection-diagnostics.mjs";

function helpFor(language) {
  return `rdsh-dashboard [--language en|zh-CN|ja] <${cliText(language, "arg.command")}> ...
rdsh-dashboard project --project <${cliText(language, "arg.directory")}> [--port <${cliText(language, "arg.port")}>] [--no-tailscale] [--open]
rdsh-dashboard harness [--port 38081] [--harness-port 3081] [--no-tailscale] [--open]
rdsh-dashboard open --project <${cliText(language, "arg.directory")}> | --harness
rdsh-dashboard stop --project <${cliText(language, "arg.directory")}> | --harness
rdsh-dashboard revoke-events --project <${cliText(language, "arg.directory")}>
rdsh-dashboard tunnel --project <${cliText(language, "arg.directory")}> --tunnel-id <tunnel_id>
rdsh-dashboard diagnostics --project <${cliText(language, "arg.directory")}>
rdsh-dashboard mcp --project <${cliText(language, "arg.directory")}>
rdsh-dashboard adapters [--cli dsh] [--executable <original-dsh>] [--entrypoint <bin.js>] [--project <${cliText(language, "arg.directory")}>] [--retry] [--retry-attempts <n>] [--retry-total-ms <ms>]
rdsh-dashboard adapter-smoke --executable <original-dsh> [--entrypoint <bin.js>] [--project <${cliText(language, "arg.directory")}>]
rdsh-dashboard preflight --project <${cliText(language, "arg.directory")}> [--requirements <json>] [--executable <original-dsh>] [--entrypoint <bin.js>] [--verify-auth]
rdsh-dashboard run-history list|inspect|events --project <${cliText(language, "arg.directory")}> [--run-id <run_id>] [--cursor <${cliText(language, "arg.number")}>] [--limit <${cliText(language, "arg.number")}>]
rdsh-dashboard retry-history list|inspect --project <${cliText(language, "arg.directory")}> [--operation-id <id>]
rdsh-dashboard checkpoint record|list|inspect|resume|start-new --project <${cliText(language, "arg.directory")}> [--run-id <id>] [--checkpoint-id <id>] [--executable <original-dsh>] [--entrypoint <bin.js>] [--verify-native] [--retry-operation-id <id>] [--summary-file <${cliText(language, "arg.file")}> --accept-context-loss]
rdsh-dashboard acceptance define|run|report|inspect --project <${cliText(language, "arg.directory")}> --task-id <id> [--criterion-id <id>] [--criteria-file <json>] [--argv-file <json>] [--result-file <json>] [--scope full|partial] [--timeout-ms <ms>] [--image <${cliText(language, "arg.relative-path")}>]
rdsh-dashboard routing bind|inspect|probe|allow-change --project <${cliText(language, "arg.directory")}> --run-id <id> [--route-file <json>] [--authorization-file <json>] [--executable <original-dsh>] [--entrypoint <bin.js>]
rdsh-dashboard session-ledger list|record|resolve|start|resume --project <${cliText(language, "arg.directory")}> [--run-id <run_id>] [--task-id <id>] [--session-id <id>] [--label <${cliText(language, "arg.name")}>] [--provider <${cliText(language, "arg.name")}>] [--cwd <${cliText(language, "arg.directory")}>] [--cli <${cliText(language, "arg.name")}>] [--executable <original-dsh>] [--entrypoint <bin.js>]
rdsh-dashboard reply-consumer inspect|once|serve --project <${cliText(language, "arg.directory")}> [--run-id <run_id>] [--command-id <reply_id>] [--executable <original-dsh>] [--entrypoint <bin.js>]
rdsh-dashboard instruction context --project <${cliText(language, "arg.directory")}> --consumer-id <consumer_id>
rdsh-dashboard instruction submit|resolve --project <${cliText(language, "arg.directory")}> --input-file <json>
rdsh-dashboard cost-ledger declare|report --project <${cliText(language, "arg.directory")}> --input-file <json>
rdsh-dashboard cost-ledger inspect --project <${cliText(language, "arg.directory")}>
rdsh-dashboard cost-ledger validate|public|schema --input-file <request-json>
rdsh-dashboard task-outcomes apply|validate|schema --input-file <request-json>
rdsh-dashboard budget-admission apply|validate|public --input-file <request-json>
rdsh-dashboard budget policy|usage --project <${cliText(language, "arg.directory")}> --input-file <json>
rdsh-dashboard budget inspect --project <${cliText(language, "arg.directory")}>
rdsh-dashboard integration init --project <${cliText(language, "arg.directory")}> --input-file <checks-json> --expected-revision 0 --expected-head <sha>
rdsh-dashboard integration enqueue|reject --project <${cliText(language, "arg.directory")}> --input-file <json> --expected-revision <n>
rdsh-dashboard integration inspect --project <${cliText(language, "arg.directory")}>
rdsh-dashboard integration apply|validate|retarget --project <${cliText(language, "arg.directory")}> --expected-revision <n> --expected-head <sha>
rdsh-dashboard subagents plan --input-file <request-json>
rdsh-dashboard workers plan --project <${cliText(language, "arg.directory")}> --input-file <worker-json>
rdsh-dashboard workers prepare --project <${cliText(language, "arg.directory")}> --input-file <worker-json> --expected-revision <n> --expected-head <sha>
rdsh-dashboard workers inspect --project <${cliText(language, "arg.directory")}>
rdsh-dashboard workers renew --project <${cliText(language, "arg.directory")}> --worker-id <id> --lease-seconds <n> --expected-revision <n>
rdsh-dashboard workers release --project <${cliText(language, "arg.directory")}> --worker-id <id> --expected-revision <n>
rdsh-dashboard agents list [--probe]
rdsh-dashboard agents submit --agent <cursor-agent|devin> --project <${cliText(language, "arg.directory")}> --prompt-file <${cliText(language, "arg.file")}> [--model <${cliText(language, "arg.name")}>] [--permission read-only|edit|full] [--resume <id>] [--trust-workspace] [--executable <${cliText(language, "arg.path")}>] [--entrypoint <${cliText(language, "arg.script")}>] [--wait]
rdsh-dashboard agents status|result|cancel <job_id>
rdsh-dashboard backup preview|export --project <${cliText(language, "arg.directory")}> --selection-file <json> [--review-file <json>] [--output-file <new-json>]
rdsh-dashboard backup inspect --archive-file <json>
rdsh-dashboard backup restore --project <${cliText(language, "arg.directory")}> --archive-file <json> --expected-revision <n>
rdsh-dashboard backup history --project <${cliText(language, "arg.directory")}>
rdsh-dashboard backup export --project <${cliText(language, "arg.directory")}> --archive-id <backup_id> --output-file <new-json>
rdsh-dashboard release stage --input-file <trusted-code-roots-json>
rdsh-dashboard release inspect --project <${cliText(language, "arg.directory")}>
rdsh-dashboard release canary|promote|rollback --project <${cliText(language, "arg.directory")}> --release-id <rel_sha256> --selection-revision <n>
rdsh-dashboard session-ledger start|resume --project <${cliText(language, "arg.directory")}> [--run-id <id>] # ${cliText(language, "help.pinned")}
rdsh-dashboard session-ledger start|resume --budget-guard --worker-id <id> --project <${cliText(language, "arg.directory")}> --executable <original-dsh> [--entrypoint <bin.js>] [--run-id <id>]
rdsh-dashboard reply-consumer once|serve --budget-guard --worker-id <id> --project <${cliText(language, "arg.directory")}> --run-id <id> --executable <original-dsh> [--entrypoint <bin.js>]

${cliText(language, "help.project")}
${cliText(language, "help.harness")}
${cliText(language, "help.windows")}
${cliText(language, "help.tray")}
${cliText(language, "help.tailscale")}
${cliText(language, "help.session")}
${cliText(language, "help.reply")}
`;
}
let values = {},
  positionals = [],
  tokens = [],
  argumentError;
const rawArguments = process.argv.slice(2);
let explicitLanguage;
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "--") break;
  if (arg === "--language") explicitLanguage = process.argv[++index];
  else if (arg.startsWith("--language="))
    explicitLanguage = arg.slice("--language=".length);
}
let language = resolveProductLocale(explicitLanguage);
try {
  ({ values, positionals, tokens } = parseArgs({
    args: rawArguments,
    allowPositionals: true,
    tokens: true,
    options: {
      language: { type: "string" },
      project: { type: "string" },
      port: { type: "string" },
      "harness-port": { type: "string" },
      "no-tailscale": { type: "boolean" },
      "tunnel-id": { type: "string" },
      open: { type: "boolean" },
      tray: { type: "boolean" },
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
      "lease-seconds": { type: "string" },
      "expected-head": { type: "string" },
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
      agent: { type: "string" },
      "prompt-file": { type: "string" },
      model: { type: "string" },
      permission: { type: "string" },
      resume: { type: "string" },
      "trust-workspace": { type: "boolean" },
      wait: { type: "boolean" },
      probe: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  }));
  explicitLanguage = values.language;
  delete values.language;
} catch (error) {
  argumentError = error;
}
// Preserve original spelling, values and terminators when delegating argv.
function delegatedArguments(omitCommand = false) {
  const omitted = new Set();
  for (const token of tokens) {
    if (token.kind === "option" && token.name === "language") {
      omitted.add(token.index);
      if (!token.inlineValue) omitted.add(token.index + 1);
    }
  }
  if (omitCommand) {
    const command = tokens.find((token) => token.kind === "positional");
    if (command) omitted.add(command.index);
  }
  return rawArguments.filter((_, index) => !omitted.has(index));
}
function openUrl(url) {
  // Non-Windows shells can't hand a URL to a browser here; print it so
  // `rdsh-dashboard open` still resolves to something usable.
  if (process.platform !== "win32") {
    console.log(url);
    return;
  }
  // A bare name would be searched in the working directory first (CWE-427).
  const rundll32 = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "rundll32.exe",
  );
  const child = spawn(rundll32, ["url.dll,FileProtocolHandler", url], {
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
    throw new CliDiagnosticError("error.portRange");
  return port;
}
async function localJson(file) {
  if (!file) throw new CliDiagnosticError("error.inputRequired");
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024)
      throw new CliDiagnosticError("error.inputFile");
    const bytes = await handle.readFile();
    if (bytes.length > 256 * 1024)
      throw new CliDiagnosticError("error.inputLimit");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new CliDiagnosticError("error.inputInvalid");
    }
  } finally {
    await handle.close();
  }
}
async function nativeRdsh() {
  const override = process.env.RDSH_BIN;
  if (override) {
    if (!path.isAbsolute(override)) throw new CliDiagnosticError("error.nativeAbsolute");
    return override;
  }
  const name = process.platform === "win32" ? "rdsh.exe" : "rdsh";
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      if (process.platform !== "win32")
        await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  throw new CliDiagnosticError("error.nativeMissing");
}

// The outcome logic moved to Rust (`rdsh task-outcomes`); this command keeps
// the dashboard entry point working without importing the removed module.
async function runNativeTaskOutcomes(action, inputFile) {
  const executable = await nativeRdsh();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["task-outcomes", action, "--input-file", inputFile],
      { stdio: "inherit", windowsHide: true, env: { ...process.env, RDSH_LANG: language } },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

// Budget admission is a self-contained pure-logic module in Rust
// (`rdsh budget-admission`); the dashboard keeps its own copy for the store
// hot path, and this entry point exposes the native implementation.
async function runNativeBudgetAdmission(action, inputFile) {
  const executable = await nativeRdsh();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["budget-admission", action, "--input-file", inputFile],
      { stdio: "inherit", windowsHide: true, env: { ...process.env, RDSH_LANG: language } },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

async function runNativeSubagentPlan(inputFile) {
  const executable = await nativeRdsh();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(executable, ["subagents", "plan", "--input-file", inputFile], {
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, RDSH_LANG: language },
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}

// The ledger logic also lives in Rust (`rdsh cost-ledger`). This command keeps
// the dashboard entry point working through the native implementation, while
// `dashboard/state.mjs` keeps importing the JS module in-process.
async function runNativeCostLedger(action, document) {
  const executable = await nativeRdsh();
  const file = path.join(
    stateHome(),
    `cost-ledger-${process.pid}-${randomUUID()}.json`,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const request = await createPrivateJsonFile(file, document);
    try {
      const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(
          executable,
          ["cost-ledger", action, "--input-file", file],
          { stdio: "inherit", windowsHide: true, env: { ...process.env, RDSH_LANG: language } },
        );
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      process.exitCode = exitCode;
    } finally {
      await request.dispose();
    }
  } catch (error) {
    if (error instanceof PrivateJsonFileError)
      throw new CliDiagnosticError("error.privateJson", {
        operation: error.operation, code: error.code,
      });
    throw error;
  }
}
async function inPinnedCli(artifact, selectionRevision) {
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH)
    throw new CliDiagnosticError("error.nodeInjection");
  const pinnedCli = path.join(artifact.slot, "adapter/dashboard/cli.mjs");
  const supplied = values["managed-release-id"];
  if (
    supplied !== undefined &&
    (supplied !== artifact.manifest.release_id ||
      Number(values["managed-revision"]) !== selectionRevision)
  )
    throw new CliDiagnosticError("error.selectionChanged");
  if (
    path.resolve(fileURLToPath(import.meta.url)) === path.resolve(pinnedCli) &&
    path.resolve(process.execPath) === path.resolve(artifact.command[0])
  )
    return true;
  if (supplied !== undefined)
    throw new CliDiagnosticError("error.pinnedChanged");
  const args = [
    pinnedCli,
    ...delegatedArguments(),
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
      throw new CliDiagnosticError("error.managedMissing");
    if (!options.command) throw new CliDiagnosticError("error.dshExecutable");
    return { attached: await attachRecordedSession(options) };
  }
  if (values.executable || values.entrypoint)
    throw new CliDiagnosticError("error.managedPinned");
  if (!(await inPinnedCli(plan, plan.selection_revision)))
    return { delegated: true };
  return { attached: await releases.attach(project, plan, options) };
}
try {
  if (argumentError)
    throw new CliDiagnosticError("error.argumentParsing", {
      detail: argumentError.message,
    });
  if (
    explicitLanguage !== undefined &&
    !["en", "zh-CN", "ja"].includes(explicitLanguage)
  )
    throw new CliDiagnosticError("error.language");
  const command = positionals[0];
  // These native JSON operations do not consume dashboard settings. Keep the
  // bridge available even when a settings file needs repair.
  const nativeJsonBridge =
    (command === "budget-admission" && ["apply", "validate", "public"].includes(positionals[1])) ||
    (command === "subagents" && positionals[1] === "plan") ||
    (command === "task-outcomes" && ["apply", "validate", "schema"].includes(positionals[1])) ||
    (command === "cost-ledger" && ["validate", "public", "schema"].includes(positionals[1]));
  language = nativeJsonBridge
    ? resolveProductLocale(explicitLanguage)
    : await loadProductLocale(explicitLanguage);
  if (
    command !== "release" &&
    ["release-id", "selection-revision"].some((k) => values[k] !== undefined)
  )
    throw new CliDiagnosticError("error.releaseOptions");
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
    throw new CliDiagnosticError("error.managedDispatch");
  if (
    command !== "backup" &&
    [
      "selection-file",
      "review-file",
      "archive-file",
      "output-file",
      "archive-id",
    ].some((k) => values[k] !== undefined)
  )
    throw new CliDiagnosticError("error.backupOptions");
  if (
    values["expected-revision"] !== undefined &&
    !["backup", "integration", "workers"].includes(command)
  )
    throw new CliDiagnosticError("error.backupOptions");
  if (
    values["expected-head"] !== undefined &&
    !["integration", "workers"].includes(command)
  )
    throw new CliDiagnosticError("error.integrationOptions");
  if (values["lease-seconds"] !== undefined && command !== "workers")
    throw new CliDiagnosticError("error.workerOptions");
  if (
    values["budget-guard"] !== undefined ||
    (values["worker-id"] !== undefined && command !== "workers")
  ) {
    const permitted =
      (command === "session-ledger" &&
        ["start", "resume"].includes(positionals[1])) ||
      (command === "reply-consumer" &&
        ["once", "serve"].includes(positionals[1]));
    if (!permitted || !values["budget-guard"] || !values["worker-id"])
      throw new CliDiagnosticError("error.budgetOptions");
  }
  if (
    command !== "retry-history" &&
    !values.retry &&
    (values["retry-attempts"] !== undefined ||
      values["retry-total-ms"] !== undefined ||
      values["operation-id"] !== undefined)
  )
    throw new CliDiagnosticError("error.retryOptions");
  if (values.retry && command !== "adapters")
    throw new CliDiagnosticError("error.retryAdapters");
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
    throw new CliDiagnosticError("error.checkpointOptions");
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
    throw new CliDiagnosticError("error.acceptanceOptions");
  if (
    command !== "routing" &&
    [values["route-file"], values["authorization-file"]].some(
      (value) => value !== undefined,
    )
  )
    throw new CliDiagnosticError("error.routingOptions");
  if (values.help || !command) {
    console.log(helpFor(language));
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
      throw new CliDiagnosticError("error.releaseAction");
    const releases = new Releases();
    let result;
    if (action === "stage") {
      if (
        !values["input-file"] ||
        values["release-id"] ||
        values["selection-revision"] ||
        values.project
      )
        throw new CliDiagnosticError("error.stageInput");
      result = await releases.stage(await localJson(values["input-file"]));
    } else {
      if (values["input-file"])
        throw new CliDiagnosticError("error.captureStage");
      const project = await identity(values.project || process.cwd());
      if (action === "inspect") {
        if (values["release-id"] || values["selection-revision"])
          throw new CliDiagnosticError("error.inspectRegistry");
        result = await releases.inspect(project);
      } else {
        const rev = Number(values["selection-revision"]);
        if (
          !values["release-id"] ||
          values["selection-revision"] === undefined ||
          !Number.isSafeInteger(rev) ||
          rev < 0
        )
          throw new CliDiagnosticError("error.releaseSelection");
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
      throw new CliDiagnosticError("error.backupAction");
    let result;
    if (action === "inspect") {
      if (!values["archive-file"])
        throw new CliDiagnosticError("error.archiveFile");
      result = backupInspection(await readBackupJson(values["archive-file"]));
    } else {
      const project = await identity(values.project || process.cwd());
      if (action === "export" && values["archive-id"]) {
        if (
          values["selection-file"] ||
          values["review-file"] ||
          !values["output-file"]
        )
          throw new CliDiagnosticError("error.reexportOptions");
        const history = await backupRequest(project, "history");
        const archive = history.history_backups.find(
          (e) => e.archive.archive_id === values["archive-id"],
        )?.archive;
        if (!archive) throw new CliDiagnosticError("error.archiveMissing");
        result = await writeHistoryBackup(values["output-file"], archive);
      } else if (["preview", "export"].includes(action)) {
        if (
          !values["selection-file"] ||
          (action === "export" && !values["output-file"])
        )
          throw new CliDiagnosticError("error.exportSelection");
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
          throw new CliDiagnosticError("error.restoreOptions");
        result = await backupRequest(project, "restore", {
          archive: await readBackupJson(values["archive-file"]),
          expected_revision: Number(values["expected-revision"]),
        });
      } else result = await backupRequest(project, "history");
    }
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "integration") {
    const action = positionals[1];
    const options = {
      init: ["project", "input-file", "expected-revision", "expected-head"],
      enqueue: ["project", "input-file", "expected-revision"],
      reject: ["project", "input-file", "expected-revision"],
      inspect: ["project"],
      apply: ["project", "expected-revision", "expected-head"],
      validate: ["project", "expected-revision", "expected-head"],
      retarget: ["project", "expected-revision", "expected-head"],
    };
    if (
      positionals.length !== 2 ||
      !Object.hasOwn(options, action) ||
      Object.keys(values).some((key) => !options[action].includes(key))
    )
      throw new CliDiagnosticError("error.integrationAction");
    const queue = await IntegrationQueue.open(
      await identity(values.project || process.cwd()),
    );
    if (
      action !== "inspect" &&
      !/^\d+$/.test(values["expected-revision"] || "")
    )
      throw new CliDiagnosticError("error.expectedRevision");
    const expected = {
      expectedRevision: Number(values["expected-revision"]),
      expectedHead: values["expected-head"],
    };
    let result;
    if (action === "inspect") result = await queue.inspect();
    else if (["enqueue", "reject"].includes(action))
      result = await queue[action](
        await localJson(values["input-file"]),
        expected.expectedRevision,
      );
    else if (action === "init")
      result = await queue.init(
        await localJson(values["input-file"]),
        expected,
      );
    else result = await queue[action](expected);
    console.log(JSON.stringify(result));
    if (
      (action === "init" && result.queue.state !== "ready") ||
      (action === "apply" &&
        result.queue.entries.some((row) =>
          ["conflict", "unconfirmed"].includes(row.state),
        )) ||
      (action === "validate" && !result.validation.verified)
    )
      process.exitCode = 1;
  } else if (command === "agents") {
    // External agent CLIs (cursor-agent, devin); never the DSH ACP adapter.
    const action = positionals[1];
    const options = {
      list: ["probe"],
      submit: [
        "agent",
        "project",
        "prompt-file",
        "model",
        "permission",
        "resume",
        "trust-workspace",
        "executable",
        "entrypoint",
        "wait",
      ],
      status: [],
      result: [],
      cancel: [],
    };
    if (
      !Object.hasOwn(options, action) ||
      positionals.length !== (["list", "submit"].includes(action) ? 2 : 3) ||
      Object.keys(values).some((k) => !options[action].includes(k))
    )
      throw new CliDiagnosticError("error.agentsAction");
    let output;
    if (action === "list")
      output = await agentRunners.list({ probe: Boolean(values.probe) });
    else if (action === "submit") {
      if (!values.agent || !values.project || !values["prompt-file"])
        throw new CliDiagnosticError("error.agentsSubmit");
      output = await agentRunners.submit({
        runner: values.agent,
        project: values.project,
        promptFile: values["prompt-file"],
        model: values.model,
        permission: values.permission,
        resume: values.resume,
        trustWorkspace: Boolean(values["trust-workspace"]),
        executable: values.executable,
        entrypoint: values.entrypoint,
      });
      if (values.wait) {
        await agentRunners.waitForJob(output.id);
        output = await agentRunners.result(output.id);
        if (output.state !== "succeeded") process.exitCode = 1;
      }
    } else if (action === "status") output = await agentRunners.status(positionals[2]);
    else if (action === "result") {
      output = await agentRunners.result(positionals[2]);
      if (!["queued", "running", "succeeded"].includes(output.state))
        process.exitCode = 1;
    } else output = await agentRunners.cancel(positionals[2]);
    console.log(JSON.stringify(output));
  } else if (command === "subagents") {
    if (
      positionals.length !== 2 ||
      positionals[1] !== "plan" ||
      !values["input-file"] ||
      Object.keys(values).some((key) => key !== "input-file")
    )
      throw new CliDiagnosticError("error.subagentsAction");
    await runNativeSubagentPlan(values["input-file"]);
  } else if (command === "task-outcomes") {
    const action = positionals[1];
    if (
      positionals.length !== 2 ||
      !["apply", "validate", "schema"].includes(action) ||
      !values["input-file"] ||
      Object.keys(values).some((key) => key !== "input-file")
    )
      throw new CliDiagnosticError("error.taskOutcomesAction");
    await runNativeTaskOutcomes(action, values["input-file"]);
  } else if (command === "budget-admission") {
    const action = positionals[1];
    if (
      positionals.length !== 2 ||
      !["apply", "validate", "public"].includes(action) ||
      !values["input-file"] ||
      Object.keys(values).some((key) => key !== "input-file")
    )
      throw new CliDiagnosticError("error.budgetAdmissionAction");
    await runNativeBudgetAdmission(action, values["input-file"]);
  } else if (command === "workers") {
    const action = positionals[1];
    const options = {
      plan: ["project", "input-file"],
      prepare: ["project", "input-file", "expected-revision", "expected-head"],
      inspect: ["project"],
      renew: ["project", "worker-id", "lease-seconds", "expected-revision"],
      release: ["project", "worker-id", "expected-revision"],
    };
    if (
      positionals.length !== 2 ||
      !Object.hasOwn(options, action) ||
      Object.keys(values).some((k) => !options[action].includes(k))
    )
      throw new CliDiagnosticError("error.workersAction");
    const workers = await WorkerWorkspaces.open(
      await identity(values.project || process.cwd()),
    );
    let result;
    const expected =
      values["expected-revision"] === undefined
        ? undefined
        : Number(values["expected-revision"]);
    if (action === "plan")
      result = await workers.plan(await localJson(values["input-file"]));
    else if (action === "prepare")
      result = await workers.prepare(await localJson(values["input-file"]), {
        expectedRevision: expected,
        expectedHead: values["expected-head"],
      });
    else if (action === "renew")
      result = await workers.renew(
        values["worker-id"],
        Number(values["lease-seconds"]),
        expected,
      );
    else if (action === "release")
      result = await workers.release(values["worker-id"], expected);
    else result = await workers.inspect();
    console.log(JSON.stringify(result));
    if (result.provisioning_error) process.exitCode = 1;
  } else if (command === "cost-ledger") {
    const action = positionals[1],
      allowed = new Set(["project", "input-file", "help"]);
    // The pure projection and validation live in Rust (`rdsh cost-ledger`).
    // They take no `--project`: the caller passes the whole state document, so
    // no store is opened and no server is contacted.
    if (["validate", "public", "schema"].includes(action)) {
      if (
        positionals.length !== 2 ||
        !values["input-file"] ||
        values.project !== undefined ||
        Object.keys(values).some((key) => !allowed.has(key))
      )
        throw new CliDiagnosticError("error.costPureOptions");
      // Dispatch to the native command and leave the server path untouched;
      // this is a module-level `try`, so the branch cannot `return`.
      await runNativeCostLedger(action, await localJson(values["input-file"]));
    } else {
      if (
        positionals.length !== 2 ||
        !["declare", "report", "inspect"].includes(action) ||
        Object.keys(values).some((key) => !allowed.has(key)) ||
        (action === "inspect"
          ? values["input-file"] !== undefined
          : !values["input-file"])
      )
        throw new CliDiagnosticError("error.costOptions");
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
    }
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
      throw new CliDiagnosticError("error.budgetAction");
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
      throw new CliDiagnosticError("error.instructionOptions");
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
      throw new CliDiagnosticError("error.replyAction");
    const project = await identity(values.project || process.cwd());
    if (action === "inspect") {
      if (values.executable || values.entrypoint)
        throw new CliDiagnosticError("error.replyInspect");
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
        throw new CliDiagnosticError("error.entrypointOriginal");
      if (!values["run-id"] || values["command-id"])
        throw new CliDiagnosticError("error.replyRun");
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
      throw new CliDiagnosticError("error.routingAction");
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
      throw new CliDiagnosticError("error.routingUnsupported");
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
      throw new CliDiagnosticError("error.routingMatch");
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
        throw new CliDiagnosticError("error.probeExecutable");
      if ((await store.read(record)) === null)
        throw new CliDiagnosticError("error.probeBind");
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
      throw new CliDiagnosticError("error.acceptanceAction");
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
      throw new CliDiagnosticError("error.acceptanceUnsupported");
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
      throw new CliDiagnosticError("error.acceptanceMatch");
    if (
      ["define", "inspect"].includes(action) &&
      [values["criterion-id"], values.scope, values.image].some(
        (value) => value !== undefined,
      )
    )
      throw new CliDiagnosticError("error.criterionOptions");
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
    await preflightCli(delegatedArguments(true));
  } else if (command === "checkpoint") {
    const action = positionals[1];
    if (
      positionals.length !== 2 ||
      !["record", "list", "inspect", "resume", "start-new"].includes(action)
    )
      throw new CliDiagnosticError("error.checkpointAction");
    const store = await Checkpoints.open(
      await identity(values.project || process.cwd()),
    );
    const argv = values.executable ? [values.executable] : null;
    if (values.entrypoint && !argv)
      throw new CliDiagnosticError("error.entrypointExecutable");
    if (values.entrypoint) argv.push(values.entrypoint);
    if (values.cli && values.cli !== "dsh")
      throw new CliDiagnosticError("error.checkpointDsh");
    if (
      action !== "start-new" &&
      (values["summary-file"] !== undefined || values["accept-context-loss"])
    )
      throw new CliDiagnosticError("error.summaryOptions");
    if (
      action !== "record" &&
      (values["run-id"] !== undefined ||
        values["retry-operation-id"] !== undefined)
    )
      throw new CliDiagnosticError("error.recordReferences");
    if (action !== "inspect" && values["verify-native"])
      throw new CliDiagnosticError("error.verifyInspect");
    if (action === "list" && (argv || values["checkpoint-id"]))
      throw new CliDiagnosticError("error.listOptions");
    let result;
    if (action === "list") result = await store.list();
    else if (action === "record") {
      if (values["checkpoint-id"])
        throw new CliDiagnosticError("error.recordCheckpoint");
      if (!argv) throw new CliDiagnosticError("error.originalExecutable");
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
      if (!argv) throw new CliDiagnosticError("error.originalExecutable");
      let summary = null;
      if (action === "start-new") {
        if (!values["summary-file"] || !values["accept-context-loss"])
          throw new CliDiagnosticError("error.startNewOptions");
        const handle = await fs.open(values["summary-file"], "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 65536)
            throw new CliDiagnosticError("error.summaryFile");
          const bytes = await handle.readFile();
          if (bytes.length > 65536)
            throw new CliDiagnosticError("error.summaryLimit");
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
      throw new CliDiagnosticError("error.retryHistoryAction");
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
      throw new CliDiagnosticError("error.runHistoryAction");
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
      throw new CliDiagnosticError("error.pagingAction");
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
      throw new CliDiagnosticError("error.sessionAction");
    const ledger = await SessionLedger.open(
      await identity(values.project || process.cwd()),
    );
    const argv = values.executable ? [values.executable] : null;
    if (values.entrypoint && !argv)
      throw new CliDiagnosticError("error.entrypointExecutable");
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
      if (values["run-id"]) throw new CliDiagnosticError("error.recordRun");
      result = await ledger.record({
        ...options,
        cli: values.cli || "dsh",
        cli_session_id: values["session-id"] || null,
      });
    } else {
      if (values.cli && values.cli !== "dsh")
        throw new CliDiagnosticError("error.attachDsh");
      if (values["session-id"]) throw new CliDiagnosticError("error.nativeId");
      if (action === "start" && values["run-id"])
        throw new CliDiagnosticError("error.startRun");
      if (action === "resume" && !values["run-id"])
        throw new CliDiagnosticError("error.resumeRun");
      if (
        action === "resume" &&
        [values.cwd, values["task-id"], values.label, values.provider].some(
          (value) => value !== undefined,
        )
      )
        throw new CliDiagnosticError("error.resumeRecorded");
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
      throw new CliDiagnosticError("error.entrypointExecutable");
    if (values.entrypoint) argv.push(values.entrypoint);
    if (values.retry) {
      if (command !== "adapters" || values.cli !== "dsh" || !argv)
        throw new CliDiagnosticError("error.retryDsh");
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
      if (!argv) throw new CliDiagnosticError("error.dshExecutable");
      if (values.cli && values.cli !== "dsh")
        throw new CliDiagnosticError("error.smokeDsh");
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
        throw new CliDiagnosticError("error.probeCli");
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
      throw new CliDiagnosticError("error.stopped");
    }
    if (command === "open") openUrl(runtime.browser_url);
    else {
      if (command === "revoke-events" && values.harness)
        throw new CliDiagnosticError("error.projectEvents");
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
        `[rdsh-dashboard] ${cliText(language, command === "stop" ? "status.stopping" : "status.revoked")}`,
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
      throw new CliDiagnosticError("error.tunnelId");
    if (!process.env.CONTROL_PLANE_API_KEY)
      throw new CliDiagnosticError("error.tunnelKey");
    const project = await identity(values.project || process.cwd());
    const runtime = JSON.parse(
      await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
    );
    const base = loopbackBase(runtime.local_url);
    if (!/^[0-9a-f]{64}$/.test(runtime.mcp_token || ""))
      throw new CliDiagnosticError("error.mcpCredential");
    if (runtime.project_id !== project.id || runtime.kind !== "project")
      throw new CliDiagnosticError("error.wrongRuntime");
    const response = await fetch(base + "api/config", {
      headers: { authorization: `Bearer ${runtime.token}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new CliDiagnosticError("error.tunnelStart");
    const config = await response.json();
    if (
      !config.instance_id ||
      config.instance_id !== runtime.instance_id ||
      config.project?.id !== project.id
    )
      throw new CliDiagnosticError("error.tunnelRestart");
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
    if (values.tray && process.platform !== "win32")
      throw new CliDiagnosticError("error.trayWindows");
    const dashboard = await startDashboard({
      language,
      kind: command,
      project:
        command === "project"
          ? await identity(values.project || process.cwd())
          : null,
      port: portValue(values.port),
      harnessPort: portValue(values["harness-port"]),
      tailscale: !values["no-tailscale"],
    });
    if (values.tray) {
      try {
        const { startWindowsTray } = await import("./windows-tray.mjs");
        await startWindowsTray({
          dashboard,
          open: openUrl,
          label:
            command === "harness"
              ? "rdsh Harness"
              : `rdsh: ${path.basename(path.resolve(values.project || process.cwd()))}`,
        });
        if (process.connected) process.send({ ready: true });
      } catch (error) {
        await dashboard.close();
        throw error;
      }
    }
    console.log(
      `[rdsh-dashboard] ${cliText(language, "status.started", { command, url: dashboard.localUrl })}`,
    );
    console.log(
      `[rdsh-dashboard] ${cliText(language, "status.tailscale", { state: shareStateText(language, dashboard.getShare().state) })}`,
    );
    console.log(
      `[rdsh-dashboard] ${shareText(language, dashboard.getShare())}`,
    );
    console.log(`[rdsh-dashboard] ${cliText(language, "status.open")}`);
    if (values.open) openUrl(dashboard.browserUrl);
    registerDashboardShutdown(() => dashboard.close());
  } else throw new CliDiagnosticError("error.unknownCommand");
} catch (e) {
  if (process.connected)
    process.send({
      error: e.message,
      ...(e.trayDiagnostics ? { tray_diagnostics: e.trayDiagnostics } : {}),
    });
  if (e.report) console.log(JSON.stringify(e.report, null, 2));
  else console.error(`[rdsh-dashboard] ${cliErrorText(language, e)}`);
  if (e.trayDiagnostics)
    console.error(
      `[rdsh-dashboard] ${cliText(language, "tray.diagnostics", { detail: JSON.stringify(e.trayDiagnostics) })}`,
    );
  process.exitCode = 1;
}
