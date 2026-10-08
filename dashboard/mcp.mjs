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
import { feedbackValidity } from "./question-contracts.mjs";
import { costScopeSchema, costReportSchema } from "./cost-ledger.mjs";

// Bucket E (MCP) diagnostics — Issues #76-#79:
// Exposure control (#76), remote OAuth (#77), single-screen server
// diagnostics (#78), and binary resource handling (#79) live in the outer
// MCP layers, not in this dashboard server. Changes here stay limited to
// diagnostic wording and comments so callers can tell which name/URI failed,
// what exists, and what to do next. No large feature additions.

const string = { type: "string", minLength: 1, maxLength: 8000 };
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
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
    name: "dashboard_update_metrics",
    description:
      "Replace reported project metrics with measured values. Counters are cumulative snapshots, not increments. Optional cost_scope declares an immutable period and expected workers/sessions; cost_report records a source-labelled observation with stable event ID and sequence. Repeat IDs never add costs. Report an API estimate only with explicit external calculation basis; unknown costs remain null. Provider/CLI reports, estimates and invoices remain separate.",
    inputSchema: object(
      Object.fromEntries([
        ...metricNames.map((name) => [
          name,
          { type: ["number", "null"], minimum: 0 },
        ]),
        ["session_id", string],
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
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  const mcp = createMcpServer({
    getState: () => request("api/state"),
    mutate: (operation, input) => request(`api/update/${operation}`, input),
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
