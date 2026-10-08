// The public integration retries only an operator-selected original CLI version query.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createCliAdapter } from "./adapters.mjs";
import { runWithRetry, RetryError, RetryFailure } from "./retry.mjs";

async function fingerprint(options, signal) {
  const files = [];
  for (const argument of options.command) {
    const file = await fs.realpath(argument),
      stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024)
      throw new RetryError("probe_scope_unavailable");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, { signal }))
      hash.update(chunk);
    files.push({ path: file, sha256: hash.digest("hex") });
  }
  const cwd = await fs.realpath(options.cwd);
  if (!(await fs.stat(cwd)).isDirectory())
    throw new RetryError("probe_scope_unavailable");
  return createHash("sha256")
    .update(
      JSON.stringify({ kind: "cli_version_probe", profile: "acp", cwd, files }),
    )
    .digest("hex");
}
export async function probeCliWithRetry({
  history,
  operation_id,
  command,
  cwd = process.cwd(),
  env = process.env,
  budget = {},
  requestTimeout = 15000,
} = {}) {
  if (
    !Array.isArray(command) ||
    command.length < 1 ||
    command.length > 2 ||
    command.some(
      (argument) => typeof argument !== "string" || !path.isAbsolute(argument),
    )
  )
    throw new RetryError("absolute_original_cli_paths_required");
  const options = {
    command: [...command],
    cwd,
    env: { ...env },
    requestTimeout,
  };
  const scope_digest = await fingerprint(options);
  let report = null;
  const retry = await runWithRetry({
    history,
    operation_id,
    kind: "cli_version_probe",
    scope_digest,
    budget,
    authorize: async ({ signal }) => ({
      allowed: (await fingerprint(options, signal)) === scope_digest,
      scope_digest,
    }),
    execute: async ({ signal }) => {
      const adapter = createCliAdapter(options);
      report = await adapter.probe({ signal });
      if (!["version_matched", "compatible"].includes(report.health))
        throw new RetryFailure(adapter.probeFailureCategory || "permanent");
    },
  });
  return {
    adapter: report,
    retry,
    scope:
      "original CLI --version only; no profile, prompt, provider request or automatic model retry",
  };
}
