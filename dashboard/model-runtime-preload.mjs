// Scoped Node preload, before the original DSH boot. No profile/installed file edits.
import { registerHooks } from "node:module";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SessionLedger } from "./session-ledger.mjs";
import { ModelRouting } from "./model-routing.mjs";
import {
  guardedModelSource,
  modelRuntimeHash,
  modelBoundaryKey,
} from "./model-runtime-source.mjs";
import { nativeModelBoundary } from "./model-runtime.mjs";

const filename = realpathSync(process.env.RDSH_MODEL_GUARD_CONFIG);
const bytes = readFileSync(filename);
if (bytes.length > 16384)
  throw new Error("Native model guard: invalid attachment");
const grant = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(bytes),
);
if (
  grant.schema !== 1 ||
  !/^[0-9a-f]{64}$/.test(grant.nonce) ||
  !/^[0-9a-f]{64}$/.test(grant.context_hash) ||
  path.dirname(filename) !== realpathSync(grant.directory) ||
  !path.basename(grant.directory).startsWith(".model-guard-") ||
  path.dirname(grant.directory) !== realpathSync(grant.project.directory)
)
  throw new Error("Native model guard: invalid attachment");
const ledger = await SessionLedger.open(grant.project);
const record = await ledger.resolve(grant.run_id);
const routing = ModelRouting.open(ledger.project);
const policy = await routing.read(record);
if (
  policy?.context_hash !== grant.context_hash ||
  !(await routing.required(record))?.native_dispatch_required
)
  throw new Error("Native model guard: run assertion changed or unavailable");
Object.defineProperty(globalThis, Symbol.for(modelBoundaryKey), {
  value: nativeModelBoundary(routing, record),
  writable: false,
  configurable: false,
});
let observed = false;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (
      !url.startsWith("file:") ||
      !/\/@deepseek-ai\/dsh-llm\/lib\/index\.js$/.test(
        decodeURIComponent(new URL(url).pathname),
      )
    )
      return loaded;
    const nativeFile = fileURLToPath(url);
    const pkg = JSON.parse(
      readFileSync(
        path.join(path.dirname(nativeFile), "../package.json"),
        "utf8",
      ),
    );
    if (pkg.name !== "@deepseek-ai/dsh-llm" || pkg.version !== "0.2.0-rc.2")
      throw new Error("Native model guard: unsupported LLM runtime");
    const source =
      typeof loaded.source === "string"
        ? loaded.source
        : Buffer.from(loaded.source).toString("utf8");
    const patched = guardedModelSource(source);
    if (!observed) {
      writeFileSync(
        path.join(grant.directory, `ready.${process.pid}.json`),
        JSON.stringify({
          schema: 1,
          nonce: grant.nonce,
          run_id: record.run_id,
          context_hash: grant.context_hash,
          pid: process.pid,
          native_source_sha256: modelRuntimeHash,
        }),
        { flag: "wx", mode: 0o600 },
      );
      observed = true;
    }
    return { ...loaded, source: patched };
  },
});
