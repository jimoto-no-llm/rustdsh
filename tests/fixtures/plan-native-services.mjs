// Native engine and service; fixture transport/provider have no credentials.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
const require = createRequire(
  pathToFileURL(process.env.RDSH_TEST_PLAN_PACKAGE),
);
const { Context, Service } = await import(
  pathToFileURL(require.resolve("@deepseek-ai/cordis")).href
);
const { SubagentRuntime } = await import(
  pathToFileURL(require.resolve("@deepseek-ai/dsh-subagent")).href
);
const { default: Workflow } = await import(
  pathToFileURL(require.resolve("@deepseek-ai/dsh-workflow-ptc")).href
);
const { apply: applySpawn } = await import(
  pathToFileURL(require.resolve("@deepseek-ai/dsh-subagent-spawn-in-process"))
    .href
);
export function fixtureWorkflow(scenario = "match") {
  const ctx = new Context(),
    dispatches = [],
    disposals = [],
    parent = {
      session: { id: "native-root", header: { delegationDepth: 0 } },
      options: {},
    };
  const subagents = new SubagentRuntime(ctx, {
    maxDepth: { get: () => 2 },
    maxActiveSubagents: { get: () => 8 },
  });
  applySpawn(ctx, { providerName: "fixture" });
  Object.assign(subagents.getProvider("fixture"), {
    name: "fixture",
    capabilities: {
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    },
    async start(request) {
      const id = "native-" + randomUUID();
      dispatches.push({ id, parent_id: request.parent.session.id });
      if (scenario === "startup-error")
        throw new Error("fixture startup outcome unknown");
      const result = scenario === "hold" ? Promise.withResolvers() : null;
      return {
        id,
        result:
          result?.promise ??
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  output: [{ type: "text", text: "fixture output" }],
                  stopReason:
                    scenario === "child-error" ? "error" : "completed",
                }),
              scenario === "concurrent" ? 80 : 5,
            ),
          ),
        async dispose() {
          disposals.push(id);
          result?.resolve({ output: [], stopReason: "cancelled" });
          if (scenario === "dispose-error")
            throw new Error("fixture disposal unconfirmed");
        },
      };
    },
  });
  if (scenario === "external")
    subagents.registerProvider({
      ...subagents.getProvider("fixture"),
      name: "external",
    });
  const ptc = new Service(ctx, "ptcRuntime");
  ptc.language = "typescript";
  ptc.resolve = (request) => request;
  ptc.run = async (request) => {
    // The original guest PROGRAM is unchanged. This transport fixture does
    // not attest production PTC process confinement.
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    try {
      return {
        value: await new AsyncFunction("workflowHost", request.program)(
          request.bindings[0].functions,
        ),
      };
    } catch (error) {
      return { error: { kind: "fixture", message: error.message } };
    }
  };
  const sandbox = new Service(ctx, "sandboxPolicy");
  sandbox.resolve = () => ({ workspaceRoot: process.cwd() });
  const engine = new Workflow(ctx, {
    provider: scenario === "external" ? "external" : "fixture",
    maxConcurrentAgents: 4,
    maxTotalAgents: 1000,
    maxItemsPerCall: 4096,
    syncTimeoutMs: 5000,
  });
  return { engine, subagents, parent, dispatches, disposals };
}
