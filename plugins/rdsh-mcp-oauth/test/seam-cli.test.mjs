import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.mjs";
import { loadRuntime } from "../runtime.mjs";
import { ORIGINAL_SHA256, patchSource, sha256 } from "../native-seam.mjs";

const require = createRequire(import.meta.url);
const source = await readFile(
  require.resolve("@deepseek-ai/dsh-mcp-client"),
  "utf8",
);
assert.equal(sha256(source), ORIGINAL_SHA256);

async function fixture(t, version = "2.0.0") {
  // This graph has no Cordis or credential services. Rollback must resolve the
  // audited file without importing any native or SDK code from this graph.
  const dir = await mkdtemp(join(tmpdir(), "rdsh-seam-cli-"));
  t.after(() => rm(dir, { recursive: true }));
  const mcp = join(dir, "node_modules/@deepseek-ai/dsh-mcp-client");
  const sdk = join(mcp, "node_modules/@modelcontextprotocol/client");
  const file = join(mcp, "lib/index.mjs");
  const marker = join(dir, "sdk-imported");
  await mkdir(join(mcp, "lib"), { recursive: true });
  await mkdir(join(sdk, "dist"), { recursive: true });
  const packagePath = join(dir, "package.json");
  await writeFile(packagePath, "{}");
  await writeFile(
    join(mcp, "package.json"),
    JSON.stringify({
      name: "@deepseek-ai/dsh-mcp-client",
      version: "0.2.2-rc.5",
      main: "lib/index.mjs",
    }),
  );
  await writeFile(file, patchSource(source));
  await writeFile(
    join(sdk, "package.json"),
    JSON.stringify({
      name: "@modelcontextprotocol/client",
      version,
      main: "dist/index.mjs",
    }),
  );
  await writeFile(
    join(sdk, "dist/index.mjs"),
    'import { writeFileSync } from "node:fs"; writeFileSync(' +
      JSON.stringify(marker) +
      ', "imported"); throw new Error("SDK must not execute during rollback");',
  );
  return { dir, mcp, sdk, file, marker, packagePath };
}

async function invoke(command, packagePath) {
  let output = "";
  let error = "";
  const code = await main([command, "--dsh-package", packagePath], {
    stdout: { write: (value) => (output += value) },
    stderr: { write: (value) => (error += value) },
  });
  return { code, output, error };
}

test("revert-seam restores an audited seam with an old SDK without importing runtime services", async (t) => {
  const f = await fixture(t);
  const result = await invoke("revert-seam", f.packagePath);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(JSON.parse(result.output), {
    action: "revert",
    sha256: ORIGINAL_SHA256,
    changed: true,
  });
  assert.equal(await readFile(f.file, "utf8"), source);
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  // Removing an unused SDK must not prevent restoration or its idempotent retry.
  await rm(f.sdk, { recursive: true });
  await writeFile(f.file, patchSource(source));
  const again = await invoke("revert-seam", f.packagePath);
  assert.equal(again.code, 0, again.error);
  assert.equal(JSON.parse(again.output).changed, true);
  assert.equal(await readFile(f.file, "utf8"), source);
  const unchanged = await invoke("revert-seam", f.packagePath);
  assert.equal(unchanged.code, 0, unchanged.error);
  assert.equal(JSON.parse(unchanged.output).changed, false);
});

test("revert-seam does not import an audited-version SDK either", async (t) => {
  const f = await fixture(t, "2.2.0");
  const result = await invoke("revert-seam", f.packagePath);
  assert.equal(result.code, 0, result.error);
  assert.equal(await readFile(f.file, "utf8"), source);
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
});

test("all commands that enable or use runtime retain the strict old-SDK rejection", async (t) => {
  const f = await fixture(t);
  const patched = await readFile(f.file, "utf8");
  await assert.rejects(loadRuntime(f.packagePath), /unsupported MCP SDK version/);
  for (const command of [
    "install-seam", "verify-seam", "diagnose", "login", "finish", "inspect",
    "export", "logout",
  ]) {
    const result = await invoke(command, f.packagePath);
    assert.equal(result.code, 1, command);
    assert.equal(result.output, "", command);
    assert.equal(await readFile(f.file, "utf8"), patched, command);
  }
  await assert.rejects(readFile(f.marker), { code: "ENOENT" });
});

test("revert-seam rejects unknown native bytes without creating or changing files", async (t) => {
  const f = await fixture(t);
  const unknown = patchSource(source) + "\n// unrelated update\n";
  await writeFile(f.file, unknown);
  const names = await readdir(join(f.mcp, "lib"));
  const result = await invoke("revert-seam", f.packagePath);
  assert.equal(result.code, 1);
  assert.equal(result.output, "");
  assert.equal(await readFile(f.file, "utf8"), unknown);
  assert.deepEqual(await readdir(join(f.mcp, "lib")), names);
});

test("revert-seam rejects missing or directory package paths without falling back to a nearby graph", async (t) => {
  const f = await fixture(t);
  const patched = await readFile(f.file, "utf8");
  for (const packagePath of [join(f.dir, "missing.json"), f.dir]) {
    const result = await invoke("revert-seam", packagePath);
    assert.equal(result.code, 1, packagePath);
    assert.equal(result.output, "");
    assert.equal(await readFile(f.file, "utf8"), patched);
  }
});

test("revert-seam refuses unrelated file anchors and non-object manifests without writing", async (t) => {
  for (const [name, filename, contents] of [
    ["text file", "readme.txt", "This is not a package manifest."],
    ["other JSON filename", "owner.json", "{}"],
    ["malformed JSON", "package.json", "{"],
    ["null", "package.json", "null"],
    ["array", "package.json", "[]"],
    ["string", "package.json", '"manifest"'],
    ["number", "package.json", "1"],
    ["boolean", "package.json", "true"],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      const packagePath = join(f.dir, filename);
      await writeFile(packagePath, contents);
      const patched = await readFile(f.file, "utf8");
      const names = await readdir(join(f.mcp, "lib"));
      const result = await invoke("revert-seam", packagePath);
      assert.equal(result.code, 1, name);
      assert.equal(result.output, "", name);
      assert.equal(await readFile(f.file, "utf8"), patched, name);
      assert.deepEqual(await readdir(join(f.mcp, "lib")), names, name);
    });
  }
});

test("an owning project manifest need not be named DSH or declare dependencies", async (t) => {
  const f = await fixture(t);
  await writeFile(f.packagePath, '{"name":"my-owning-project"}');
  const result = await invoke("revert-seam", f.packagePath);
  assert.equal(result.code, 0, result.error);
  assert.equal(await readFile(f.file, "utf8"), source);
});
