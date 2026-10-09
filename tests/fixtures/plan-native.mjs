// Original published Workflow/PTC guest; isolated provider/transport, no boot.
import { fixtureWorkflow } from "./plan-native-services.mjs";
const scenario = process.env.RDSH_TEST_PLAN_SCENARIO || "match";
const { engine, subagents, parent, dispatches, disposals } =
  fixtureWorkflow(scenario);
let error = null,
  outcome = null;
const timings = [],
  iterations = Number(process.env.RDSH_TEST_PLAN_ITERATIONS || 1);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 50)
  throw new Error("Invalid fixture iterations");
try {
  if (scenario === "direct")
    outcome = await subagents.start("fixture", {
      parent,
      prompt: [{ type: "text", text: "untracked" }],
      signal: new AbortController().signal,
    });
  else if (scenario === "continuable")
    outcome = await subagents.startContinuable({});
  else {
    if (scenario === "depth") parent.session.header.delegationDepth = 2;
    if (scenario === "wrong-parent") parent.session.id = "another-parent";
    const script =
      process.env.RDSH_TEST_PLAN_SCRIPT ||
      'return await agent("fixture", {rdshTaskId:"a"});';
    for (let i = 0; i < iterations; i++) {
      const started = performance.now();
      const run = engine.start({
        meta: { name: "Fixture", description: "Native admission test" },
        script,
        args: { taskId: "bench-" + i },
        parent,
        signal: new AbortController().signal,
      });
      if (scenario === "hold")
        setTimeout(() => run.cancel("fixture cancel"), 100);
      outcome = await run.result;
      await run.dispose();
      timings.push(performance.now() - started);
    }
  }
} catch (e) {
  error = { code: e.code || null, message: e.message };
}
process.stdout.write(
  JSON.stringify({
    scenario,
    dispatches,
    disposals,
    outcome,
    error,
    timings_ms: timings,
  }) + "\n",
);
