/**
 * Pack every publishable package into dist/.
 *
 * The release attaches these tarballs, and each package's README points at
 * them, so the file names have to be predictable: `<name>-<version>.tgz`.
 *
 * Three artifacts exist:
 *
 * - the mobile package (the repository root), always packed;
 * - the independent Markdown table package, always packed;
 * - the optional Japanese locale package, packed only when its generated
 *   translation-status.json reports the complete 65 namespaces / 2915 keys
 *   with zero English fallback. An incomplete locale is refused loudly: the
 *   release must never quietly ship an English fallback pack as Japanese.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const localeDir = join(root, "packages", "dsh-locale-ja");
const localeStatusFile = join(localeDir, "locale", "translation-status.json");

/** The only translation state that may be published as a Japanese pack. */
export const LOCALE_REQUIREMENTS = Object.freeze({ namespaces: 65, keys: 2915, fallback: 0 });

/**
 * Decide whether the locale package may be packed.
 *
 * @param {object|null|undefined} status - parsed locale/translation-status.json.
 * @returns {{ publish: boolean, reason: string }} the decision and a human reason.
 */
export function localePublishDecision(status) {
	if (status === null || typeof status !== "object") {
		return { publish: false, reason: "locale/translation-status.json is missing or unreadable" };
	}
	const totals = status.totals;
	if (totals === null || typeof totals !== "object") {
		return { publish: false, reason: "translation-status.json has no totals" };
	}
	const summary = `${totals.translated ?? "?"}/${totals.keys ?? "?"} translated, ${totals.fallback ?? "?"} English fallback`;
	if (status.locale !== "ja") {
		return { publish: false, reason: `translation-status.json is not for ja (${String(status.locale)})` };
	}
	if (totals.namespaces !== LOCALE_REQUIREMENTS.namespaces || totals.keys !== LOCALE_REQUIREMENTS.keys) {
		return { publish: false, reason: `translation-status.json does not cover the 65/2915 snapshot (${summary})` };
	}
	if (status.status !== "complete" || status.developmentOnlyEnglishFallback !== false) {
		return { publish: false, reason: `translation-status.json is incomplete (${summary})` };
	}
	if (totals.translated !== LOCALE_REQUIREMENTS.keys || totals.fallback !== LOCALE_REQUIREMENTS.fallback) {
		return { publish: false, reason: `translation-status.json is incomplete (${summary})` };
	}
	return { publish: true, reason: summary };
}

/** The predictable tarball name for a package manifest. */
export function tarballName(manifest) {
	return `${manifest.name}-${manifest.version}.tgz`;
}

function packDirectory(directory, manifest, destination) {
	execFileSync("npm", ["pack", "--pack-destination", destination], { cwd: directory, stdio: "pipe" });
	const file = tarballName(manifest);
	console.log(`packed ${file}`);
	return { directory, name: manifest.name, version: manifest.version, file, alias: null };
}

