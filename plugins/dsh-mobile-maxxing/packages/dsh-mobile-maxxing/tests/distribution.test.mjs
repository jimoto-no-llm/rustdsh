/**
 * Distribution checks: the tarball has to be something `dsh plugin add`
 * accepts and something DSH's plugin inventory can render, and the docs have
 * to show the command DSH actually takes.
 *
 * These run without a DSH process and without a browser, like the other unit
 * tests; they only read the files that `npm pack` ships.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const repo = join(packageDir, "..", "..");
// The repository root is the published package; packages/dsh-mobile-maxxing ships inside it.
const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));

test("the manifest is a DSH bundle with a client half", async () => {
	assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml", "a bundle declares its patch");
	assert.ok(manifest.exports?.["./client"], "the client half needs the ./client export");
	assert.equal(manifest.dsh?.client?.platform, "web");
	await stat(join(repo, manifest.dsh.bundle.patch));

	const client = await readFile(join(packageDir, "client.js"), "utf8");
	assert.match(client, new RegExp(`id: "${manifest.name}"`),
		"the browser module id has to equal the package name");
});

test("the inventory can read a title, a description and an icon", async () => {
	assert.ok(manifest.exports?.["./locale/*.json"], "locale resources must be exported");
	for (const language of ["en", "ja"]) {
		const locale = JSON.parse(await readFile(join(packageDir, "locale", `${language}.json`), "utf8"));
		assert.ok(locale.meta?.title, `${language}.json needs meta.title`);
		assert.ok(locale.meta?.description, `${language}.json needs meta.description`);
	}
	assert.ok(manifest.files.some((entry) => entry.endsWith("locale/*.json")), "locale files have to ship");

	// DSH resolves the icon as the exported `./icon` resource, not through a
	// top-level `icon` field: package.json is not an exported subpath, so the
	// manifest never sees that field.
	const icon = manifest.exports["./icon"];
	assert.ok(icon, "the icon has to be exported as ./icon");
	const file = await stat(join(repo, icon));
	assert.ok(file.isFile(), "the exported icon has to exist");
	assert.ok(file.size <= 256 * 1024, "DSH refuses an icon above 256 KiB");
	assert.ok(manifest.files.some((entry) => entry.endsWith("assets/*.png")), "the icon has to ship");
});

test("the root tarball stays free of the optional locale whole-pack", async () => {
	const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: repo, encoding: "utf8" });
	const entries = JSON.parse(output)[0].files.map((entry) => entry.path);
	assert.equal(entries.some((entry) => entry.includes("dsh-locale-ja")), false,
		"the mobile tarball contains the separate locale package");
	assert.equal(entries.some((entry) => entry === "packages/dsh-locale-ja/client.js"), false);
	assert.ok(entries.includes("packages/dsh-mobile-maxxing/locale/ja.json"),
		"the mobile package keeps its own UI locale metadata");
});

test("the docs use the plugin command DSH takes", async () => {
	for (const doc of ["README.md", join("packages", "dsh-mobile-maxxing", "README.md")]) {
		const text = await readFile(join(repo, doc), "utf8");
		assert.doesNotMatch(text, /dsh plugin add\b/, `${doc}: "dsh plugin add" needs --profile`);
		assert.doesNotMatch(text, /^\s*cd ~\/\.dsh\/profiles\/web/m,
			`${doc}: the install command works from any directory`);
		assert.ok(text.includes("dsh plugin --profile web add "), `${doc}: show the install command`);
	}
});

test("the nested manifest and the README install URLs match the root version", async () => {
	const nested = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
	assert.equal(nested.name, manifest.name, "the implementation keeps the published name");
	assert.equal(nested.version, manifest.version, "the nested manifest stays version-synced");

	const readme = await readFile(join(packageDir, "README.md"), "utf8");
	const installs = [...readme.matchAll(
		/https:\/\/github\.com\/kuraneko1\/dsh-mobile-maxxing\/releases\/download\/v([^\/\s"']+)\/([^\s"'#?]+\.tgz)/g,
	)];
	assert.ok(installs.length >= 1, "the implementation README has to show a versioned install URL");
	for (const [, version, file] of installs) {
		assert.equal(version, manifest.version, `the download path says v${version}`);
		assert.equal(file, `${manifest.name}-${manifest.version}.tgz`, `the download file says ${file}`);
	}
});
