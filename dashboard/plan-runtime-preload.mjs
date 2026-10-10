// Installed native modules stay intact; this launch alone requires admission.
import { registerHooks } from "node:module";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SessionLedger } from "./session-ledger.mjs";
import { ExecutionPlans } from "./execution-plan.mjs";
import { nativePlanBoundary } from "./plan-runtime.mjs";
import {
  guardedPlanSource,
  planRuntimeHashes,
  planBoundaryKey,
} from "./plan-runtime-source.mjs";

const filename = realpathSync(process.env.RDSH_PLAN_GUARD_CONFIG),
  bytes = readFileSync(filename);
if (bytes.length > 16384)
  throw new Error("Native plan guard: invalid attachment");
const grant = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(bytes),
);
if (
  grant.schema !== 1 ||
  !/^[0-9a-f]{64}$/.test(grant.nonce) ||
  !/^[0-9a-f]{64}$/.test(grant.context_hash) ||
  path.dirname(filename) !== realpathSync(grant.directory) ||
  !path.basename(grant.directory).startsWith(".plan-guard-") ||
  path.dirname(grant.directory) !== realpathSync(grant.project.directory)
)
  throw new Error("Native plan guard: invalid attachment");
const ledger = await SessionLedger.open(grant.project),
  record = await ledger.resolve(grant.run_id),
  plans = ExecutionPlans.open(grant.project),
  binding = await plans.required(record);
if (
  !binding ||
  binding.context_hash !== grant.context_hash ||
  binding.binding.session_id !== record.cli_session_id
)
  throw new Error("Native plan guard: attachment changed");
Object.defineProperty(globalThis, Symbol.for(planBoundaryKey), {
  value: nativePlanBoundary(plans, binding),
  writable: false,
  configurable: false,
});
const loadedPackages = new Set();
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith("file:")) return loaded;
    const match = decodeURIComponent(new URL(url).pathname).match(
      /\/@deepseek-ai\/(dsh-workflow-ptc|dsh-subagent|dsh-subagent-spawn-in-process)\/lib\/index\.js$/,
    );
    if (!match) return loaded;
    const pkg = JSON.parse(
      readFileSync(
        path.join(path.dirname(fileURLToPath(url)), "../package.json"),
        "utf8",
      ),
    );
    if (pkg.name !== "@deepseek-ai/" + match[1] || pkg.version !== "0.2.0-rc.2")
      throw new Error("Native plan guard: unsupported runtime");
    const source =
        typeof loaded.source === "string"
          ? loaded.source
          : Buffer.from(loaded.source).toString("utf8"),
      patched = guardedPlanSource(match[1], source);
    loadedPackages.add(match[1]);
    if (loadedPackages.size === Object.keys(planRuntimeHashes).length)
      writeFileSync(
        path.join(grant.directory, `ready.${process.pid}.json`),
        JSON.stringify({
          schema: 1,
          nonce: grant.nonce,
          pid: process.pid,
          run_id: record.run_id,
          context_hash: binding.context_hash,
          native_sources: planRuntimeHashes,
        }),
        { flag: "wx", mode: 0o600 },
      );
    return { ...loaded, source: patched };
  },
});
