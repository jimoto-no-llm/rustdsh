/**
 * dsh-mobile-maxxing — the copy dictionary as it is on disk right now.
 *
 * `lib/copy.js` is edited while the host runs: a wording fix has to reach the
 * next page without a restart. The index assemble step is synchronous — the
 * Web server's `tapIndex` takes a pure `(html) => string` — so this module
 * reads the dictionary synchronously and caches it on the file's mtime and
 * size. A save is a cache miss, not a restart. Nothing here touches the
 * service worker: its config is pinned to the bytes the process started with,
 * which is what keeps `sw.js`'s build hash and cache name stable (see
 * `serviceWorkerSource` in `index.js`).
 *
 * @module dsh-mobile-maxxing/copy-source
 */

import { readFileSync, statSync } from "node:fs";
import { COPY, PROBES, copyFor, serviceWorkerCopy } from "./copy.js";

/** The dictionary this package ships. */
export const COPY_FILE = new URL("./copy.js", import.meta.url);

/**
 * The namespace this process started with.
 *
 * The static import above already proved it is a valid dictionary, so it is
 * what a failed read falls back to: a page must never be served without copy,
 * and a half-written file must not become half a document.
 */
const STARTUP = Object.freeze({ COPY, PROBES, copyFor, serviceWorkerCopy });

/** Declaration kinds that can follow `export` in a data module. */
const EXPORTED_DECLARATION = /^(\s*)export\s+(?=(?:async\s+)?(?:const|let|var|function|class)\b)/gm;

/**
 * Turn the data module's source into a namespace without the ESM loader.
 *
 * `lib/copy.js` is a dictionary plus two pure helpers: no imports, no
 * top-level await, no default export. Dropping the `export` keywords
 * therefore leaves a script that defines the same values, which is what makes
 * a synchronous reload possible — `import()` is asynchronous and the index tap
 * cannot await. A file that would need the loader (an import, a re-export, a
 * default export) yields null so the caller keeps the snapshot it has.
 *
 * `new Function` rather than `node:vm` keeps the values in this realm: the
 * browser payload is JSON either way, but tests and `copyFor` expect ordinary
 * objects, not objects from a second realm.
 *
 * @param {string} source - the module file, as text.
 * @returns {{COPY: object, PROBES: object, copyFor: Function, serviceWorkerCopy: Function}|null}
 *   the namespace, or null when the file is not (or no longer) a data module.
 */
function evaluate(source) {
	if (/^\s*import\b/m.test(source)) return null;
	if (/^\s*export\s+(?:default\b|\*)/m.test(source)) return null;
	const script = source.replace(EXPORTED_DECLARATION, "$1");
	let namespace;
	try {
		namespace = new Function(`${script}\n;return { COPY, PROBES, copyFor, serviceWorkerCopy };`)();
	} catch {
		// A syntax error is what a save looks like halfway through. The previous
		// snapshot keeps answering until the next save moves the mtime.
		return null;
	}
	if (typeof namespace?.COPY?.en !== "object") return null;
	if (typeof namespace?.PROBES !== "object") return null;
	if (typeof namespace?.copyFor !== "function") return null;
	return namespace;
}

/**
 * A synchronous, mtime-cached reader for a copy dictionary.
 *
 * @param {object} [options] - injection points for tests; production keeps the
 *   defaults.
 * @param {string|URL} [options.file] - the module to read.
 * @param {Function} [options.read] - replaces `readFileSync`.
 * @param {Function} [options.stat] - replaces `statSync`.
 * @returns {() => {COPY: object, PROBES: object, copyFor: Function, serviceWorkerCopy: Function}}
 *   a reader returning the current namespace.
 */
export function createCopySource({ file = COPY_FILE, read = readFileSync, stat = statSync } = {}) {
	/** "`mtimeMs`:`size`" of the bytes behind `table`; undefined = not read yet. */
	let fingerprint;
	let table = STARTUP;
	return function copyTable() {
		let stats;
		try {
			stats = stat(file);
		} catch {
			// The file vanished mid-run (a packaging change, not a request error):
			// keep answering with the last good table instead of failing the page.
			return table;
		}
		const next = `${stats.mtimeMs}:${stats.size}`;
		if (next === fingerprint) return table;
		// Remember a failed read too: without this, every navigation would pay for
		// re-reading a file whose bytes are already known to be unusable. The next
		// save moves the mtime, which retries.
		fingerprint = next;
		let source;
		try {
			source = read(file, "utf8");
		} catch {
			return table;
		}
		const loaded = evaluate(source);
		if (loaded === null) {
			console.warn(`[dsh-mobile-maxxing] ${String(file)} is not a usable copy dictionary; keeping the previous copy`);
			return table;
		}
		table = loaded;
		return table;
	};
}

/** The process-wide reader used by the index decoration. */
export const copyTable = createCopySource();
