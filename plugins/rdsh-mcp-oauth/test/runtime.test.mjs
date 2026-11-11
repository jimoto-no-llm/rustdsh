import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadRuntime } from "../runtime.mjs";

const require = createRequire(import.meta.url);
const packageInfo = async (entry) =>
  JSON.parse(await readFile(join(dirname(entry), "../package.json"), "utf8"));

test("native MCP resolves the patched SDK and one shared service graph", async () => {
  const mcpPath = require.resolve("@deepseek-ai/dsh-mcp-client");
  const mcpRequire = createRequire(mcpPath);
  const sdkPath = mcpRequire.resolve("@modelcontextprotocol/client");
  assert.equal((await packageInfo(sdkPath)).version, "2.4.0");
  assert.equal(sdkPath, require.resolve("@modelcontextprotocol/client"));
  const sdkRequire = createRequire(sdkPath);
  assert.equal(
    (await packageInfo(sdkRequire.resolve("@modelcontextprotocol/core"))).version,
    "2.4.0",
  );
  for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/schemastery"]) {
    assert.equal(mcpRequire.resolve(name), require.resolve(name));
    for (const service of [
      "@deepseek-ai/dsh-credentials",
      "@deepseek-ai/dsh-credentials-local",
    ])
      assert.equal(
        createRequire(require.resolve(service)).resolve(name),
        require.resolve(name),
      );
  }
  const runtime = await loadRuntime();
  assert.equal(runtime.sdkVersion, "2.4.0");
  assert.equal(runtime.nativeVersion, "0.2.0-rc.2");
  assert.equal(runtime.sdk, await import(pathToFileURL(sdkPath).href));
});

test("lockfile contains one patched MCP client and core", async () => {
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  for (const name of ["client", "core"]) {
    const entries = Object.entries(lock.packages).filter(([path]) =>
      path.endsWith(`node_modules/@modelcontextprotocol/${name}`),
    );
    assert.equal(
      entries.length,
      1,
      `${name} must not have a second dependency graph`,
    );
    assert.equal(entries[0][1].version, "2.4.0");
  }
});

async function versionFixture(t, version) {
  // Keep synthetic packages under this installation so native peers resolve
  // through its real, shared graph. Never touch an installed SDK's metadata.
  const dir = await mkdtemp(join(resolve("node_modules"), "rdsh-sdk-version-"));
  t.after(() => rm(dir, { recursive: true }));
  const mcp = join(dir, "node_modules/@deepseek-ai/dsh-mcp-client");
  const sdk = join(mcp, "node_modules/@modelcontextprotocol/client");
  await mkdir(join(mcp, "lib"), { recursive: true });
  await mkdir(join(sdk, "dist"), { recursive: true });
  await writeFile(join(dir, "package.json"), "{}");
  await writeFile(
    join(mcp, "package.json"),
    JSON.stringify({
      name: "@deepseek-ai/dsh-mcp-client",
      version: "0.2.0-rc.2",
      main: "lib/index.cjs",
    }),
  );
  await writeFile(join(mcp, "lib/index.cjs"), "module.exports = {};");
  await writeFile(
    join(sdk, "package.json"),
    JSON.stringify({
      name: "@modelcontextprotocol/client",
      version,
      main: "dist/index.cjs",
    }),
  );
  await writeFile(
    join(sdk, "dist/index.cjs"),
    "exports.syntheticVersion = " + JSON.stringify(version) + ";",
  );
  return join(dir, "package.json");
}

test("an external DSH graph with an unaudited nested SDK is rejected", async (t) => {
  for (const version of ["2.0.0", "2.1.0", "2.3.0", "2.3.2", "3.0.0"])
    await assert.rejects(
      loadRuntime(await versionFixture(t, version)),
      /unsupported MCP SDK version/,
    );
});

test("both audited SDK versions are accepted from an external DSH graph", async (t) => {
  for (const version of ["2.2.0", "2.3.1"]) {
    const runtime = await loadRuntime(await versionFixture(t, version));
    assert.equal(runtime.sdk.syntheticVersion, version);
    assert.equal(runtime.sdkVersion, version);
  }
});
