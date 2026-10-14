import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const harness = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
const cordis = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/cordis";
const plugin = pathToFileURL(join(process.cwd(), "index.js")).href;

test("real Cordis provides rdshCompute and releases its worker on plugin disposal", async (t) => {
  if (!existsSync(harness) || !existsSync("/Applications/DeepSeek Harness.app/Contents/Resources/app.asar")) {
    t.skip("DeepSeek Harness SDK is unavailable on this host");
    return;
  }

  const home = await mkdtemp(join(tmpdir(), "rdsh-compute-cordis-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "rdsh.json"), JSON.stringify({ features: { compute: true } }));

  const program = [
    "(async () => {",
    `  const { Context } = require(${JSON.stringify(cordis)});`,
    "  const { apply } = await import(process.argv.at(-1));",
    "  const ctx = new Context();",
    "  const fiber = ctx.plugin({ apply });",
    "  await fiber.await();",
    "  const bridge = ctx.get('rdshCompute');",
    "  if (!bridge) throw new Error('rdshCompute service was not provided');",
    "  const result = await bridge.estimate('abcd1234');",
    "  if (!result.usedRust || result.result.tokens !== 2) throw new Error('compute worker was not used');",
    "  await fiber.dispose();",
    "  if (ctx.get('rdshCompute') !== undefined) throw new Error('rdshCompute service leaked after dispose');",
    "  if (process._getActiveHandles().some(handle => handle.constructor?.name === 'ChildProcess' && handle.exitCode === null && handle.signalCode === null)) {",
    "    throw new Error('rdsh compute worker leaked after dispose');",
    "  }",
    "})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });",
  ].join("\n");
  const result = spawnSync(harness, ["--expose-internals", "-e", program, plugin], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME: home, RDSH_COMPUTE: "1" },
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
