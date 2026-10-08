// ACP fixture only. Native DSH profile activation is verified separately.
if (!process.argv.includes("--version")) {
  const { readFile } = await import("node:fs/promises");
  if (
    process.argv.length !== 6 ||
    process.argv[2] !== "--profile" ||
    process.argv[3] !== "acp" ||
    process.argv[4] !== "--patch" ||
    !(await readFile(process.argv[5], "utf8")).includes("rdsh-budget-guard")
  )
    throw new Error("Budget ACP fixture requires the owned patch");
  const { createBudgetHook } =
    await import("../../../plugins/rdsh-budget-guard/index.js");
  await createBudgetHook({
    base: process.env.RDSH_BUDGET_BASE,
    key: process.env.RDSH_BUDGET_KEY,
    job_id: process.env.RDSH_BUDGET_JOB,
  }).initialize();
  process.argv.splice(4, 2); // reuse the existing strict ACP protocol fixture
}
await import("./acp-cli.mjs");
