// Private control channel. Payload stdio remains byte-identical and separate.
import readline from "node:readline";
import {
  linuxScope,
  windowsScope,
  cleanupScope,
} from "./process-scope-backends.mjs";
import { readProcessIdentity } from "./process-identity.mjs";

const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
let scope = null,
  starting = false,
  closing = false;
let queue = Promise.resolve();
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line.length > 1024 * 1024) {
    input.close();
    return;
  }
  queue = queue.then(async () => {
    let frame;
    try {
      frame = JSON.parse(line);
      if (!starting) {
        starting = true;
        if (
          frame.op !== "start" ||
          !/^owner_[a-f0-9-]{36}$/.test(frame.owner_id) ||
          !Array.isArray(frame.command) ||
          !frame.command.length ||
          frame.command.some((x) => typeof x !== "string" || x.includes("\0"))
        )
          throw new Error();
        const stdio = frame.framed ? ["pipe", "pipe", "pipe"] : [3, 4, 5];
        scope = await (process.platform === "linux"
          ? linuxScope(frame, stdio)
          : process.platform === "win32" && !frame.framed
            ? windowsScope(frame)
            : Promise.reject(new Error()));
        scope.child.on("exit", (code, signal) =>
          send({ type: "root_exit", code, signal }),
        );
        scope.child.on("error", () => send({ type: "monitor_error" }));
        if (frame.framed) {
          for (const name of ["stdout", "stderr"])
            scope.child[name].on("data", (buf) =>
              send({ type: name, data: buf.toString("base64") }),
            );
          scope.child.stdin.on("error", () => {});
        }
        const observation = await readProcessIdentity(scope.child.pid);
        send({
          type: "ready",
          pid: scope.child.pid,
          identity:
            observation.status === "observed" ? observation.identity : null,
          kind: scope.kind,
          kernel_id: scope.kernel_id,
        });
        return;
      }
      if (!scope || closing) throw new Error();
      if (frame.op === "stdin") {
        scope.child.stdin.write(Buffer.from(frame.data, "base64"));
        return;
      }
      if (frame.op === "eof") {
        scope.child.stdin.end();
        return;
      }
      let result;
      if (frame.op === "release") {
        await scope.release();
        result = { released: true };
      } else if (frame.op === "snapshot") result = await scope.snapshot();
      else if (frame.op === "term") result = await scope.term();
      else if (frame.op === "kill") result = await scope.kill();
      else if (frame.op === "dispose") {
        result = { closed: await scope.close() };
        if (result.closed) closing = true;
      } else throw new Error();
      send({ type: "response", id: frame.id, result });
      if (closing) process.exit(0);
    } catch {
      send(
        frame?.id
          ? { type: "response", id: frame.id, error: "ownership_unverifiable" }
          : { type: "monitor_error" },
      );
    }
  });
});
input.on("close", () => {
  void queue.finally(async () => {
    if (!closing && scope) await cleanupScope(scope);
    process.exit(0);
  });
});
