// A fixed, local ACP peer. No models, credentials, tools or external endpoints.
import "./fault-simulator-network.mjs";
import fs from "node:fs";
import readline from "node:readline";
import http from "node:http";

if (process.env.RDSH_FAULT_ISOLATED !== "1")
  throw new Error("This fixture requires an isolated simulator process");
const mode = process.env.RDSH_FAULT_SCENARIO;
const trace = process.env.RDSH_FAULT_TRACE;
const record = (event) =>
  fs.appendFileSync(trace, JSON.stringify(event) + "\n", { mode: 0o600 });

if (process.argv.includes("--version")) {
  console.log("0.2.0-rc.2");
} else if (process.argv.includes("--fixture-http")) {
  let receipt = null;
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/effect") {
      let body = "";
      for await (const part of request) {
        body += part;
        if (body.length > 4096) return request.destroy();
      }
      const input = JSON.parse(body);
      if (!receipt) {
        receipt = { ...input, outcome: "applied" };
        record({ type: "effect", operation_id: input.operation_id });
      }
      // The operation is committed, but its response never reaches the caller.
      record({ type: "network_disconnect" });
      request.socket.destroy();
    } else if (request.method === "GET" && request.url === "/receipt") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(receipt));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1", () =>
    process.send({ type: "ready", port: server.address().port }),
  );
  process.on("message", (message) => {
    if (message?.type !== "stop") return;
    server.closeAllConnections();
    server.close(() => {
      process.send({ type: "listener_closed" }, () => process.disconnect());
    });
  });
  process.on("disconnect", () => {
    if (!server.listening) return;
    server.closeAllConnections();
    server.close();
  });
} else {
  if (JSON.stringify(process.argv.slice(2)) !== '["--profile","acp"]')
    throw new Error("The fixture accepts the ACP profile only");
  const output = (message) =>
    process.stdout.write(JSON.stringify(message) + "\n");
  const reply = (id, result) => output({ jsonrpc: "2.0", id, result });
  const session = "fault-simulator-session";
  const prompts = new Set();
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (!message.method) return;
    record({ type: "request", method: message.method });
    if (message.method === "initialize") {
      reply(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "deepseek-harness-acp", version: "0.0.1" },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      });
    } else if (message.method === "session/new")
      reply(message.id, { sessionId: session });
    else if (message.method === "session/resume") reply(message.id, {});
    else if (message.method === "session/list")
      reply(message.id, { sessions: [{ sessionId: session, cwd: process.cwd() }] });
    else if (message.method === "session/prompt") {
      if (mode === "gpu_loss") {
        record({ type: "mock_gpu_lost", device: "fixture-gpu-0" });
        output({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "Simulated GPU disappearance" },
        });
        return;
      }
      record({ type: "effect" });
      if (mode === "restart") {
        prompts.add(message.id);
        output({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: session,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "fault-effect-committed" },
            },
          },
        });
        return;
      }
      if (mode === "duplicate_events") {
        for (let n = 0; n < 2; n++) {
          record({ type: "duplicate_event" });
          output({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: session,
            update: { sessionUpdate: "usage_update", used: 1, size: 8192 },
          } });
        }
      }
      reply(message.id, { stopReason: "end_turn" });
    } else if (message.method === "session/cancel") {
      for (const id of prompts) reply(id, { stopReason: "cancelled" });
      prompts.clear();
    } else if (message.method === "session/close") reply(message.id, {});
    else
      output({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Unsupported fixture operation" },
      });
  });
}