function main() {
	const staging = mkdtempSync(join(root, ".dsh-pack-"));
	const originalDocs = new Map();
	let published = false;
	let cleanStaging = true;
	try {

		// The repository root is the published package; packages/dsh-mobile-maxxing/ is the
		// implementation and ships inside it. The locale package is deliberately NOT
		// in the root files list: one tarball must not silently change every client.
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const mobile = {
			directory: root,
			name: manifest.name,
			version: manifest.version,
			file: tarballName(manifest),
			alias: `${manifest.name}.tgz`,
		};

		// Rewrite the READMEs BEFORE packing. `npm pack` snapshots the files, so
		// rewriting afterwards ships the previous version's install URL inside the
		// tarball — which is how the 0.3.3 tarball came to point at 0.3.2.
		//
		// Keep the install commands on the version just packed: a version-free install
		// URL is cached by pnpm, so the docs must point at the versioned one.
		const releaseTag = process.env.DSH_RELEASE_TAG ?? `v${mobile.version}`;
		const url = `https://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/${releaseTag}/${mobile.file}`;
		for (const doc of [join(root, "README.md"), join(root, "packages", mobile.name, "README.md")]) {
			let text;
			try {
				text = readFileSync(doc, "utf8");
			} catch {
				continue;
			}
			const updated = text.replace(
				new RegExp(`https://github\\.com/kuraneko1/dsh-mobile-maxxing/releases/download/v[^/]+/${mobile.name}[\\w.\\-]*\\.tgz`, "g"),
				url,
			);
			if (updated !== text) {
				originalDocs.set(doc, text);
				writeFileSync(doc, updated);
				console.log(`updated ${doc.slice(root.length)} -> ${releaseTag}`);
			}
		}

		const packed = [];
		execFileSync("npm", ["pack", "--pack-destination", staging], { cwd: mobile.directory, stdio: "pipe" });
		// A second copy under a version-free name, so documentation can link
		// `releases/latest/download/dsh-mobile-maxxing.tgz` and keep working across versions.
		copyFileSync(join(staging, mobile.file), join(staging, mobile.alias));
		console.log(`packed ${mobile.file} (+ ${mobile.alias})`);
		packed.push(mobile);

		const markdownDir = join(root, "packages", "dsh-md-rendering");
		const markdownManifest = JSON.parse(readFileSync(join(markdownDir, "package.json"), "utf8"));
		packed.push(packDirectory(markdownDir, markdownManifest, staging));

		let localeStatus;
		try {
			localeStatus = JSON.parse(readFileSync(localeStatusFile, "utf8"));
		} catch {
			localeStatus = null;
		}
		const decision = localePublishDecision(localeStatus);
		if (decision.publish) {
			let stale = false;
			try {
				// Never ship a tarball whose generated client disagrees with the
				// dictionaries that produced this status.
				execFileSync("node", [join(root, "tools", "build-client.mjs"), "--check"], { cwd: root, stdio: "pipe" });
			} catch {
				stale = true;
			}
			if (stale) {
				console.log(`\nREFUSED: dsh-locale-ja generated files are stale; no locale tarball was produced.`);
				console.log("  Run node tools/build-client.mjs, review the diff, then retry.");
				if (process.argv.includes("--require-locale")) process.exitCode = 1;
			} else {
				const localeManifest = JSON.parse(readFileSync(join(localeDir, "package.json"), "utf8"));
				packed.push(packDirectory(localeDir, localeManifest, staging));
			}
		} else {
			console.log(`\nREFUSED: not packing dsh-locale-ja — ${decision.reason}.`);
			console.log("  Only a complete 65-namespace / 2915-key ja catalog with zero English");
			console.log("  fallback may be published. No English fallback pack was produced.");
			if (process.argv.includes("--require-locale")) process.exitCode = 1;
		}

		if (packed.length < 3 && existsSync(dist) && readdirSync(dist).some((file) => /^dsh-locale-ja-.*\.tgz$/.test(file))) {
			console.log("Existing locale artifacts in dist/ were preserved; remove or archive them before packing an incomplete locale.");
			process.exitCode = 1;
		}
		if (process.exitCode) {
			console.log("Existing dist/ artifacts were left unchanged.");
			return;
		}
		mkdirSync(dist, { recursive: true });
		const files = packed.flatMap((item) => [item.file, item.alias].filter(Boolean));
		const targets = files.map((file, index) => {
			if (basename(file) !== file) throw new Error(`Invalid output filename: ${file}`);
			const target = join(dist, file);
			let stat;
			try { stat = lstatSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
			if (stat && !stat.isFile()) throw new Error(`Refusing to replace a non-file: ${target}`);
			return { target, source: join(staging, file), backup: join(staging, `backup-${index}`), existed: !!stat, installed: false };
		});
		const touched = [];
		try {
			for (const item of targets) {
				if (item.existed) renameSync(item.target, item.backup);
				touched.push(item);
				renameSync(item.source, item.target);
				item.installed = true;
			}
		} catch (error) {
			try {
				for (const item of touched.reverse()) {
					if (item.installed) renameSync(item.target, item.source);
					if (item.existed) renameSync(item.backup, item.target);
				}
			} catch (rollbackError) {
				cleanStaging = false;
				throw new Error(`Failed to restore prior artifacts; backups remain in ${staging}`, { cause: rollbackError });
			}
			throw error;
		}
		published = true;
		console.log(`\n${packed.length} tarball${packed.length === 1 ? "" : "s"} in dist/`);
		for (const item of packed) console.log(`  ${item.file}${item.alias === null ? "" : `  /  ${item.alias}`}`);
	} finally {
		if (!published) for (const [doc, text] of originalDocs) writeFileSync(doc, text);
		if (cleanStaging) rmSync(staging, { recursive: true, force: true });
	}
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) main();
