import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveDshCli } from "../index.js";

/** A script that looks like the CLI entry and really exists. */
function fakeCli() {
	const dir = mkdtempSync(join(tmpdir(), "rdsh-cli-"));
	const script = join(dir, "lib", "bin.js");
	mkdirSync(join(dir, "lib"), { recursive: true });
	writeFileSync(script, "// cli\n");
	return script;
}

test("the update runs this installation's CLI, not whatever PATH has", () => {
	const script = fakeCli();
	const cli = resolveDshCli({ argv: ["/usr/bin/node", script], execPath: "/usr/bin/node", platform: "linux" });
	assert.equal(cli.command, "/usr/bin/node");
	assert.deepEqual(cli.args, [script]);
	assert.equal(cli.via, "process");
});

test("an embedded process falls back to the PATH shim per platform", () => {
	const linux = resolveDshCli({ argv: ["/usr/bin/node", "server.js"], execPath: "/usr/bin/node", platform: "linux" });
	assert.equal(linux.command, "dsh");
	assert.equal(linux.shell, false);
	const win = resolveDshCli({ argv: ["C:\\node.exe", "server.js"], execPath: "C:\\node.exe", platform: "win32" });
	assert.equal(win.command, "dsh.cmd");
	assert.equal(win.shell, true);
});

test("a moved or missing entry does not become the command", () => {
	const moved = resolveDshCli({ argv: ["/usr/bin/node", "/nonexistent/dsh/lib/bin.js"], execPath: "/usr/bin/node", platform: "linux" });
	assert.equal(moved.via, "path", "a missing script was trusted");
});
