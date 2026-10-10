// Real published DSH LLM service; only the registered provider is synthetic.
import { fixtureLlm } from "./model-adapter.mjs";
const scenario = process.env.RDSH_TEST_MODEL_SCENARIO || "match";
const dispatches = [];
const { llm, dispose } = fixtureLlm(scenario, dispatches);
const options = {
  provider: scenario === "provider" ? "other-provider" : "fixture-provider",
  model: scenario === "mismatch" ? "model-B" : "model-A",
  reasoningEffort:
    scenario === "effort"
      ? "low"
      : scenario === "unsupported"
        ? "unsupported"
        : "high",
  sessionId:
    scenario === "child" ? "another-native-session" : "fixture-native-session",
  messages: [{ role: "user", content: "fixture-input-not-for-history" }],
};
if (["default-effort", "unknown-effort"].includes(scenario))
  delete options.reasoningEffort;
if (scenario === "unbound") delete options.sessionId;
const chunks = [];
let error = null;
const iterations = Number(process.env.RDSH_TEST_MODEL_ITERATIONS || 1);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100)
  throw new Error("Invalid fixture iteration count");
const timings = [];
try {
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    for await (const chunk of llm.stream(options))
      chunks.push(
        chunk.type === "finish"
          ? { type: chunk.type, outcome: chunk.reason.kind }
          : { type: chunk.type },
      );
    timings.push(performance.now() - started);
  }
} catch (failure) {
  error = { code: failure.code || "UNKNOWN", message: failure.message };
}
dispose();
process.stdout.write(
  JSON.stringify({
    scenario,
    dispatches,
    chunks,
    error,
    timings_ms: {
      count: timings.length,
      median:
        [...timings].sort((a, b) => a - b)[Math.floor(timings.length / 2)] ??
        null,
      p95:
        [...timings].sort((a, b) => a - b)[
          Math.max(0, Math.ceil(timings.length * 0.95) - 1)
        ] ?? null,
      total: timings.reduce((sum, value) => sum + value, 0),
    },
  }) + "\n",
);
