import assert from "node:assert/strict";
import test from "node:test";
import { classifyUpdateFailure, UPDATE_FAILURES } from "../index.js";

test("installer failures map onto the codes the UI localises", () => {
	const enoent = Object.assign(new Error("spawn dsh ENOENT"), { code: "ENOENT" });
	assert.equal(classifyUpdateFailure(enoent, "").code, "cli-missing");
	assert.equal(classifyUpdateFailure(null, "getaddrinfo ENOTFOUND github.com").code, "network");
	assert.equal(classifyUpdateFailure(null, "request failed with status code 404").code, "release-missing");
	assert.equal(classifyUpdateFailure(null, "EACCES: permission denied, open profile").code, "permission");
	assert.equal(classifyUpdateFailure(null, "ENOSPC: no space left on device").code, "disk");
	assert.equal(classifyUpdateFailure(null, "Exit code: 1").code, "unknown");
});

test("every code has a reason and a hint", () => {
	for (const [key, failure] of Object.entries(UPDATE_FAILURES)) {
		assert.equal(failure.code, key);
		assert.equal(typeof failure.reason, "string");
		assert.ok(failure.reason.length > 0, key + " has no reason");
		assert.equal(typeof failure.hint, "string");
		assert.ok(failure.hint.length > 0, key + " has no hint");
	}
});
import { dshVersion } from "../index.js";

test("the DSH version comes from the running entry", () => {
	const cli = "/home/ryu/.dsh-latest/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js";
	const value = dshVersion(["node", cli]);
	assert.equal(typeof value, "string");
	// A path that is not a DSH install reports nothing rather than guessing.
	assert.equal(dshVersion(["node", "/nonexistent/bin.js"]), "");
});
