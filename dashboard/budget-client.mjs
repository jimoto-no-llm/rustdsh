import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loopbackBase } from "./connection-diagnostics.mjs";
import { createCliAdapter } from "./adapters.mjs";

async function runtimeFor(project) {
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  if (
    runtime.schema !== 1 ||
    runtime.kind !== "project" ||
    runtime.project_id !== project.id ||
    typeof runtime.token !== "string" ||
    !/^[0-9a-f]{64}$/.test(runtime.token)
  )
    throw new Error(
      "Budget control requires this project's live local dashboard",
    );
  return { base: loopbackBase(runtime.local_url), key: runtime.token };
}
async function send(base, key, route, input, header = "authorization") {
  const response = await fetch(`${base}api/budget/${route}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      "content-type": "application/json",
      [header]: header === "authorization" ? `Bearer ${key}` : key,
    },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Budget operation failed");
  return result;
}
export async function budgetRequest(project, action, input) {
  if (!["policy", "usage", "inspect"].includes(action))
    throw new Error("Unknown budget action");
  const { base, key } = await runtimeFor(project);
  return send(base, key, action, input || {});
}
export async function prepareBudgetAttachment(
  project,
  record,
  { worker_id },
  command,
  env,
) {
  if (record.cli !== "dsh")
    throw new Error("Budget enforcement is unsupported for this adapter");
  const probe = await createCliAdapter({
    command,
    cwd: record.cwd,
    env,
  }).probe();
  if (
    probe.health !== "version_matched" ||
    probe.detected_version !== "0.2.0-rc.2"
  )
    throw new Error(
      "Budget enforcement requires verified native DSH 0.2.0-rc.2",
    );
  const { base, key } = await runtimeFor(project);
  const grant = await send(base, key, "launch", {
    run_id: record.run_id,
    worker_id,
    cli: record.cli,
    version: probe.detected_version,
  });
  if (!grant.allowed) throw new Error(`New job blocked: ${grant.reason}`);
  const patch = path.join(
    project.directory,
    `budget-guard-${grant.job_id}.patch.yml`,
  );
  try {
    const plugin = pathToFileURL(
      fileURLToPath(
        new URL("../plugins/rdsh-budget-guard/index.js", import.meta.url),
      ),
    ).href;
    await fs.writeFile(
      patch,
      `- insert:\n    - id: rdsh-budget-guard\n      name: ${JSON.stringify(plugin)}\n      config: {}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    await send(base, key, "revoke", { job_id: grant.job_id }).catch(() => {});
    throw error;
  }
  let closing;
  return {
    patch,
    job_id: grant.job_id,
    env: {
      ...env,
      RDSH_BUDGET_BASE: base,
      RDSH_BUDGET_KEY: grant.key,
      RDSH_BUDGET_JOB: grant.job_id,
    },
    async ready() {
      for (let attempt = 0; attempt < 50; attempt++) {
        const report = await send(
          base,
          grant.key,
          "producer/status",
          { job_id: grant.job_id },
          "x-rdsh-budget-token",
        );
        if (report.ready)
          return { job_id: grant.job_id, status: "guard_registered" };
        await delay(100);
      }
      throw new Error(
        "Native budget hook was not observed; no prompt may be sent",
      );
    },
    close() {
      return (closing ||= (async () => {
        try {
          await send(base, key, "revoke", { job_id: grant.job_id });
        } finally {
          await fs.unlink(patch).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      })());
    },
  };
}
