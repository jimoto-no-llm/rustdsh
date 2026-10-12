import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboard = join(here, "..");

// Every module the browser imports must be both authorized and served by the
// project dashboard. A new UI module that misses either list returns 401/404
// and takes the whole page down (the browser e2e caught model-catalog-ui.mjs).
test("every browser module is authorized and served", async () => {
  const app = await readFile(join(dashboard, "app.mjs"), "utf8");
  const server = await readFile(join(dashboard, "server.mjs"), "utf8");
  const imports = [...app.matchAll(/from "\.\/([A-Za-z0-9_.-]+\.mjs)"/g)].map(
    (match) => match[1],
  );
  assert.ok(imports.length >= 10, `expected the app imports, found ${imports.length}`);
  for (const name of imports) {
    const occurrences = (server.match(new RegExp(`"/${name}"`, "g")) ?? []).length;
    assert.ok(
      occurrences >= 2,
      `${name} must appear in the public-asset check and the served list (found ${occurrences})`,
    );
  }
});
