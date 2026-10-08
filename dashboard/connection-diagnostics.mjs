import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  readProcessIdentity,
  matchProcessIdentity,
  validProcessIdentity,
} from "./process-identity.mjs";
import { writeJson } from "./state.mjs";

const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
const timestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
async function boundedFile(file, limit) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Invalid diagnostic file");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("Invalid diagnostic file");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await handle.close();
  }
}
export function loopbackBase(value) {
  if (
    typeof value !== "string" ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(value)
  )
    throw new Error("A literal loopback HTTP base URL is required");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("A literal loopback HTTP base URL is required");
  return url.href;
}
function validTunnel(record, project) {
  return (
    record?.schema === 1 &&
    record.project_id === project.id &&
    uuid(record.owner) &&
    uuid(record.dashboard_instance) &&
    record.health_file === `tunnel-health-${record.owner}.url` &&
    timestamp(record.started_at) &&
    (record.ended_at === null || timestamp(record.ended_at)) &&
    (record.process === null || validProcessIdentity(record.process)) &&
    Object.keys(record).every((key) =>
      [
        "schema",
        "project_id",
        "owner",
        "dashboard_instance",
        "health_file",
        "started_at",
        "ended_at",
        "process",
      ].includes(key),
    )
  );
}
export async function recordTunnel(
  project,
  instance,
  pid,
  owner = randomUUID(),
) {
  if (!uuid(instance) || !uuid(owner))
    throw new Error(
      "Restart the dashboard to record its connection generation",
    );
  const observation = await readProcessIdentity(pid);
  const record = {
    schema: 1,
    project_id: project.id,
    owner,
    dashboard_instance: instance,
    health_file: `tunnel-health-${owner}.url`,
    started_at: new Date().toISOString(),
    ended_at: null,
    process: observation.status === "observed" ? observation.identity : null,
  };
  await writeJson(path.join(project.directory, "tunnel-runtime.json"), record);
  return record;
}
export async function finishTunnel(project, record) {
  if (!validTunnel(record, project))
    throw new Error("Invalid tunnel observation");
  // Each launch retires its own marker. There is no read/write race with a new launcher.
  await writeJson(
    path.join(project.directory, `tunnel-ended-${record.owner}.json`),
    {
      owner: record.owner,
      ended_at: new Date().toISOString(),
    },
  );
  await fs
    .unlink(path.join(project.directory, record.health_file))
    .catch(() => {});
}
async function healthStatus(url, fetcher) {
  try {
    const response = await fetcher(url, {
      redirect: "error",
      signal: AbortSignal.timeout(2500),
    });
    // Only the HTTP status is evidence. Health detail bodies may contain private data.
    await response.body?.cancel();
    return Number.isInteger(response.status) &&
      response.status >= 100 &&
      response.status <= 599
      ? response.status
      : null;
  } catch {
    return null;
  }
}
export async function inspectTunnel(
  project,
  instance,
  { processReader = readProcessIdentity, fetcher = fetch } = {},
) {
  const result = {
    state: "unconfirmed",
    reason: "not_recorded",
    observed_at: new Date().toISOString(),
    started_at: null,
    ended_at: null,
    health: null,
    readiness: null,
  };
  let record;
  try {
    record = JSON.parse(
      await boundedFile(
        path.join(project.directory, "tunnel-runtime.json"),
        8192,
      ),
    );
  } catch (error) {
    return {
      ...result,
      reason: error.code === "ENOENT" ? "not_recorded" : "invalid_metadata",
    };
  }
  if (!validTunnel(record, project))
    return { ...result, reason: "invalid_metadata" };
  result.started_at = record.started_at;
  result.ended_at = record.ended_at;
  try {
    const marker = JSON.parse(
      await boundedFile(
        path.join(project.directory, `tunnel-ended-${record.owner}.json`),
        1024,
      ),
    );
    if (
      marker.owner !== record.owner ||
      !timestamp(marker.ended_at) ||
      Object.keys(marker).length !== 2
    )
      return { ...result, reason: "invalid_metadata" };
    result.ended_at = marker.ended_at;
  } catch (error) {
    if (error.code !== "ENOENT")
      return { ...result, reason: "invalid_metadata" };
  }
  if (result.ended_at)
    return { ...result, state: "stopped", reason: "launcher_exited" };
  if (!record.process)
    return { ...result, reason: "process_identity_unavailable" };
  const match = matchProcessIdentity(
    record.process,
    await processReader(record.process.pid),
  );
  if (match !== "alive")
    return {
      ...result,
      state: ["gone", "pid_reused"].includes(match) ? "stopped" : "unconfirmed",
      reason: match,
    };
  if (record.dashboard_instance !== instance)
    return {
      ...result,
      state: "stale_credentials",
      reason: "dashboard_restarted",
    };
  let base;
  try {
    base = loopbackBase(
      (
        await boundedFile(
          path.join(project.directory, record.health_file),
          1024,
        )
      ).trim(),
    );
  } catch {
    return { ...result, reason: "health_address_unavailable" };
  }
  [result.health, result.readiness] = await Promise.all([
    healthStatus(base + "healthz", fetcher),
    healthStatus(base + "readyz", fetcher),
  ]);
  return {
    ...result,
    state:
      result.health === 200 && result.readiness === 200
        ? "ready"
        : result.health === null || result.readiness === null
          ? "unreachable"
          : "not_ready",
    reason: "health_check",
  };
}

// Fixed keys and reasons only: credentials, addresses and arbitrary error text are never retained.
export class ConnectionObservations {
  constructor() {
    this.records = {};
  }
  record(stage, success, reason, channel) {
    if (
      ![
        "browser_auth",
        "mcp_auth",
        "server/discover",
        "tools/list",
        "events/list",
      ].includes(stage) ||
      ![
        "authenticated",
        "unauthorized",
        "protocol_response",
        "protocol_error",
      ].includes(reason)
    )
      return;
    const observed_at = new Date().toISOString();
    const previous = this.records[stage] || {
      last_success: null,
      last_failure: null,
    };
    this.records[stage] = {
      ...previous,
      state: success ? "observed" : "failed",
      reason,
      observed_at,
      [success ? "last_success" : "last_failure"]: observed_at,
      ...(channel === "loopback" || channel === "tailscale" ? { channel } : {}),
    };
  }
  snapshot(stage) {
    return {
      ...(this.records[stage] || {
        state: "unconfirmed",
        reason: "not_observed",
        observed_at: null,
        last_success: null,
        last_failure: null,
      }),
    };
  }
}
export function connectionReport({
  project,
  startedAt,
  browser,
  mcp,
  share,
  tunnel,
  events,
}) {
  return {
    schema: 1,
    project_id: project.id,
    observed_at: new Date().toISOString(),
    browser: {
      dashboard: { state: "ready", started_at: startedAt },
      authentication: browser,
      tailscale: share,
      phone: { state: "unconfirmed", reason: "device_not_identified" },
    },
    dot: {
      tunnel,
      authentication: mcp.authentication,
      discovery: mcp.discovery,
      tools: mcp.tools,
      events: mcp.events,
      subscriptions: events.subscriptions,
      verification: events.verification,
      callback: events.callback,
      response: {
        state: "unconfirmed",
        reason: "dot_response_not_observed",
        observed_at: null,
      },
    },
    end_to_end: { state: "unconfirmed", reason: "real_dot_response_required" },
  };
}
