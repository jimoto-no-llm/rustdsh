/**
 * Issue #68: an edited dictionary has to reach the next response.
 *
 * The host used to freeze `lib/copy.js` at import time, so the copy injected
 * into the page (`globalThis.__RDSH_PWA_COPY__`) stayed stale until a restart.
 * These tests drive the host functions directly — no DSH process, no browser —
 * against a temporary copy of the package, because `node --test` runs the test
 * files in parallel: rewriting the shipped file in place would race the other
 * suites that import it.
 */

import assert from "node:assert/strict";
import { cpSync, copyFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COPY_FILE, createCopySource } from "../lib/copy-source.js";

/** A stock index document: the same shell the real Web server renders. */
const INDEX = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>`;

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dsh-copy-reload-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A private copy of the package, imported as its own module graph.
 *
 * A copy is the point: the host has to read the `lib/copy.js` that sits next
 * to *its* `index.js`, and the shipped file must stay byte-identical while the
 * other suites run.
 *
 * @param {string} name - directory name, unique per test.
 * @returns {Promise<object>} the cloned host module.
 */
async function cloneHost(name) {
	const clone = join(scratch, name);
	cpSync(packageDir, clone, { recursive: true });
	return import(pathToFileURL(join(clone, "index.js")).href);
}

/** The document without its inline scripts: the markup a desktop must keep seeing. */
function withoutScripts(html) {
	return html.replace(/<script>[\s\S]*?<\/script>/g, "");
}

/** Every injected payload assignment in a document, for counting. */
function payloadCount(html) {
	return (html.match(/globalThis\.__RDSH_PWA_COPY__\s*=/g) ?? []).length;
}

/** Add one string to the `en` pack of a dictionary, keeping the file valid. */
function withCopy(source, key, value) {
	const anchor = "export const COPY = {\n\ten: {";
	assert.ok(source.includes(anchor), "copy.js still opens the en pack where this test edits");
	return source.replace(anchor, `${anchor}\n\t\t${JSON.stringify(key)}: ${JSON.stringify(value)},`);
}

/** Add one label vocabulary to `PROBES`, keeping the file valid. */
function withProbe(source, key, values) {
	const anchor = "export const PROBES = {";
	assert.ok(source.includes(anchor), "copy.js still defines PROBES where this test edits");
	return source.replace(anchor, `${anchor}\n\t${JSON.stringify(key)}: ${JSON.stringify(values)},`);
}

test("an edited copy.js reaches the next document without a restart", async () => {
	const host = await cloneHost("edited");
	const before = host.decorateIndex(INDEX, {});
	assert.ok(!before.includes("test.copy.reloaded"), "the shipped dictionary has no such key");

	// The same module instance, the same process, a saved file: this is the
	// regression. No restart, no re-import.
	const dictionary = join(scratch, "edited", "lib", "copy.js");
	writeFileSync(dictionary, withProbe(
		withCopy(readFileSync(dictionary, "utf8"), "test.copy.reloaded", "Reloaded"),
		"testProbe",
		["reloaded"],
	), "utf8");

	const after = host.decorateIndex(INDEX, {});
	assert.ok(after.includes('"test.copy.reloaded":"Reloaded"'), "the new string is in the payload");
	assert.ok(after.includes('"testProbe":["reloaded"]'), "the probes come from the same snapshot");
	assert.equal(payloadCount(after), 1, "the edit replaces the payload instead of adding a second block");
	// #44: the reload only changes the payload's value. A desktop document is
	// still the stock markup plus this package's inert scripts.
	assert.equal(withoutScripts(after), withoutScripts(INDEX).replace("<head>", "<head><!--dsh-mobile-maxxing-->"),
		"no markup changes for a desktop");
});

test("an unchanged dictionary is read once; a save is the cache miss", () => {
	const file = join(scratch, "cached.js");
	copyFileSync(COPY_FILE, file);
	let reads = 0;
	const source = createCopySource({
		file,
		read: (path, encoding) => {
			reads += 1;
			return readFileSync(path, encoding);
		},
	});
	for (let i = 0; i < 4; i += 1) source();
	assert.equal(reads, 1, "four requests share one read");

	// A save moves the mtime; the reader has to treat that as new bytes even
	// when the size happens to match.
	const later = new Date(Date.now() + 5000);
	utimesSync(file, later, later);
	source();
	assert.equal(reads, 2, "an mtime change is a new read");
});

test("a half-written copy.js keeps the last good copy and recovers", async () => {
	const host = await cloneHost("broken");
	const dictionary = join(scratch, "broken", "lib", "copy.js");
	const pristine = readFileSync(dictionary, "utf8");
	const good = host.decorateIndex(INDEX, {});
	assert.ok(good.includes('"tab.mobile":"Mobile"'), "the shipped dictionary loaded");

	// What a save looks like halfway through: the table is gone, the file is
	// still open for writing. The page must not see that.
	writeFileSync(dictionary, "export const COPY = { en: {", "utf8");
	const broken = host.decorateIndex(INDEX, {});
	assert.ok(broken.includes('"tab.mobile":"Mobile"'), "the previous snapshot keeps answering");
	assert.equal(payloadCount(broken), 1);

	// The next complete save is picked up, still without a restart.
	writeFileSync(dictionary, withCopy(pristine, "test.copy.recovered", "Recovered"), "utf8");
	assert.ok(host.decorateIndex(INDEX, {}).includes('"test.copy.recovered":"Recovered"'),
		"the next valid save is picked up");
});
