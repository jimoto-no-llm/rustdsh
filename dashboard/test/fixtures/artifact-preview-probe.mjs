import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createArtifactPreview } from "../../artifact-preview.mjs";

const [root, mode] = process.argv.slice(2);
const file = path.join(root, "report.log");
const originalOpen = fs.open;
let replaced = false;
let opened = false;
let closed = false;
fs.open = async (name, ...args) => {
  if (name === file && mode === "replace") {
    await fs.unlink(file);
    execFileSync("mkfifo", [file]);
    replaced = true;
  }
  const handle = await originalOpen(name, ...args);
  opened = true;
  if (mode !== "text") {
    handle.read = () => assert.fail("special files must never be read");
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      closed = true;
    };
  }
  return handle;
};
try {
  const start = performance.now();
  const preview = await createArtifactPreview(
    { root },
    [{ sequence: 1, type: "artifact", artifact: "report.log" }],
    1,
  );
  const elapsed = performance.now() - start;
  if (mode === "replace") assert.equal(replaced, true);
  if (mode !== "text" && opened) assert.equal(closed, true);
  process.stdout.write(JSON.stringify({ ...preview, bytes: preview.bytes?.toString("utf8"), elapsed }));
} finally {
  fs.open = originalOpen;
}
