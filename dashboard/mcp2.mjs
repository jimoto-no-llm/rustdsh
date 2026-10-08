import {
  Server,
  createMcpHandler,
  ProtocolError,
} from "@modelcontextprotocol/server";
import { toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { isLegacyRequest } from "@modelcontextprotocol/server";
import * as z from "zod";
import { tools, executeTool } from "./mcp.mjs";
// Bucket E (MCP) diagnostics — Issues #76-#79: tool-call errors surface via
// executeTool diagnostics in mcp.mjs (exact-name precedence, known names,
// permission guard intact). Legacy clients are rejected, never silently
// downgraded; OAuth, single-screen server state, and binary safety stay in
// the outer layers. No large feature additions here.
import { eventDefinitions } from "./webhooks.mjs";

export function modernMcpHandler(api, hub, observations) {
  const handler = createMcpHandler(
    () => {
      const server = new Server(
        { name: "rdsh-project-dashboard", version: "0.1.0" },
        { capabilities: { tools: {}, events: {} } },
      );
      server.setRequestHandler("tools/list", async () => ({ tools }));
      server.setRequestHandler("tools/call", async (request) => {
        try {
          const result = await executeTool(
            api,
            request.params.name,
            request.params.arguments,
          );
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text", text: e.message }],
          };
        }
      });
      const params = z.object({}).passthrough().default({});
      server.setRequestHandler("events/list", { params }, async () => ({
        events: eventDefinitions,
      }));
      const eventParams = z
        .object({
          name: z.string(),
          arguments: z.object({ project_id: z.string() }).strict(),
          delivery: z.object({
            mode: z.literal("webhook"),
            url: z.url(),
            secret: z.string().optional(),
          }),
          cursor: z.string().nullable().optional(),
          ttlMs: z.number().int().positive().nullable().optional(),
        })
        .passthrough();
      const eventCall = (method) => async (input) => {
        try {
          return await hub[method](input);
        } catch (error) {
          throw new ProtocolError(
            error.code ?? -32602,
            error.message,
            error.data,
          );
        }
      };
      server.setRequestHandler(
        "events/subscribe",
        { params: eventParams },
        eventCall("subscribe"),
      );
      server.setRequestHandler(
        "events/unsubscribe",
        { params: eventParams },
        eventCall("unsubscribe"),
      );
      return server;
    },
    { legacy: "reject" },
  );
  const node = toNodeHandler({
    fetch: async (request, context) => {
      const response = await handler.fetch(request, context);
      const method = request.headers.get("mcp-method");
      if (["server/discover", "tools/list", "events/list"].includes(method)) {
        try {
          const body = await response.clone().json();
          const success = response.ok && body.result && !body.error;
          observations?.record(
            method,
            Boolean(success),
            success ? "protocol_response" : "protocol_error",
          );
        } catch {
          observations?.record(method, false, "protocol_error");
        }
      }
      return response;
    },
  });
  return {
    handle: (req, res, body) => node(req, res, body),
    isLegacy: async (req, body) =>
      isLegacyRequest(await toWebRequest(req, body), body),
  };
}
