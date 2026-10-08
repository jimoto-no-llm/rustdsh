import fs from "node:fs/promises";
import path from "node:path";
import { loopbackBase } from "./connection-diagnostics.mjs";

export async function backupRequest(project, action, input = {}) {
  if (!["preview", "restore", "history"].includes(action))
    throw new Error("Unknown backup action");
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  if (
    runtime.schema !== 1 ||
    runtime.kind !== "project" ||
    runtime.project_id !== project.id ||
    !/^[a-f0-9]{64}$/.test(runtime.token)
  )
    throw new Error("Backup requires this project's live local dashboard");
  const response = await fetch(
    `${loopbackBase(runtime.local_url)}api/backup/${action}`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        authorization: `Bearer ${runtime.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Backup operation failed");
  return result;
}
