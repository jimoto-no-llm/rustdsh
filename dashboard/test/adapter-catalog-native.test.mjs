import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { adapterCatalog, operations, versions } from "../adapter-catalog.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const binary = path.resolve(repo, process.env.RDSH_BIN || process.env.BIN || path.join("target/debug", process.platform === "win32" ? "rdsh.exe" : "rdsh"));
const host = new URL("../adapter-catalog-native.mjs", import.meta.url).href;
const expected = JSON.stringify({ adapters: adapterCatalog() }, null, 2) + "\n";
async function scratch() {
  const parent = path.join(repo, "target/adapter-catalog-tests");
  await fs.mkdir(parent, { recursive: true });
  return await fs.mkdtemp(path.join(parent, "case-"));
}
function checked(executable, args, options) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 10000, ...options });
  assert.ifError(result.error); return result;
}
function invoke(executable, root, mode = "actual", language = "en", timeout = 10000) {
  const code = `import {runNativeAdapterCatalog} from ${JSON.stringify(host)};try{process.exitCode=await runNativeAdapterCatalog(${JSON.stringify(executable)},${JSON.stringify(language)})}catch(e){console.error(e.code||e.message);process.exitCode=1}`;
  return checked(process.execPath, ["--input-type=module", "-e", code], {
    timeout, env: { ...process.env, DSH_HOME: root, RDSH_LANG: "ja", NO_COLOR: "caller", FORCE_COLOR: undefined,
      RDSH_CATALOG_PEER_MODE: mode, RDSH_CATALOG_PEER_MARKER: path.join(root, `${mode}.marker`) },
  });
}
async function records(root, mode) {
  return (await fs.readFile(path.join(root, `${mode}.marker`), "utf8")).trim().split("\n").map(line => line.split("\t"));
}
function assertClosed(rows) {
  for (const pid of new Set(rows.map(row => Number(row[1])))) {
    assert.ok(Number.isSafeInteger(pid));
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "owned peer must be closed before the host settles");
  }
}

test("pure retained factory and direct native agree byte-for-byte in all locales without Node/settings", async () => {
  assert.deepEqual(operations, ["start", "resume", "send", "interrupt", "stop", "usage"]);
  assert.deepEqual(versions, ["0.2.0-rc.2", "0.2.2-rc.5"]);
  assert.deepEqual(adapterCatalog().map(row => row.id), ["dsh", "codex", "claude", "kimi"]);
  const root = await scratch(); await fs.writeFile(path.join(root, "rdsh.json"), "broken settings");
  for (const language of ["en", "ja", "zh-CN"]) {
    const result = checked(binary, ["adapter-catalog"], { env: { ...process.env, DSH_HOME: root, RDSH_LANG: language, PATH: "" } });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, expected); assert.equal(result.stderr, "");
    const adapted = invoke(binary, root, "actual", language);
    assert.equal(adapted.status, 0, adapted.stderr); assert.equal(adapted.stdout, expected); assert.equal(adapted.stderr, "");
  }
  const missing = invoke(path.join(root, "missing-peer.exe"), root);
  assert.equal(missing.status, 1); assert.equal(missing.stdout, ""); assert.match(missing.stderr, /ENOENT/);
});

test("host qualifies only a real Commands entry, contains probe effects and closes owned children", async () => {
  const root = await scratch(), peer = path.join(root, process.platform === "win32" ? "dsh.exe" : "dsh");
  const args = ["--edition=2021", fileURLToPath(new URL("./adapter-catalog-peer.rs", import.meta.url)), "-o", peer];
  if (process.platform === "win32") {
    const linker = process.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER ||
      (process.env.VCToolsInstallDir && path.join(process.env.VCToolsInstallDir, "bin/Hostx64/x64/link.exe"));
    if (linker) args.push("-C", `linker=${linker}`);
  }
  const compile = checked("rustc", args, { timeout: 30000 }); assert.equal(compile.status, 0, compile.stderr);
  for (const mode of ["legacy", "suffix", "after-help", "wrapped-description", "second-commands", "help-exit", "help-stderr", "help-signal", "overflow", "dirty-home"]) {
    const result = invoke(peer, root, mode);
    assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, "");
    assert.match(result.stderr, /unavailable|exceeds 64 KiB|ENOTEMPTY|EEXIST/);
    const rows = await records(root, mode); assert.deepEqual(rows.map(row => row[0]), ["help"]); assertClosed(rows);
    const home = rows[0][3]; assert.ok(path.isAbsolute(home)); assert.notEqual(home, root);
    assert.deepEqual(rows[0].slice(2), ["rdsh", home, "en", "1", "0", "0"]);
    if (mode === "dirty-home") assert.equal(await fs.readFile(path.join(home, "unexpected"), "utf8"), "keep me");
    else await assert.rejects(fs.access(home), { code: "ENOENT" });
  }
  for (const [mode, status, stdout] of [["color", 0, "peer-catalog\n"], ["exit7", 7, ""], ["op-signal", 1, ""]]) {
    const result = invoke(peer, root, mode, "zh-CN");
    assert.equal(result.status, status, result.stderr); assert.equal(result.stdout, stdout); assert.equal(result.stderr, "");
    const rows = await records(root, mode); assert.deepEqual(rows.map(row => row[0]), ["help", "operation"]); assertClosed(rows);
    assert.equal(rows[1][2], "rdsh"); assert.equal(rows[1][3], root); assert.equal(rows[1][4], "zh-CN"); assert.equal(rows[1][5], "caller");
    await assert.rejects(fs.access(rows[0][3]), { code: "ENOENT" });
  }
  // Run the finite pipe-holder first so it has exited by the end of the next two cases.
  for (const mode of ["pipe-child", "hang-help", "deadline"]) {
    const start = performance.now(), result = invoke(peer, root, mode, "en", 40000), elapsed = performance.now() - start;
    assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, /Native adapter catalog timed out/);
    assert.ok(elapsed >= 29000 && elapsed < 34000, `single 30-second deadline: ${elapsed}ms`);
    const rows = await records(root, mode); assertClosed(rows);
    assert.deepEqual(rows.map(row => row[0]), mode === "deadline" ? ["help", "operation"] : ["help"]);
    await assert.rejects(fs.access(rows[0][3]), { code: "ENOENT" });
  }
});
