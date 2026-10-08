import fs from "node:fs/promises";
import path from "node:path";
import { replyCheck } from "./answer-applications.mjs";
import { loopbackBase } from "./connection-diagnostics.mjs";

// Explicit submission only: no provider request, native launch or agent loop.
export async function instructionRequest(
  project,
  action,
  input,
  fetchImpl = fetch,
) {
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  const base = loopbackBase(runtime.local_url);
  replyCheck(
    runtime.schema === 1 &&
      runtime.kind === "project" &&
      runtime.project_id === project.id &&
      /^[0-9a-f]{64}$/.test(runtime.mcp_token) &&
      /^[0-9a-f]{64}$/.test(runtime.token),
    "Dashboard runtime does not match the instruction project",
    400,
  );
  replyCheck(
    ["context", "submit", "resolve"].includes(action),
    "Unknown instruction action",
    400,
  );
  const route =
    action === "context"
      ? `context?consumer_id=${encodeURIComponent(input.consumer_id)}`
      : action;
  const response = await fetchImpl(`${base}api/instructions/${route}`, {
    method: action === "context" ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${action === "resolve" ? runtime.token : runtime.mcp_token}`,
      "content-type": "application/json",
    },
    body: action === "context" ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  const result = await response.json();
  replyCheck(
    response.ok,
    result.error || "Instruction request failed",
    response.status,
  );
  return result;
}
