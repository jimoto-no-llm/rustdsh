import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const [role = "root", mode = "stubborn", trace, port = "3081"] =
  process.argv.slice(2);
const record = (type) =>
  fs.appendFileSync(
    trace,
    JSON.stringify({ role, type, pid: process.pid }) + "\n",
  );
record("started");
const children = [];
if (role === "root" || role === "child") {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      role === "root" ? "child" : "grandchild",
      mode,
      trace,
      port,
    ],
    {
      stdio: "ignore",
      detached: ["detached", "root_exit"].includes(mode),
      windowsHide: true,
    },
  );
  children.push(child);
  child.unref();
}
process.on("SIGTERM", () => {
  record("term");
  if (mode === "cooperative") process.exit(0);
});
if (role === "root") {
  process.stdin.resume();
  process.stdin.on("end", () => {
    record("eof");
    if (mode === "cooperative" || mode === "root_exit") process.exit(0);
  });
  const timer = setInterval(() => {
    const rows = fs
      .readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    if (rows.some((r) => r.role === "grandchild" && r.type === "started")) {
      clearInterval(timer);
      console.log(`dsh web: http://127.0.0.1:${port}/?fixture=local-only`);
    }
  }, 20);
}
setInterval(() => record("heartbeat"), 100);
