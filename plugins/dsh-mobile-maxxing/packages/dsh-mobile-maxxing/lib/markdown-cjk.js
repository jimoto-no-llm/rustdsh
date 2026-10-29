/**
 * rdsh-markdown-cjk — CJK-friendly links for the DSH Web renderer.
 *
 * GFM ends a literal autolink at whitespace or `<` only, so a URL butted
 * against Japanese prose swallows it: `**https://x**（private）` links to
 * `https://x**（private）` and the bold never closes. GitHub renders it the
 * same way, so this is a deliberate deviation, not a bug report.
 *
 * The renderer ships prebuilt inside `@deepseek-ai/dsh-web-frontend`, and the
 * client bundle is frozen, so a client-side plugin cannot reach the parser.
 * This host half patches the installed vendor chunk in memory and serves the
 * patched copy from a versioned path:
 *
 *   - a new patch version means a new URL, so browsers and the service worker
 *     cannot keep stale bytes;
 *   - a DSH upgrade replaces the chunk and changes its hash, and the patch is
 *     recomputed from whatever is installed at start-up;
 *   - a chunk whose shape no longer matches is served untouched (stock
 *     rendering, one warning in the log), never a broken page.
 *
 * @module rdsh-markdown-cjk
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
	MARKDOWN_FIX_PATH,
	patchMarkdownVendor,
	rewriteIndexChunk,
	rewriteIndexHtml,
} from './markdown-cjk-runtime.js';


/** Routes need `webServer`; mount lazily so headless profiles stay clean. */
export const inject = [];

/**
 * Whether this deployment asked to keep stock rendering.
 * @returns {boolean} true when the plugin must stay inert.
 */
function disabled(config) {
	if (config !== null && typeof config === 'object' && config.enabled === false) return true;
	const flag = process.env.RDSH_MARKDOWN_CJK;
	return flag === '0' || flag === 'off' || flag === 'false';
}

/**
 * Locate the installed frontend dist through the DSH entry this process runs.
 * The plugin is linked outside the DSH install, so the frontend package is
 * resolved from the DSH binary rather than from this package's own modules.
 * @returns {string | null} the dist directory, or `null` when unresolvable.
 */
function frontendDist() {
	const anchor = process.env.DSH_ORIG_BIN ?? process.argv[1] ?? import.meta.url;
	try {
		return join(dirname(createRequire(anchor).resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist');
	} catch {
		return null;
	}
}

/** Read the chunk names the installed index document references. */
function readChunks(dist) {
	const assets = readdirSync(join(dist, 'assets'));
	const indexAsset = assets.find((asset) => /^index-[\w-]+\.js$/.test(asset));
	const vendorAsset = assets.find((asset) => /^vendor-[\w-]+\.js$/.test(asset));
	if (indexAsset === undefined || vendorAsset === undefined) return null;
	return {
		indexAsset,
		vendorAsset,
		indexSource: readFileSync(join(dist, 'assets', indexAsset), 'utf8'),
		vendorSource: readFileSync(join(dist, 'assets', vendorAsset), 'utf8'),
	};
}

/**
 * Serve the patched renderer and point the document at it.
 * @param {object} webServer - the Web server service.
 * @returns {() => void} disposer for the routes and the index rewrite.
 */
function mount(webServer) {
	const dist = frontendDist();
	if (dist === null) {
		console.error('[rdsh-markdown-cjk] frontend dist not found; stock rendering stays');
		return () => {};
	}

	let chunks;
	try {
		chunks = readChunks(dist);
	} catch (error) {
		console.error(`[rdsh-markdown-cjk] cannot read the frontend dist: ${String(error)}`);
		return () => {};
	}
	if (chunks === null) {
		console.error('[rdsh-markdown-cjk] no index/vendor chunk in the frontend dist; stock rendering stays');
		return () => {};
	}

	const patchedVendor = patchMarkdownVendor(chunks.vendorSource);
	const patchedIndex = patchedVendor === null ? null : rewriteIndexChunk(chunks.indexSource, chunks.vendorAsset);
	if (patchedVendor === null || patchedIndex === null) {
		console.error('[rdsh-markdown-cjk] vendor chunk shape changed; serving the stock renderer');
		return () => {};
	}

	const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' };
	const respondJs = (body) => (req, res) => {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
			res.end('method not allowed\n');
			return;
		}
		res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(body) });
		if (req.method === 'HEAD') res.end();
		else res.end(body);
	};

	const disposes = [
		webServer.register({
			kind: 'exact',
			path: `${MARKDOWN_FIX_PATH}/${chunks.vendorAsset}`,
			handler: respondJs(patchedVendor),
		}),
		webServer.register({
			kind: 'exact',
			path: `${MARKDOWN_FIX_PATH}/${chunks.indexAsset}`,
			handler: respondJs(patchedIndex),
		}),
		webServer.tapIndex((html) => rewriteIndexHtml(html, chunks.indexAsset, chunks.vendorAsset)),
	];
	return () => {
		for (const dispose of disposes) if (typeof dispose === 'function') dispose();
	};
}

/**
 * Mount the serve-time patch, unless this deployment opted out.
 * @param {object} ctx - plugin context.
 * @param {object} [config] - profile config for this plugin.
 */
export function apply(ctx, config) {
	if (disabled(config)) return;
	ctx.inject(['webServer'], (webCtx) => mount(webCtx.webServer));
}
