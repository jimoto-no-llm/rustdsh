import fs from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  if (mode === "descendants") {
    const trace = process.env.RDSH_ADAPTER_FIXTURE_CHILD_TRACE;
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./owned-tree.mjs", import.meta.url)),
        "child",
        "stubborn",
        trace,
      ],
      { detached: true, windowsHide: true, stdio: "ignore" },
    );
    child.unref();
    for (let i = 0; i < 200; i++) {
      if (
        fs.existsSync(trace) &&
        fs.readFileSync(trace, "utf8").includes('"grandchild"')
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
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
  const routeOptions = (changed = false) => {
    if (!mode.startsWith("route_")) return undefined;
    const pair =
      mode === "route_changed" || changed
        ? ["fixture-provider", "model-B"]
        : ["fixture-provider", "model-A"];
    const currentValue =
      mode === "route_invalid"
        ? "fixture-peer-secret-not-a-model"
        : JSON.stringify(pair);
    const model = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: [{ value: currentValue, name: "Fixture model" }],
    };
    const reasoning = {
      id: "reasoning_effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [{ value: "high", name: "High" }],
    };
    return mode === "route_no_effort" ? [model] : [model, reasoning];
  };
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
      result.agentCapabilities.sessionCapabilities.list = {};
      if (mode === "missing_list")
        delete result.agentCapabilities.sessionCapabilities.list;
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
      if (
        [
          "new_session",
          "expired_session",
          "missing_session",
          "summary_response_lost",
        ].includes(mode)
      )
        reply(msg.id, { sessionId: "fixture-new-session" });
      else
        reply(msg.id, {
          ...fixture.start,
          ...(routeOptions() ? { configOptions: routeOptions() } : {}),
        });
    } else if (msg.method === "session/list") {
      if (mode === "bad_list")
        reply(msg.id, {
          sessions: [{ sessionId: "fixture-list-secret", cwd: "relative" }],
        });
      else if (mode === "list_loop")
        reply(msg.id, { sessions: [], nextCursor: "repeat" });
      else if (["expired_session", "missing_session"].includes(mode))
        reply(msg.id, { sessions: [] });
      else if (mode === "list_error")
        output({ jsonrpc: "2.0", id: msg.id, error: fixture.error });
      else
        reply(msg.id, {
          sessions: [
            {
              sessionId: fixture.start.sessionId,
              cwd:
                mode === "list_cwd_mismatch"
                  ? process.platform === "win32"
                    ? "C:\\other"
                    : "/other"
                  : process.cwd(),
              title: "fixture-title-secret-must-not-copy",
            },
          ],
        });
    } else if (msg.method === "session/resume") {
      if (msg.params.sessionId === "missing") {
        output({ jsonrpc: "2.0", id: msg.id, error: fixture.error });
      } else
        reply(msg.id, {
          ...fixture.resume,
          ...(routeOptions() ? { configOptions: routeOptions() } : {}),
        });
    } else if (msg.method === "session/prompt") {
      if (
        ["reply_effect", "reply_effect_lost", "reply_refusal"].includes(mode)
      ) {
        fs.appendFileSync(
          process.env.RDSH_ADAPTER_FIXTURE_REPLY_COUNTER,
          "effect\n",
        );
        if (mode === "reply_effect_lost") {
          process.exit(9);
          return;
        }
        if (mode === "reply_refusal") {
          reply(msg.id, { stopReason: "refusal" });
          return;
        }
      }
      if (mode === "route_drift")
        output({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: msg.params.sessionId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: routeOptions(true),
            },
          },
        });
      if (mode === "summary_response_lost") {
        fs.appendFileSync(
          process.env.RDSH_ADAPTER_FIXTURE_SUMMARY_COUNTER,
          "effect\n",
        );
        process.exit(9);
        return;
      }
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
