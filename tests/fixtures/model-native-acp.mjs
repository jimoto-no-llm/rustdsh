// ACP is a wire fixture; dispatch itself uses the real published DSH service.
import fs from "node:fs";
import readline from "node:readline";
if (process.argv.includes("--version")) {
  console.log("0.2.0-rc.2");
  process.exit(0);
}
const { fixtureLlm } = await import("./model-adapter.mjs");
const fixture = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../dashboard/test/fixtures/dsh-acp-0.2.0-rc.2.json",
      import.meta.url,
    ),
  ),
);
const scenario = process.env.RDSH_TEST_MODEL_SCENARIO || "match";
const dispatches = [];
const { llm, dispose } = fixtureLlm(scenario, dispatches);
const sessionId = "fixture-native-session";
const configOptions = [
  {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: '["fixture-provider","model-A"]',
    options: [{ value: '["fixture-provider","model-A"]', name: "Fixture A" }],
  },
  {
    id: "reasoning_effort",
    type: "select",
    name: "Effort",
    category: "thought_level",
    currentValue: "high",
    options: [{ value: "high", name: "High" }],
  },
];
const output = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") output(msg.id, fixture.initialize);
  else if (msg.method === "session/list")
    output(msg.id, { sessions: [{ sessionId, cwd: process.cwd() }] });
  else if (msg.method === "session/new")
    output(msg.id, { sessionId, configOptions });
  else if (msg.method === "session/resume") output(msg.id, { configOptions });
  else if (msg.method === "session/prompt") {
    try {
      for await (const chunk of llm.stream({
        provider: "fixture-provider",
        model: scenario === "mismatch" ? "model-B" : "model-A",
        reasoningEffort: "high",
        sessionId,
        messages: [{ role: "user", content: "fixture-input-not-for-history" }],
      })) {
        if (chunk.type === "finish" && chunk.reason.kind === "error")
          throw new Error("fixture failure");
      }
      output(msg.id, { stopReason: "end_turn" });
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "fixture assertion blocked" },
        }) + "\n",
      );
    } finally {
      if (process.env.RDSH_TEST_DISPATCH_TRACE)
        fs.writeFileSync(
          process.env.RDSH_TEST_DISPATCH_TRACE,
          JSON.stringify(dispatches),
        );
    }
  } else if (msg.method === "session/close") output(msg.id, {});
});
input.on("close", () => {
  dispose();
});
