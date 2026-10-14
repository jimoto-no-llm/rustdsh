import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCliAdapter } from "../adapters.mjs";
import { smokeAdapter } from "../adapter-smoke.mjs";

const unsupported = !["linux", "win32"].includes(process.platform);
const negativeOptions = {
  skip: unsupported
    ? false
    : "Requires an OS without the kernel ownership backend; supported OS lifecycle cases run separately",
};
async function rejectedFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rdsh-no-owner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "cli.mjs");
  await fs.writeFile(
    executable,
    `import fs from 'node:fs'; import path from 'node:path'; if (process.argv.includes('--version')) { fs.writeFileSync(path.join(process.cwd(), 'probe.json'), JSON.stringify({ home: process.env.HOME })); console.log('0.2.0-rc.2'); } else { fs.writeFileSync(path.join(process.cwd(), 'launched'), 'unexpected'); }`,
  );
  return { root, command: [process.execPath, executable] };
}

test(
  "unsupported ownership rejects before ACP execution and retains a confirmed no-child stop",
  negativeOptions,
  async (t) => {
    const { root, command } = await rejectedFixture(t);
    const adapter = createCliAdapter({ command, cwd: root });
    await assert.rejects(
      adapter.start(),
      (error) => error.code === "ownership_unavailable",
    );
    assert.equal(adapter.child, undefined);
    assert.equal(adapter.capabilities().stop_scope, null);
    await assert.rejects(fs.stat(path.join(root, "launched")), {
      code: "ENOENT",
    });
    assert.deepEqual(await adapter.stop(), {
      status: "not_running",
      confirmed: true,
    });
  },
);

test(
  "smoke retains a pre-ownership rejection and removes its isolated unused home",
  negativeOptions,
  async (t) => {
    const { root, command } = await rejectedFixture(t);
    await assert.rejects(
      smokeAdapter({ command, cwd: root }),
      (error) => error.code === "ownership_unavailable",
    );
    await assert.rejects(fs.stat(path.join(root, "launched")), {
      code: "ENOENT",
    });
    const probe = JSON.parse(
      await fs.readFile(path.join(root, "probe.json"), "utf8"),
    );
    assert.ok(path.basename(probe.home).startsWith("rdsh-acp-smoke-"));
    await assert.rejects(fs.stat(probe.home), { code: "ENOENT" });
  },
);

test("smoke retains its private home when cleanup returns an unconfirmed result", async (t) => {
  // A cleanup receipt cannot be made uncertain by deliberately leaking real
  // children in a portable unit test. This isolates the smoke cleanup policy;
  // supported-platform tests below still acquire and stop actual kernel scopes.
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-smoke-cleanup-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const marker = path.join(root, "home");
  const source = `
    import { registerHooks } from 'node:module';
    import { writeFileSync } from 'node:fs';
    const stub = 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(`
      import { writeFileSync } from 'node:fs';
      export class AdapterError extends Error { constructor(code) { super(code); this.code = code; } }
      export function createCliAdapter({env}) {
        writeFileSync(${JSON.stringify(marker)}, env.HOME);
        return { version: '0.2.0-rc.2',
          start: async () => ({session_id:'fixture'}), resume: async () => ({}),
          interrupt: async () => ({acknowledged:true}), usage: () => ({status:'unavailable'}),
          capabilities: () => ({protocol:'acp-stdio-v1', stop_scope:{status:'running'}}),
          stop: async () => ({confirmed:false}) };
      }`)});
    registerHooks({ resolve(specifier, context, next) {
      return specifier === './adapters.mjs' && context.parentURL === ${JSON.stringify(new URL("../adapter-smoke.mjs", import.meta.url).href)}
        ? {url:stub, shortCircuit:true} : next(specifier, context);
    }});
    const {smokeAdapter} = await import(${JSON.stringify(new URL("../adapter-smoke.mjs", import.meta.url).href)});
    try { await smokeAdapter(); console.log('unexpected_success'); }
    catch (error) { console.log(error.code); }
  `;
  let home;
  try {
    const result = await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      source,
    ]);
    home = await fs.readFile(marker, "utf8");
    assert.equal(result.stdout.trim(), "smoke_cleanup_unconfirmed");
    assert.equal((await fs.stat(home)).isDirectory(), true);
  } finally {
    home ??= await fs.readFile(marker, "utf8").catch(() => null);
    if (
      home &&
      path.dirname(path.resolve(home)) === path.resolve(os.tmpdir()) &&
      path.basename(home).startsWith("rdsh-acp-smoke-")
    )
      await fs.rm(home, { recursive: true, force: true });
  }
});
