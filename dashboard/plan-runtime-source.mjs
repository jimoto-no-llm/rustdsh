// Audited, opt-in adapters around public DSH seams; no installed file changes.
import { createHash } from "node:crypto";
export const planBoundaryKey = "rdsh.native.execution-plan.v1";
export const planRuntimeHashes = Object.freeze({
  "dsh-workflow-ptc":
    "4d722dc3cfee83bdc3c131c6d8dd088efb599688f1ee028ca004af9f72ae4693",
  "dsh-subagent":
    "75b50b1c9452a6aeb10d1c859e3f45b05e062ea1fad6ed3bcd9577f2bc912541",
  "dsh-subagent-spawn-in-process":
    "11c92108dd145957f8251a81fc9bfb8a30e7f6f25d96e34a5cb8581a4be4be06",
});
function once(source, from, to) {
  if (source.split(from).length !== 2)
    throw new Error("Native plan guard: boundary changed");
  return source.replace(from, to);
}
export function guardedPlanSource(packageName, source) {
  if (
    createHash("sha256").update(source).digest("hex") !==
    planRuntimeHashes[packageName]
  )
    throw new Error("Native plan guard: unsupported source");
  const boundary = `globalThis[Symbol.for(${JSON.stringify(planBoundaryKey)})]`;
  if (packageName === "dsh-subagent") {
    return (
      source +
      `\n{ const proto = SubagentRuntime.prototype; const start = proto.start;
      proto.start = function(name, request) { return ${boundary}.subagent(request, () => delegationDepthOf(request.parent) + 1, () => start.call(this, name, request), this.getProvider(name)); };
      proto.startContinuable = function() { return ${boundary}.unplanned(); };
    }\n`
    );
  }
  if (packageName === "dsh-subagent-spawn-in-process")
    return once(
      source,
      "ctx.subagents.registerProvider(new SpawnInProcessProvider(config.providerName));",
      `ctx.subagents.registerProvider(${boundary}.register(new SpawnInProcessProvider(config.providerName)));`,
    );
  const literal = source.match(
    /WORKFLOW_GUEST_SOURCE = ("(?:[^"\\]|\\[\s\S])*");/,
  );
  if (!literal) throw new Error("Native plan guard: guest boundary changed");
  let guest = JSON.parse(literal[1].replace(/\t/g, "\\t"));
  guest = once(
    guest,
    'const SUPPORTED_AGENT_OPTIONS = new Set([\n\t"label",',
    'const SUPPORTED_AGENT_OPTIONS = new Set([\n\t"rdshTaskId",\n\t"label",',
  );
  guest = once(
    guest,
    "\t\tif (rawOpts === void 0) return {};",
    '\t\tif (rawOpts === void 0) throw new WorkflowError("agent() requires an explicit rdshTaskId", "INVALID_ARGUMENT");',
  );
  guest = once(
    guest,
    "\t\treturn {\n\t\t\t...record.label !== void 0",
    '\t\tif (typeof record.rdshTaskId !== "string" || !record.rdshTaskId || record.rdshTaskId.length > 160) throw new WorkflowError("agent() requires an explicit rdshTaskId", "INVALID_ARGUMENT");\n\t\treturn {\n\t\t\trdshTaskId: record.rdshTaskId,\n\t\t\t...record.label !== void 0',
  );
  guest = once(
    guest,
    "\t\t\t\t\tprompt: rawPrompt,",
    "\t\t\t\t\tprompt: rawPrompt,\n\t\t\t\t\trdshTaskId: opts.rdshTaskId,",
  );
  source = once(source, literal[1], JSON.stringify(guest));
  source = once(
    source,
    "\treturn {\n\t\tprompt,",
    '\treturn {\n\t\trdshTaskId: text(request.rdshTaskId, "workflow task id"),\n\t\tprompt,',
  );
  source = once(
    source,
    "\t\t\tbegin: () => {\n\t\t\t\tthis.requireActive();",
    `\t\t\tbegin: async () => {\n\t\t\t\tthis.requireActive();\n\t\t\t\tawait ${boundary}.workflow(this.parent);`,
  );
  source = once(
    source,
    "\t\tconst run = await this.subagents.start(this.provider, {",
    `\t\tconst run = await ${boundary}.child(request.rdshTaskId, this.parent, () => this.subagents.start(this.provider, {`,
  );
  source = once(
    source,
    "\t\t});\n\t\tconst record = {\n\t\t\tcallId,",
    "\t\t}));\n\t\tconst record = {\n\t\t\tcallId,",
  );
  return source;
}
