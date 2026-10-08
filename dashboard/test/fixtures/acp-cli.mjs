import fs from "node:fs";
import readline from "node:readline";
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./dsh-acp-0.2.0-rc.2.json", import.meta.url),
    "utf8",
  ),
);
const mode = process.env.RDSH_ADAPTER_FIXTURE_MODE || "normal";
if (process.argv.includes("--version")) {
  let firstTimeout = false;
  if (mode === "version_timeout_once") {
    const counter = process.env.RDSH_ADAPTER_FIXTURE_VERSION_COUNTER;
    const previous = fs.existsSync(counter)
      ? Number(fs.readFileSync(counter, "utf8"))
      : 0;
    fs.writeFileSync(counter, String(previous + 1));
    firstTimeout = previous === 0;
  }
  if (mode === "version_timeout" || firstTimeout) setInterval(() => {}, 1000);
  else {
    console.log(
      mode === "new_version"
        ? "0.2.0-rc.3"
        : mode === "secret_version"
          ? "fixture-version-secret-must-not-print"
          : fixture.cli_version,
    );
    process.exit(0);
  }
} else {
  if (
    JSON.stringify(process.argv.slice(2)) !==
    JSON.stringify(["--profile", "acp"])
  )
    throw new Error("Fixture requires the shipped ACP profile invocation");
  // Exercise process ownership and escalation, without touching other processes.
  if (mode === "ignore_eof") {
    setInterval(() => {}, 1000);
    process.on("SIGTERM", () => {});
  }
  const output = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const reply = (id, result) => output({ jsonrpc: "2.0", id, result });
  const trace = (msg) => {
    if (process.env.RDSH_ADAPTER_FIXTURE_TRACE)
      fs.appendFileSync(
        process.env.RDSH_ADAPTER_FIXTURE_TRACE,
        JSON.stringify(msg) + "\n",
      );
  };
  const prompts = new Map();
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const msg = JSON.parse(line);
    trace(msg);
    if (!msg.method) {
      if (msg.id === "permission" || msg.id === "filesystem")
        for (const [id] of prompts) reply(id, fixture.interrupt);
      prompts.clear();
      return;
    }
    if (msg.method === "initialize") {
      if (mode === "bad_json") {
        process.stdout.write("fixture-invalid-secret-must-not-print\n");
        return;
      }
      if (mode === "oversized") {
        process.stdout.write("x".repeat(1024 * 1024 + 1));
        return;
      }
      if (mode === "invalid_utf8") {
        process.stdout.write(Buffer.from([0xff, 10]));
        return;
      }
      if (mode === "timeout") return;
      const result = structuredClone(fixture.initialize);
      if (mode === "wrong_protocol") result.protocolVersion = 999;
      if (mode === "missing_resume")
        delete result.agentCapabilities.sessionCapabilities.resume;
      reply(msg.id, result);
    } else if (msg.method === "session/new") {
      if (mode === "early_exit") {
        process.exit(9);
        return;
      }
      if (mode === "bad_new") {
        reply(msg.id, {});
        return;
      }
      reply(msg.id, fixture.start);
    } else if (msg.method === "session/resume") {
      if (msg.params.sessionId === "missing") {
        output({ jsonrpc: "2.0", id: msg.id, error: fixture.error });
      } else reply(msg.id, fixture.resume);
    } else if (msg.method === "session/prompt") {
      if (mode === "cli_error" || mode === "unsupported_send") {
        output({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            ...fixture.error,
            code: mode === "unsupported_send" ? -32601 : -32000,
          },
        });
        return;
      }
      if (mode === "busy" || mode === "permission" || mode === "filesystem") {
        prompts.set(msg.id, msg.params.sessionId);
        if (mode === "permission" || mode === "filesystem")
          output({
            jsonrpc: "2.0",
            id: mode,
            method:
              mode === "permission"
                ? "session/request_permission"
                : "fs/read_text_file",
            params: {
              sessionId: msg.params.sessionId,
              path: "fixture-peer-secret-must-not-print",
            },
          });
        return;
      }
      for (const update of fixture.updates) {
        const value =
          mode === "invalid_usage" && update.sessionUpdate === "usage_update"
            ? { ...update, used: -1 }
            : update;
        output({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: msg.params.sessionId, update: value },
        });
      }
      reply(msg.id, fixture.send);
    } else if (msg.method === "session/cancel") {
      for (const [id, session] of prompts)
        if (session === msg.params.sessionId) {
          reply(id, fixture.interrupt);
          prompts.delete(id);
        }
    } else if (msg.method === "session/close") {
      if (mode === "no_close") return;
      reply(msg.id, fixture.stop);
    } else if (msg.id !== undefined)
      output({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Unsupported fixture operation" },
      });
  });
}
