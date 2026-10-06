// Protocol fixture. Cordis injection in real DSH is exercised separately.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
const build = JSON.parse(
  fs.readFileSync(new URL("./build.json", import.meta.url), "utf8"),
);
if (process.argv.includes("--version")) {
  console.log(build.version);
  process.exit(0);
}
if (process.argv[2] !== "--profile" || process.argv[3] !== "acp")
  throw new Error("ACP profile required");
if (process.argv[4] === "--patch") {
  const patch = fs.readFileSync(process.argv[5], "utf8");
  const plugin = JSON.parse(patch.match(/name: ("[^\n]+")/)[1]);
  if (build.plugin !== "fail") (await import(plugin)).apply({});
  process.argv.splice(4, 2);
}
const template = JSON.parse(
  fs.readFileSync(new URL("./protocol.json", import.meta.url), "utf8"),
);
const sessions = path.join(process.env.DSH_HOME, "fixture-sessions.json");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
let known = fs.existsSync(sessions)
  ? JSON.parse(fs.readFileSync(sessions, "utf8"))
  : [];
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const error = (id) =>
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: template.error }) + "\n",
  );
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") reply(msg.id, template.initialize);
  else if (msg.method === "session/new") {
    const id = build.name + "-" + randomUUID();
    known.push(id);
    fs.writeFileSync(sessions, JSON.stringify(known));
    reply(msg.id, { sessionId: id });
  } else if (msg.method === "session/resume") {
    if (known.includes(msg.params.sessionId) && build.resume !== "fail")
      reply(msg.id, template.resume);
    else error(msg.id);
  } else if (msg.method === "session/close") reply(msg.id, template.stop);
  else if (msg.method === "session/prompt") reply(msg.id, template.send);
  else if (msg.id !== undefined) error(msg.id);
});
