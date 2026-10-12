import fs from "node:fs/promises";
import path from "node:path";
import { writeJson } from "./state.mjs";

const privateRuntimeName = "owner-credentials.json";

export async function writeOwnerCredentials(directory, value) {
  await writeJson(path.join(directory, privateRuntimeName), value);
}

export async function readOwnerCredentials(directory) {
  const value = JSON.parse(
    await fs.readFile(path.join(directory, privateRuntimeName), "utf8"),
  );
  if (
    value.schema !== 1 ||
    !(typeof value.project_id === "string" || value.project_id === null) ||
    typeof value.kind !== "string" ||
    typeof value.instance_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.admin_token || "") ||
    !/^[0-9a-f]{64}$/.test(value.browser_token || "") ||
    typeof value.browser_url !== "string"
  )
    throw new Error("Invalid dashboard owner credentials");
  return value;
}

// Local owner-side commands may load both files. The stdio MCP server reads
// runtime.json directly and intentionally never calls this helper.
export async function readLocalRuntime(directory) {
  const runtime = JSON.parse(
    await fs.readFile(path.join(directory, "runtime.json"), "utf8"),
  );
  const credentials = await readOwnerCredentials(directory);
  if (
    runtime.schema !== 1 ||
    runtime.project_id !== credentials.project_id ||
    runtime.instance_id !== credentials.instance_id ||
    runtime.kind !== credentials.kind
  )
    throw new Error("Dashboard runtime and owner credentials do not match");
  return {
    ...runtime,
    token: credentials.admin_token,
    browser_token: credentials.browser_token,
    browser_url: credentials.browser_url,
  };
}
