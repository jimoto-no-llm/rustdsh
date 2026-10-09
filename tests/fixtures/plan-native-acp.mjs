// ACP wire fixture; Workflow and subagent dispatch are the published services.
import fs from "node:fs";
import readline from "node:readline";
if (process.argv.includes("--version")) {
  console.log("0.2.0-rc.2");
  process.exit(0);
}
const { fixtureWorkflow } = await import("./plan-native-services.mjs");
const { engine, parent, dispatches } = fixtureWorkflow();
const fixture = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../dashboard/test/fixtures/dsh-acp-0.2.0-rc.2.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const sessionId = "native-root",
  output = (id, result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const input = readline.createInterface({ input: process.stdin });
let active = null;
input.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") output(msg.id, fixture.initialize);
  else if (msg.method === "session/list")
    output(msg.id, { sessions: [{ sessionId, cwd: process.cwd() }] });
  else if (msg.method === "session/new") output(msg.id, { sessionId });
  else if (msg.method === "session/resume") output(msg.id, {});
  else if (msg.method === "session/prompt") {
    try {
      active = engine.start({
        meta: { name: "ACPFixture", description: "Native admission test" },
        script:
          process.env.RDSH_TEST_PLAN_SCRIPT ||
          'return await agent("fixture", {rdshTaskId:"a"});',
        parent,
        signal: new AbortController().signal,
      });
      const result = await active.result;
      await active.dispose();
      if (result.stopReason !== "completed") throw new Error("fixture denied");
      output(msg.id, { stopReason: "end_turn" });
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "fixture admission blocked" },
        }) + "\n",
      );
    } finally {
      active = null;
      if (process.env.RDSH_TEST_PLAN_TRACE)
        fs.writeFileSync(
          process.env.RDSH_TEST_PLAN_TRACE,
          JSON.stringify(dispatches),
        );
    }
  } else if (msg.method === "session/cancel")
    active?.cancel("fixture cancelled");
  else if (msg.method === "session/close") {
    await active?.dispose();
    output(msg.id, {});
  }
});
input.on("close", () => {
  void active?.dispose();
});
