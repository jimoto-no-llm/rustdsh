import fs from "node:fs/promises";
import path from "node:path";
import { loopbackBase } from "./connection-diagnostics.mjs";

// Use the existing project reporting endpoint; never open billing credentials.
export async function costRequest(project, action, input, fetchImpl = fetch) {
  if (!["declare", "report", "inspect"].includes(action))
    throw new Error("Unknown cost ledger action");
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  if (
    runtime.schema !== 1 ||
    runtime.kind !== "project" ||
    runtime.project_id !== project.id ||
    typeof runtime.mcp_token !== "string" ||
    !/^[0-9a-f]{64}$/.test(runtime.mcp_token)
  )
    throw new Error("Dashboard runtime does not match the cost project");
  const base = loopbackBase(runtime.local_url);
  const response = await fetchImpl(
    `${base}api/${action === "inspect" ? "state" : "update/metrics"}`,
    {
      method: action === "inspect" ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${runtime.mcp_token}`,
        "content-type": "application/json",
      },
      body:
        action === "inspect"
          ? undefined
          : JSON.stringify({
              [action === "declare" ? "cost_scope" : "cost_report"]: input,
            }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "Cost ledger request failed");
  return {
    project: result.project.id,
    revision: result.revision,
    cost_ledger: result.cost_ledger || null,
  };
}
