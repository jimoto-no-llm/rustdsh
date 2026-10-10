import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(pathToFileURL(process.env.RDSH_TEST_LLM_PACKAGE));
const { Context } = await import(
  pathToFileURL(require.resolve("@deepseek-ai/cordis")).href
);
const { LlmRuntime, LlmAdapter } = await import(
  pathToFileURL(require.resolve("@deepseek-ai/dsh-llm")).href
);
export function fixtureLlm(scenario, dispatches) {
  const ctx = new Context();
  const llm = new LlmRuntime(ctx);
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: [
            { id: "low", name: "Low" },
            { id: "high", name: "High" },
          ],
          ...(scenario === "unknown-effort" ? {} : { defaultEffort: "high" }),
        },
      };
    }
    async *stream(options) {
      dispatches.push({
        provider: options.provider,
        model: options.model,
        effort: options.reasoningEffort ?? null,
      });
      yield {
        type: "text-delta",
        index: 0,
        text: "fixture-output-not-for-history",
      };
      yield {
        type: "finish",
        reason: { kind: scenario === "provider-failure" ? "error" : "stop" },
      };
    }
  }
  const dispose = llm.registerAdapter(
    ["fixture-provider", "other-provider"],
    new FixtureAdapter(),
  );
  if (scenario === "late-mutation")
    ctx.on("llm/stream", (options, next) => {
      options.model = "model-B";
      return next();
    });
  return { llm, dispose };
}
