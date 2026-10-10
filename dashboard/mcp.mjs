import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { metricNames } from "./state.mjs";
import { observationSchema } from "./observations.mjs";
import { feedbackValidity } from "./question-contracts.mjs";
import { costScopeSchema, costReportSchema } from "./cost-ledger.mjs";

// Bucket E (MCP) diagnostics — Issues #76-#79:
// Exposure control (#76), remote OAuth (#77), single-screen server
// diagnostics (#78), and binary resource handling (#79) live in the outer
// MCP layers, not in this dashboard server. Changes here stay limited to
// diagnostic wording and comments so callers can tell which name/URI failed,
// what exists, and what to do next. Security-sensitive execution stays behind
// the separate approval and sandbox adapters below.

const string = { type: "string", minLength: 1, maxLength: 8000 };
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const operationSchema = object({
  schema: { const: "rdsh.operation.v1" },
  tool_name: { enum: ["file.read", "file.write", "process.exec", "network.request"] },
  tool_input: { type: "object" },
}, ["schema", "tool_name", "tool_input"]);
const boundOperation = { task_id: string, contract_version: { type: "integer", minimum: 1 }, repository: string, operation: operationSchema };
const approvalUseSchema = object({
  ...boundOperation, id: string, request_version: { type: "integer", minimum: 1 },
  run_id: string, command_id: string, worker_role: { enum: ["review", "implementation"] },
  attempt: { type: "integer", minimum: 1 },
  cost_usd: { type: "number", minimum: 0, maximum: 1000000 },
}, ["id", "request_version", "task_id", "contract_version", "repository", "run_id", "command_id", "operation", "attempt", "cost_usd"]);
const decision = object(
  {
    kind: { enum: ["consultation", "approval"] },
    target: object(
      {
        task_id: string,
        run_id: string,
        session_id: string,
        action_id: string,
        revision: string,
      },
      ["revision"],
    ),
    choices: {
      type: "array",
      maxItems: 8,
      items: object({ id: string, label: string, detail: string }, [
        "id",
        "label",
      ]),
    },
    recommended_choice: string,
    recommendation_reason: string,
    diff: string,
    impact: string,
    conditions: string,
    cost: object(
      {
        currency: { const: "USD" },
        max: { type: ["number", "null"], minimum: 0 },
        description: string,
      },
      ["currency", "max"],
    ),
    expires_at: { type: "string", format: "date-time" },
    consumer_id: string,
  },
  ["kind"],
);
export const tools = [
  {
    name: "dashboard_check_worker_start",
    description: "Check the live Linux sandbox profile for a review/implementation worker. This does not start an LLM worker or authorize direct DSH filesystem tools; approved operations must use dashboard_execute_approved_operation. Unsupported environments stay on hold with no fallback.",
    inputSchema: object({ task_id: string, contract_version: { type: "integer", minimum: 1 },
      repository: string, run_id: string, worker_role: { enum: ["review", "implementation"] } },
    ["task_id", "contract_version", "repository", "run_id", "worker_role"]),
  },
  {
    name: "dashboard_update_metrics",
    description:
      "Report cumulative metric snapshots, not increments. Include observation kind, source, observed_at, session_id and reference; observation applies only to supplied fields and ratio counters must be sent together. Optional cost_scope declares an immutable period and expected workers/sessions; cost_report records a source-labelled observation with stable event ID and sequence. Repeat IDs never add costs. Report API estimates only with explicit external calculation basis; unknown costs remain null. Provider/CLI reports, estimates and invoices remain separate.",
    inputSchema: object(
      Object.fromEntries([
        ...metricNames.map((name) => [
          name,
          { type: ["number", "null"], minimum: 0 },
        ]),
        ["session_id", string],
        ["observation", observationSchema],
        ["cost_scope", costScopeSchema],
        ["cost_report", costReportSchema],
      ]),
    ),
  },
  {
    name: "dashboard_upsert_task",
    description:
      "Create or update a project task shown in the project dashboard.",
    inputSchema: object(
      {
        id: string,
        title: string,
        status: { enum: ["todo", "doing", "done", "blocked"] },
        milestone: string,
        blocker: string,
        observation: observationSchema,
      },
      ["id", "title", "status"],
    ),
  },
  {
    name: "dashboard_ask_question",
    description:
      "Place a legacy consultation or a typed decision card for a human. Typed approval requires a versioned action, choices, diff, impact, conditions and explicit USD limit (null means unknown). Use action revise/cancel with expected_revision for an existing typed question; cancellation needs cancel_reason. No reply grants execution authority. default_action is informational. Read answers and their current validity with dashboard_get_feedback.",
    inputSchema: object(
      {
        id: string,
        question: string,
        urgency: { enum: ["normal", "high", "critical"] },
        default_action: string,
        decision,
        action: { enum: ["create", "revise", "cancel"] },
        expected_revision: { type: "integer", minimum: 1 },
        cancel_reason: string,
      },
      ["id"],
    ),
  },
  {
    name: "dashboard_publish_event",
    description:
      "Publish progress, a note, or an artifact reference. Local files are referenced by name/path only; this server does not read or publish their contents.",
    inputSchema: object(
      {
        type: { enum: ["progress", "artifact", "note"] },
        title: string,
        detail: string,
        artifact: string,
        observation: observationSchema,
      },
      ["title"],
    ),
  },
  {
    name: "dashboard_get_feedback",
    description:
      "Read durable human answers after a sequence cursor. Pass next_cursor on the next call. Reads never consume, acknowledge or apply feedback. A consumer-bound reply has a stable reply_command_id; application acknowledgements require its separate run/session credential. Poll at appropriate workflow checkpoints if resource subscriptions are unavailable.",
    inputSchema: object({ after: { type: "integer", minimum: 0 } }),
  },
  {
    name: "dashboard_get_state",
    description:
      "Read this project’s metrics, tasks, questions, recent events and optional source-aware cost ledger. Ledger totals are per declared period/source/currency; missing workers remain unknown and invoice amounts are never used to correct estimates.",
    inputSchema: object({}),
  },
  {
    name: "dashboard_check_task_contract",
    description:
      "Check declared repository, cwd and write paths against the current task contract before an operation. Only within_scope passes this preflight; block and unparsed must stop. This does not grant approval, parse commands, or enforce an OS sandbox. Recheck immediately before use; contracts can change.",
    inputSchema: object({
      task_id: string,
      contract_version: { type: "integer", minimum: 1 },
      repository: string,
      cwd: string,
      write_paths: { type: "array", maxItems: 100, items: string },
    }, ["task_id", "contract_version", "repository", "cwd", "write_paths"]),
  },
  {
    name: "dashboard_check_operation",
    description:
      "Parse and audit a declared rdsh.operation.v1 tool operation against the task contract. Supported schemas: file.read, file.write, process.exec with direct argv, network.request. Unknown tools, fields and shell syntax are unparsed. within_policy is only structural preflight; execution requires a human approval and the sandbox executor.",
    inputSchema: object({
      task_id: string, contract_version: { type: "integer", minimum: 1 }, repository: string,
      operation: object({
        schema: { const: "rdsh.operation.v1" },
        tool_name: { enum: ["file.read", "file.write", "process.exec", "network.request"] },
        tool_input: { type: "object" },
      }, ["schema", "tool_name", "tool_input"]),
    }, ["task_id", "contract_version", "repository", "operation"]),
  },
  {
    name: "dashboard_request_approval",
    description: "Create a pending versioned approval request bound to the current parsed operation, worker role, run, command, cost/retry limits and expiry. worker_role defaults to review, which permits file.read only. This cannot grant human approval. Raw bodies, URL queries and argv values are represented by digests.",
    inputSchema: object({
      ...boundOperation, id: string, expected_version: { type: "integer", minimum: 0 },
      run_id: string, command_id: string, worker_role: { enum: ["review", "implementation"] },
      source_ref: string, expires_at: string,
      limits: object({ max_cost_usd: { type: "number", minimum: 0, maximum: 1000000 }, max_attempts: { type: "integer", minimum: 1, maximum: 10 } }, ["max_cost_usd", "max_attempts"]),
    }, ["id", "expected_version", "task_id", "contract_version", "repository", "run_id", "command_id", "source_ref", "expires_at", "limits", "operation"]),
  },
  {
    name: "dashboard_check_approval",
    description: "Check an existing human approval against the exact current operation and next retry/cost reservation. This does not reserve an attempt or execute anything; execution remains on hold without enforcement.",
    inputSchema: approvalUseSchema,
  },
  {
    name: "dashboard_claim_approval",
    description: "Atomically reserve one approved attempt and declared cost. Prevents duplicate/replayed reservations. It does not execute the operation or prove billing/enforcement; execution remains on hold.",
    inputSchema: approvalUseSchema,
  },
  {
    name: "dashboard_execute_approved_operation",
    description: "Atomically consume the approved attempt before executing its exact operation in the probed OS sandbox. Review permits only file.read; implementation rights remain bounded by the contract roots, origin, and exact executable arguments. Output is returned to this call, but sensitive body, query, and stdout/stderr contents are not stored in the approval ledger. Direct DSH tools and unsupported platforms remain denied.",
    inputSchema: approvalUseSchema,
  },
];
const routes = {
  dashboard_update_metrics: "metrics",
  dashboard_upsert_task: "task",
  dashboard_ask_question: "question",
  dashboard_publish_event: "event",
};
// #76: exact tool names take precedence over patterns; hidden tools stay
// unreachable via direct calls, PTC, and search. This server never bypasses
// the existing permission guard - unknown names fail closed and name the
// known tools with their source (the tools export in this module).
export function knownToolNames() {
  return tools.map((tool) => tool.name);
}
export function diagnoseUnknownTool(name) {
  return (
    `Unknown tool "${String(name)}": exact names take precedence over patterns. ` +
    `Available tools from this server: ${knownToolNames().join(", ")}. ` +
    `Check the effective exposure source (direct/deferred/hidden); hidden tools ` +
    `stay unreachable via direct calls, PTC, and search, and this server never ` +
    `bypasses the existing permission guard.`
  );
}
export async function executeTool(api, name, args = {}) {
  if (name === "dashboard_get_state") return await api.getState();
  if (name === "dashboard_check_worker_start") return await api.checkWorkerStart(args);
  if (name === "dashboard_check_task_contract") return await api.checkContract(args);
  if (name === "dashboard_check_operation") return await api.checkOperation(args);
  if (name === "dashboard_request_approval") return await api.requestApproval(args);
  if (name === "dashboard_check_approval") return await api.checkApproval(args);
  if (name === "dashboard_claim_approval") return await api.claimApproval(args);
  if (name === "dashboard_execute_approved_operation") return await api.executeApproval(args);
  if (name === "dashboard_get_feedback")
    return feedbackSince(await api.getState(), args.after ?? 0);
  if (routes[name]) {
    const state = await api.mutate(routes[name], args);
    return { project: state.project.id, revision: state.revision };
  }
  throw new Error(diagnoseUnknownTool(name));
}
const resourceDefinitions = [
  {
    uri: "dashboard://state",
    name: "Project dashboard state",
    mimeType: "application/json",
  },
  {
    uri: "dashboard://feedback",
    name: "Human answers",
    mimeType: "application/json",
  },
];
export function feedbackSince(state, after = 0) {
  if (!Number.isSafeInteger(after) || after < 0)
    throw new Error(
      `after must be a non-negative integer (received ${String(after)}). ` +
        `Pass next_cursor from the previous dashboard_get_feedback response; ` +
        `reads never consume or delete feedback.`,
    );
  const messages = state.feedback
    .filter((item) => item.sequence > after)
    .slice(0, 100)
    .map((item) => feedbackValidity(state, item));
  return { messages, next_cursor: messages.at(-1)?.sequence ?? after };
}
// #78 (single-screen diagnostics) / #79 (binary resources stay safe):
// keep text, supported images, and other binaries distinct; never expand
// base64 into model-facing text here. ui:// app resources are unsupported
// and HTML/script is never auto-executed. Returned URLs are never fetched
// unconditionally - reach the origin server/URI only via an explicit action.
export function diagnoseUnknownResource(uri) {
  return (
    `Unknown resource "${String(uri)}": known resources: ${resourceDefinitions.map((r) => r.uri).join(", ")}. ` +
    `Binary payloads are validated by size/MIME before saving and never expanded ` +
    `to text; ui:// app resources are unsupported and HTML/script is never ` +
    `auto-executed. Use an explicit action to reach the origin server/URI.`
  );
}
export function createMcpServer(api) {
  const server = new Server(
    { name: "rdsh-project-dashboard", version: "0.1.0" },
    { capabilities: { tools: {}, resources: { subscribe: true } } },
  );
  const subscriptions = new Set();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments || {};
      const name = request.params.name;
      const result = await executeTool(api, name, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resourceDefinitions,
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (!resourceDefinitions.some((resource) => resource.uri === uri))
      throw new Error(diagnoseUnknownResource(uri));
    const state = await api.getState();
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            uri === "dashboard://feedback" ? state.feedback : state,
          ),
        },
      ],
    };
  });
  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    if (
      !resourceDefinitions.some(
        (resource) => resource.uri === request.params.uri,
      )
    )
      throw new Error(diagnoseUnknownResource(request.params.uri));
    subscriptions.add(request.params.uri);
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });
  return {
    server,
    notify: async () => {
      for (const uri of subscriptions)
        await server.sendResourceUpdated({ uri }).catch(() => {});
    },
  };
}
export async function runStdio(project) {
  const readRuntime = async () =>
    JSON.parse(
      await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
    );
  // #77: remote MCP OAuth (discovery/login/refresh, per server name+URL) is
  // handled outside this file. This bearer token is scoped to one project
  // runtime only; refresh/logout affect just that entry, and secret values
  // never go to issues, logs, or profile exports.
  async function request(route, input) {
    const runtime = await readRuntime();
    if (runtime.kind !== "project" || runtime.project_id !== project.id)
      throw new Error(
        "Dashboard runtime belongs to a different project. " +
          "Reconnect this project to refresh runtime.json; tokens stay bound " +
          "to one project and are never written to issues, logs, or exports.",
      );
    const response = await fetch(`${runtime.local_url}${route}`, {
      method: input ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${runtime.mcp_token}`,
        "content-type": "application/json",
      },
      body: input ? JSON.stringify(input) : undefined,
      signal: AbortSignal.timeout(route === "api/approvals/execute" ? 6 * 60 * 1000 : 10000),
    });
    const result = await response.json();
    if (!response.ok && !(["api/contracts/check", "api/policy/check", "api/approvals/check", "api/approvals/claim", "api/approvals/execute", "api/workers/check"].includes(route) && response.status === 409))
      throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  const mcp = createMcpServer({
    getState: () => request("api/state"),
    mutate: (operation, input) => request(`api/update/${operation}`, input),
    checkContract: (input) => request("api/contracts/check", input),
    checkOperation: (input) => request("api/policy/check", input),
    requestApproval: (input) => request("api/approvals/request", input),
    checkApproval: (input) => request("api/approvals/check", input),
    claimApproval: (input) => request("api/approvals/claim", input),
    executeApproval: (input) => request("api/approvals/execute", input),
    checkWorkerStart: (input) => request("api/workers/check", input),
  });
  await mcp.server.connect(new StdioServerTransport());
  // Resource subscribers receive change notifications; disconnected clients can recover with cursors.
  let revision = null;
  const timer = setInterval(async () => {
    try {
      const state = await request("api/state");
      if (revision !== null && state.revision !== revision) await mcp.notify();
      revision = state.revision;
    } catch {}
  }, 2000);
  timer.unref();
  mcp.server.onclose = () => clearInterval(timer);
}
