import { fixtureWorkflow } from "../../../tests/fixtures/plan-native-services.mjs";
const { engine, subagents, parent, dispatches } = fixtureWorkflow();
let starts = 0,
  nestedOutcome = null;
const disposals = [];
subagents.getProvider("fixture").start = async (request) => {
  const id = "native-branch-" + ++starts;
  dispatches.push({ id, parent_id: request.parent.session.id });
  const result = Promise.withResolvers();
  if (request.parent.session.id === "native-root") {
    setTimeout(async () => {
      try {
        const nested = engine.start({
          meta: {
            name: "NestedFixture",
            description: "Original nested Workflow",
          },
          script: 'return await agent("nested", {rdshTaskId:"nested"});',
          parent: {
            session: { id, header: { delegationDepth: 1 } },
            options: {},
          },
          signal: new AbortController().signal,
        });
        nestedOutcome = await nested.result;
        await nested.dispose();
        result.resolve({
          output: [],
          stopReason:
            nestedOutcome.stopReason === "completed" ? "completed" : "error",
        });
      } catch {
        result.resolve({ output: [], stopReason: "error" });
      }
    }, 120);
  } else
    result.resolve({
      output: [{ type: "text", text: "nested fixture" }],
      stopReason: "completed",
    });
  return {
    id,
    result: result.promise,
    async dispose() {
      disposals.push(id);
      result.resolve({ output: [], stopReason: "cancelled" });
    },
  };
};
const run = engine.start({
  meta: { name: "RootFixture", description: "Original root Workflow" },
  script: 'return await agent("parent", {rdshTaskId:"parent"});',
  parent,
  signal: new AbortController().signal,
});
const outcome = await run.result;
await run.dispose();
console.log(JSON.stringify({ outcome, nestedOutcome, dispatches, disposals }));
