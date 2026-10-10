import { createHash } from "node:crypto";

// Audited published @deepseek-ai/dsh-llm 0.2.0-rc.2. Transform only in memory.
export const modelRuntimeHash =
  "9132c8a8053ee82b9fb1ded4f98c85cf557f288a15a85c552c6b1fb319ead120";
export const modelBoundaryKey = "rdsh.model-dispatch-boundary.v1";
export const modelSourceHash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function guardedModelSource(source) {
  if (modelSourceHash(source) !== modelRuntimeHash)
    throw new Error("Native model guard: unaudited LLM runtime");
  const dispatch =
    "iterator = dispatch(this.forAdapter(projectedOptions, adapter))[Symbol.asyncIterator]();";
  const failure =
    "} catch (error) {\n\t\t\t\t\t\tcompleted = true;\n\t\t\t\t\t\tyield adapterFailureChunk(error, options.signal);";
  for (const marker of [dispatch, failure])
    if (source.split(marker).length !== 2)
      throw new Error("Native model guard: ambiguous dispatch boundary");
  return source
    .replace(
      dispatch,
      `iterator = globalThis[Symbol.for("${modelBoundaryKey}")].stream(this.forAdapter(projectedOptions, adapter), dispatch, modelInfo)[Symbol.asyncIterator]();`,
    )
    .replace(
      failure,
      failure.replace(
        "completed = true;",
        'completed = true;\n\t\t\t\t\t\tif (["RDSH_MODEL_GUARD_DENIED", "RDSH_MODEL_GUARD_AUDIT_FAILED"].includes(error?.code)) throw error;',
      ),
    );
}
