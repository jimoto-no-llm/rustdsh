/**
 * CJK-friendly literal autolinks for the DSH Web markdown renderer.
 *
 * GFM ends a literal autolink at whitespace or `<`, so a URL butted against
 * CJK prose swallows it: `**https://x**（private）` links to
 * `https://x**（private）`, the closing `**` never closes the bold, and the
 * href is wrong. GitHub's GFM does the same, so no amount of prompt
 * engineering fixes it for Japanese prose.
 *
 * The renderer ships prebuilt: micromark and its GFM extension live in the
 * frontend's `assets/vendor-*.js`, and the client bundle is frozen, so a
 * client-side plugin cannot reach the parser. This module patches that one
 * chunk **at serve time** and serves the result from a versioned path, which
 * also solves two problems an on-disk patch has:
 *
 *   - an in-place edit keeps the content-hashed filename, so browsers and the
 *     service worker may keep serving the old bytes;
 *   - a DSH upgrade replaces the chunk (new hash) and silently drops the fix.
 *
 * Here the patch is recomputed from whatever the installed frontend contains
 * on every composition, and the served URLs carry this module's version, so a
 * new build or a new patch version is a new URL and never a stale cache.
 *
 * The rule (a deliberate deviation, in the spirit of the renderer's own
 * `cjkFriendlyStrong`):
 *   - CJK punctuation (、。，（）「」【】！？：；・…) ends a path, so
 *     `https://x（private）` links to `https://x`;
 *   - CJK prose (that punctuation, kana, ideographs, Hangul, Bopomofo) ends a
 *     trailing-punctuation run, so `**https://x**です` closes the bold.
 * CJK *letters* never end a path, so `https://ja.wikipedia.org/wiki/日本`
 * stays one URL.
 *
 * @module rdsh-markdown-cjk/markdown
 */

/** Versioned public prefix for the patched chunks; bump with the patch. */
export const MARKDOWN_FIX_PATH = "/markdown-cjk/v1";

/** Marker proving a vendor chunk already carries the serve-time patch. */
const MARKER = "/* __DSH_CJK_AUTOLINK_FIX_V1__ */";

/** Path tokenizer: `function X(e,t){let n=0,r=0;return S;function S(C){return C===40?...` */
const PATH_RE = /function (\w+)\((\w+),(\w+)\)\{let \w+=0,\w+=0;return \w+;function \w+\((\w+)\)\{return \4===40\?/;
/** Trail tokenizer: `function X(e,t,n){return r;function r(o){return o===33||...` */
const TRAIL_RE = /function (\w+)\(\w+,\w+,\w+\)\{return (\w+);function \2\((\w+)\)\{return \3===33\|\|/;

/** CJK punctuation, U+3001–U+FF65 range pieces used by both rules. */
const CJK_PUNCT = "[\\u3001-\\u3003\\u3008-\\u3011\\u3014-\\u301f\\u3030\\u303d\\u30fb\\ufe10-\\ufe19\\ufe30-\\ufe4f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65\\u2026]";
/** That punctuation plus kana, Han, compat ideographs, Bopomofo and Hangul. */
const CJK_PROSE = "[\\u3001-\\u3003\\u3008-\\u3011\\u3014-\\u301f\\u3030\\u303d\\u30fb\\ufe10-\\ufe19\\ufe30-\\ufe4f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65\\u2026\\u3040-\\u30ff\\u3100-\\u312f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af]";

/**
 * Add the CJK terminators to one vendor chunk.
 *
 * Returns `null` when the upstream chunk no longer has the expected tokenizer
 * shape, so the caller can serve the original and keep the app working.
 *
 * @param {string} source - the built vendor chunk.
 * @returns {string | null} the patched chunk, or `null` when the patch does not apply.
 */
export function patchMarkdownVendor(source) {
	if (typeof source !== "string" || source === "") return null;
	if (source.includes(MARKER)) return source;

	const pathMatch = PATH_RE.exec(source);
	const trailMatch = TRAIL_RE.exec(source);
	if (pathMatch === null || trailMatch === null) return null;

	const pathOk = pathMatch[3];
	const pathCode = pathMatch[4];
	const trailCode = trailMatch[3];

	const pathBody = `return ${pathCode}===40?`;
	const trailOld = `${trailCode}===60||${trailCode}===null||fe(${trailCode})||pn(${trailCode})?`;
	if (source.split(pathBody).length - 1 !== 1) return null;
	if (source.split(trailOld).length - 1 !== 1) return null;

	const pathInsert = `${pathCode}>127&&/${CJK_PUNCT}/.test(String.fromCodePoint(${pathCode}))?${pathOk}(${pathCode}):`;
	const trailNew = `${trailCode}===60||${trailCode}===null||fe(${trailCode})||pn(${trailCode})||${trailCode}>127&&/${CJK_PROSE}/.test(String.fromCodePoint(${trailCode}))?`;

	return `${MARKER}\n${source
		.replace(pathBody, `return ${pathInsert}${pathCode}===40?`)
		.replace(trailOld, trailNew)}`;
}

/**
 * Point one built index chunk at the serve-time vendor chunk.
 *
 * The chunk imports its vendor sibling by relative specifier; the patched
 * vendor lives under {@link MARKDOWN_FIX_PATH}, so the specifier becomes
 * absolute.
 *
 * @param {string} source - the built index chunk.
 * @param {string} vendorAsset - the vendor chunk file name (`vendor-<hash>.js`).
 * @returns {string | null} the rewritten chunk, or `null` when the import is absent.
 */
export function rewriteIndexChunk(source, vendorAsset) {
	if (typeof source !== "string" || source === "") return null;
	// The chunk also lists the vendor chunk in its lazily-mapped dependency
	// table, so anchor on the import clause itself rather than the file name.
	const clause = `from"./vendor-${vendorAsset.replace(/^vendor-/, "")}"`;
	if (source.split(clause).length - 1 !== 1) return null;
	return source.replace(clause, `from"${MARKDOWN_FIX_PATH}/${vendorAsset}"`);
}

/**
 * Point the served document at the serve-time chunks.
 *
 * The filenames are content-hashed and unique, so replacing the bare names
 * covers both the module script and the modulepreload link whatever their
 * relative prefix is.
 *
 * @param {string} html - the rendered index document.
 * @param {string} indexAsset - the index chunk file name.
 * @param {string} vendorAsset - the vendor chunk file name.
 * @returns {string} the rewritten document.
 */
export function rewriteIndexHtml(html, indexAsset, vendorAsset) {
	if (typeof html !== "string" || html === "") return html;
	// Relative (`./assets/x.js`) and absolute (`/assets/x.js`) forms both occur;
	// replacing the longer form first keeps the shorter rule from matching the
	// text it just inserted.
	return html
		.replaceAll(`./assets/${indexAsset}`, `${MARKDOWN_FIX_PATH}/${indexAsset}`)
		.replaceAll(`/assets/${indexAsset}`, `${MARKDOWN_FIX_PATH}/${indexAsset}`)
		.replaceAll(`./assets/${vendorAsset}`, `${MARKDOWN_FIX_PATH}/${vendorAsset}`)
		.replaceAll(`/assets/${vendorAsset}`, `${MARKDOWN_FIX_PATH}/${vendorAsset}`);
}
