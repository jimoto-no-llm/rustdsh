/**
 * rdsh-web-cache: serve precompressed web-shell assets and add cache headers.
 *
 * Two behaviours, both fail-safe and both opt-out:
 *
 * 1. Header tap (always installed): the shipped frontend server answers
 *    `/assets/*` with `content-type` only
 *    (dsh-host-frontend-static/lib/index.js: `res.writeHead(200, { "content-type": type })`),
 *    so a browser re-downloads the whole shell on every visit. Plugin bundles
 *    loaded through `/plugins/??` already carry
 *    `cache-control: public, max-age=31536000, immutable`; the tap brings
 *    the shell assets to the same policy without touching any response body.
 *
 * 2. Precompressed route (only when `RDSH_WEB_ASSETS` names a valid cache
 *    directory): rdsh compresses the shell once at start-up and writes
 *    `manifest.json` next to `<asset>.br` / `<asset>.gz` products
 *    (docs/webui-asset-cache.md). The plugin claims the `/assets` prefix
 *    route and serves the representation the browser asked for
 *    (`br` > `gzip` > `identity`) with the manifest ETag and 304
 *    handling. Node never compresses: it only reads bytes another process
 *    already produced.
 *
 * Safety properties, in order of importance:
 *
 * 1. Nothing is registered unless the cache directory holds a well-formed
 *    manifest. No env var, unreadable or invalid manifest = the previous
 *    header-only behaviour, exactly.
 * 2. The route only answers paths it can resolve inside the cache/source tree:
 *    empty paths, `..` segments, absolute paths, encoded traversal and
 *    malformed percent-encoding are all 404.
 * 3. A file absent from the manifest but present under the manifest's
 *    `source` directory is still served as identity bytes, so a stale or
 *    partial manifest can only lose compression, never a working shell.
 * 4. Read failures are 404, the same answer the dist server gives.
 * 5. Non-GET/HEAD is 405, and HEAD never writes a body.
 *
 * Disable the whole plugin with `RDSH_WEB_CACHE=0` or
 * `config.enabled: false`; without `RDSH_WEB_ASSETS` only the header
 * tap is installed.
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ServerResponse } from 'node:http';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const name = 'rdsh-web-cache';

/** Prefix route that owns every `/assets` request once enabled. */
export const ASSET_ROUTE_PATH = '/assets';

/** The only cache policy this plugin ever attaches to shell assets. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

const MANIFEST_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** content-type table from contract section 5 (mirrors the dist server). */
const CONTENT_TYPE_BY_EXTENSION = new Map([
	['.js', 'text/javascript; charset=utf-8'],
	['.css', 'text/css; charset=utf-8'],
	['.svg', 'image/svg+xml'],
	['.json', 'application/json'],
	['.map', 'application/json'],
	['.webmanifest', 'application/manifest+json'],
	['.html', 'text/html; charset=utf-8'],
	['.woff2', 'font/woff2'],
	['.woff', 'font/woff'],
	['.png', 'image/png'],
	['.ico', 'image/x-icon'],
]);

/** Extensions whose build output is content-hashed and therefore immutable. */
const IMMUTABLE_EXTENSIONS = new Set([
	'.js', '.mjs', '.css', '.woff2', '.woff', '.svg', '.png', '.webp', '.avif', '.ico',
]);

/**
 * A build artifact carries a short content hash before its extension, for
 * example `index-CN7NIWNw.js` or `vendor-DcuzkuQH.js`.
 */
const CONTENT_HASHED = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

const ONE_YEAR_IN_SECONDS = 31536000;

/** Encoding suffixes as rdsh writes them next to the cache manifest. */
const ENCODING_SUFFIX = Object.freeze({ br: '.br', gzip: '.gz' });

/** Representation preference order from contract section 5.4. */
const ENCODING_PREFERENCE = ['br', 'gzip'];

// ---------------------------------------------------------------------------
// Part 1: cache-control header tap for asset responses served by the dist
// server (unchanged behaviour for every deployment without RDSH_WEB_ASSETS).
// ---------------------------------------------------------------------------

/**
 * Decide the cache policy for one request path.
 *
 * Pure, so the policy can be unit-tested without starting a server.
 *
 * @param pathname - decoded request pathname.
 * @returns the `cache-control` value, or `undefined` to leave the response alone.
 */
export function cacheControlFor(pathname) {
	if (typeof pathname !== 'string' || pathname.length === 0) return undefined;
	if (!pathname.startsWith('/assets/')) return undefined;

	const file = pathname.slice(pathname.lastIndexOf('/') + 1);
	const dot = file.lastIndexOf('.');
	if (dot <= 0) return undefined;

	const extension = file.slice(dot).toLowerCase();
	if (!IMMUTABLE_EXTENSIONS.has(extension)) return undefined;

	// A source map is a debugging artifact rather than a load dependency, but it
	// is still content-addressed, so it takes the same policy.
	const stem = file.slice(0, dot);
	if (!CONTENT_HASHED.test(file) && !stem.endsWith('.map')) return undefined;

	return IMMUTABLE;
}

/**
 * Install the header tap.
 *
 * Wrapping `writeHead` keeps the dist server in full control of its own
 * response: this only observes the outgoing status line and appends one header
 * when the request path qualifies. A response that already carries a
 * `cache-control` header (the precompressed route sets its own) is never
 * touched, so the two halves of this plugin compose without double headers.
 *
 * @param ctx - plugin context; only `ctx.effect` is required.
 */
function installHeaderTap(ctx) {
	if (typeof ctx.effect !== 'function') return;

	ctx.effect(() => {
		const original = descriptorWriteHead();
		if (original === undefined) return;
		ctx.logger?.info?.('rdsh-web-cache: immutable headers enabled for hashed shell assets');

		Object.defineProperty(proto(), 'writeHead', {
			configurable: true,
			writable: true,
			value: function writeHeadWithCacheHeaders(...args) {
				const self = this;
				try {
					// A response may already carry the header (the asset route or the
					// plugin bundles do); never overwrite an explicit upstream decision.
					if (!self.headersSent && self.getHeader('cache-control') === undefined) {
						const value = cacheControlFor(requestPathnameOf(self));
						if (value !== undefined) self.setHeader('cache-control', value);
					}
				} catch {
					// Header injection must never break a response.
				}
				return original.apply(self, args);
			},
		});

		return () => {
			Object.defineProperty(proto(), 'writeHead', {
				configurable: true,
				writable: true,
				value: original,
			});
		};
	});
}

/** @returns the ServerResponse prototype the dist server writes through. */
function proto() {
	return ServerResponse.prototype;
}

/** @returns the untouched `writeHead` implementation. */
function descriptorWriteHead() {
	return Object.getOwnPropertyDescriptor(proto(), 'writeHead')?.value;
}

/**
 * Recover the request pathname for a response.
 *
 * Node keeps the request reachable from the response it is answering, so the
 * tap needs no access to the handler's own arguments.
 *
 * @param res - the response being written.
 * @returns the pathname, or an empty string when it cannot be determined.
 */
function requestPathnameOf(res) {
	try {
		const url = res.req?.url ?? '';
		return url.split('?')[0];
	} catch {
		return '';
	}
}

// ---------------------------------------------------------------------------
// Part 2: manifest loading and validation (contract sections 3 and 6).
// ---------------------------------------------------------------------------

/**
 * Read and validate `<cacheDirectory>/manifest.json`.
 *
 * Every failure path returns `undefined`: a cache that cannot be trusted
 * must leave the deployment on the dist server rather than shadow it with
 * half-valid data.
 *
 * @param cacheDirectory - absolute cache directory (`RDSH_WEB_ASSETS`).
 * @returns the frozen manifest, or `undefined` when missing or invalid.
 */
export function loadManifest(cacheDirectory) {
	if (typeof cacheDirectory !== 'string' || cacheDirectory.trim().length === 0) return undefined;

	let text;
	try {
		text = readFileSync(join(cacheDirectory, MANIFEST_NAME), 'utf8');
	} catch {
		return undefined;
	}

	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	return normalizeManifest(raw);
}

/**
 * Validate one parsed manifest object (contract section 3).
 *
 * @param raw - parsed JSON value.
 * @returns frozen `{ source, assets }`, or `undefined` when any field is wrong.
 */
export function normalizeManifest(raw) {
	if (!isRecord(raw)) return undefined;
	if (raw.version !== MANIFEST_VERSION) return undefined;
	if (typeof raw.source !== 'string' || raw.source.length === 0 || !isAbsolute(raw.source)) {
		return undefined;
	}
	if (!isRecord(raw.assets)) return undefined;

	const assets = new Map();
	for (const [assetPath, entry] of Object.entries(raw.assets)) {
		if (!isSafeRelativePath(assetPath)) return undefined;
		if (!isRecord(entry)) return undefined;
		if (!isByteSize(entry.identity)) return undefined;
		if (entry.br !== null && !isByteSize(entry.br)) return undefined;
		if (entry.gzip !== null && !isByteSize(entry.gzip)) return undefined;
		if (typeof entry.etag !== 'string' || entry.etag.length === 0) return undefined;

		assets.set(assetPath, Object.freeze({
			identity: entry.identity,
			br: entry.br,
			gzip: entry.gzip,
			etag: entry.etag,
		}));
	}

	return Object.freeze({ version: MANIFEST_VERSION, source: resolve(raw.source), assets });
}

/** @returns true for a plain JSON object (not null, not an array). */
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @returns true for a non-negative safe integer byte count. */
function isByteSize(value) {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A manifest key must be a clean, `/`-separated relative path.
 *
 * Rejecting separators and dot segments here means every manifest lookup is
 * safe by construction; the same predicate guards decoded request paths.
 *
 * @param relativePath - candidate path.
 * @returns true when the path cannot escape a root directory.
 */
export function isSafeRelativePath(relativePath) {
	if (typeof relativePath !== 'string' || relativePath.length === 0) return false;
	if (relativePath.includes('\0') || relativePath.includes('\\')) return false;
	if (relativePath.startsWith('/')) return false;
	return relativePath.split('/').every(
		(segment) => segment !== '' && segment !== '.' && segment !== '..',
	);
}

/** @returns true when `target` resolves strictly inside `root`. */
function isInside(root, target) {
	const offset = relative(root, target);
	return offset.length > 0 && !offset.startsWith('..') && !isAbsolute(offset);
}

// ---------------------------------------------------------------------------
// Part 3: content negotiation and response metadata.
// ---------------------------------------------------------------------------

/**
 * The content-type for one asset path, from the contract's table.
 *
 * @param relativePath - manifest key or request path relative to /assets.
 * @returns the header value; unknown extensions use `application/octet-stream`.
 */
export function contentTypeFor(relativePath) {
	const dot = relativePath.lastIndexOf('.');
	if (dot === -1) return DEFAULT_CONTENT_TYPE;
	return CONTENT_TYPE_BY_EXTENSION.get(relativePath.slice(dot).toLowerCase()) ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Parse an `Accept-Encoding` value into coding -> q.
 *
 * q defaults to 1 and is clamped to [0, 1]; invalid parameters fall back to 1.
 * The `*` wildcard is recorded but intentionally never used for selection
 * (contract section 5.4).
 *
 * @param header - raw header value.
 * @returns map of lowercased coding to q.
 */
export function parseAcceptEncoding(header) {
	const qualities = new Map();
	if (typeof header !== 'string') return qualities;
	for (const part of header.split(',')) {
		const [coding, ...parameters] = part.trim().toLowerCase().split(';');
		const token = coding?.trim() ?? '';
		if (token.length === 0) continue;

		let quality = 1;
		for (const parameter of parameters) {
			const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(parameter);
			if (match === null) continue;
			const parsed = Number.parseFloat(match[1]);
			if (Number.isFinite(parsed)) quality = Math.min(1, Math.max(0, parsed));
		}
		qualities.set(token, Math.max(qualities.get(token) ?? 0, quality));
	}
	return qualities;
}

/**
 * Pick the representation for one manifest entry (contract section 5.4).
 *
 * Preference is `br` then `gzip` then `identity`, independently of q
 * ordering; q only removes a coding (q=0). An explicitly listed coding wins
 * over an unlisted one, so a client that sends just `gzip` gets gzip rather
 * than an encoding it never advertised. When the client rejects `br` alone
 * (`br;q=0`) but does not mention `gzip`, gzip is used: the rejection is
 * the only q=0 information in the header, and identity would waste the cached
 * variant the client never refused. A missing header, or a header that leaves
 * no usable coding, falls back to identity rather than 406: the worst outcome
 * is a lost optimization.
 *
 * @param header - raw `Accept-Encoding` value.
 * @param entry - one manifest asset entry.
 * @returns `'br'`, `'gzip'` or `'identity'`.
 */
export function selectEncoding(header, entry) {
	if (typeof header !== 'string' || header.trim().length === 0) return 'identity';

	const qualities = parseAcceptEncoding(header);
	const available = (encoding) =>
		encoding === 'br' ? entry.br !== null : entry.gzip !== null;

	for (const encoding of ENCODING_PREFERENCE) {
		const quality = qualities.get(encoding);
		if (quality !== undefined && quality > 0 && available(encoding)) return encoding;
	}

	// Contract section 5.4 excludes q=0 codings; when the client rejected br
	// only, gzip is neither rejected nor mentioned and is the next preference.
	if (qualities.get('br') === 0 && !qualities.has('gzip') && available('gzip')) {
		return 'gzip';
	}
	return 'identity';
}

/**
 * Whether an `If-None-Match` value names the given ETag.
 *
 * Handles lists, the `*` wildcard and weak comparison (`W/`) so a proxy
 * that normalizes the tag still revalidates instead of re-sending the body.
 *
 * @param header - raw `If-None-Match` value.
 * @param etag - manifest ETag.
 * @returns true for a match.
 */
export function etagMatches(header, etag) {
	const values = Array.isArray(header) ? header.join(',') : header;
	if (typeof values !== 'string' || values.length === 0) return false;

	for (const candidate of values.split(',')) {
		const tag = candidate.trim();
		if (tag === '*') return true;
		if (tag === etag) return true;
		if (tag.startsWith('W/') && tag.slice(2) === etag) return true;
		if (etag.startsWith('W/') && tag === etag.slice(2)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Part 4: the /assets request handler (contract section 5).
// ---------------------------------------------------------------------------

/**
 * Resolve a request pathname to a manifest key.
 *
 * The webserver matches on `new URL(...).pathname`, which leaves
 * percent-encoding in place; decode exactly once and then apply the same safe
 * relative-path predicate as manifest keys.
 *
 * @param pathname - URL pathname of the request.
 * @returns the path relative to `/assets/`, or `undefined` when unsafe/empty.
 */
export function relativeAssetPath(pathname) {
	if (typeof pathname !== 'string' || pathname.length === 0) return undefined;

	let decoded;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return undefined;
	}

	const prefix = `${ASSET_ROUTE_PATH}/`;
	if (!decoded.startsWith(prefix)) return undefined;

	const relativePath = decoded.slice(prefix.length);
	return isSafeRelativePath(relativePath) ? relativePath : undefined;
}

/**
 * Build the `/assets` prefix-route handler for one manifest.
 *
 * @param manifest - validated manifest from {@link loadManifest}.
 * @param cacheDirectory - absolute directory holding `manifest.json` and the
 *   `.br` / `.gz` products.
 * @returns an async node:http handler; it owns the full response lifecycle.
 */
export function createAssetHandler(manifest, cacheDirectory) {
	const sourceRoot = manifest.source;
	const cacheRoot = resolve(cacheDirectory);

	return async function serveAssetRoute(req, res) {
		try {
			if (req.method !== 'GET' && req.method !== 'HEAD') {
				res.setHeader('allow', 'GET, HEAD');
				res.writeHead(405);
				res.end();
				return;
			}

			const pathname = requestPathname(req);
			const relativePath = pathname === undefined ? undefined : relativeAssetPath(pathname);
			if (relativePath === undefined) {
				respondNotFound(res);
				return;
			}

			const entry = manifest.assets.get(relativePath);
			if (entry !== undefined) {
				await serveManifestEntry(req, res, entry, relativePath, sourceRoot, cacheRoot);
				return;
			}

			await serveSourceFile(req, res, relativePath, sourceRoot);
		} catch {
			// The route owns the response; an unexpected error must still answer.
			if (res.headersSent) res.destroy();
			else respondNotFound(res);
		}
	};
}

/**
 * Serve one manifest entry with the negotiated representation.
 *
 * @param req - request (method, `if-none-match`, `accept-encoding`).
 * @param res - response to write.
 * @param entry - manifest asset entry.
 * @param relativePath - manifest key.
 * @param sourceRoot - directory holding identity bytes.
 * @param cacheRoot - directory holding compressed products.
 */
async function serveManifestEntry(req, res, entry, relativePath, sourceRoot, cacheRoot) {
	const encoding = selectEncoding(req.headers['accept-encoding'], entry);
	const negotiable = entry.br !== null || entry.gzip !== null;

	const headers = {
		'content-type': contentTypeFor(relativePath),
		'cache-control': IMMUTABLE,
		etag: entry.etag,
	};
	if (encoding !== 'identity') headers['content-encoding'] = encoding;
	if (negotiable) headers.vary = 'accept-encoding';

	// Contract section 5.6: a matching validator ends the exchange here, so the
	// cached body is never read. The headers describe the selected
	// representation so a cache can refresh its stored metadata.
	if (etagMatches(req.headers['if-none-match'], entry.etag)) {
		sendResponse(res, 304, headers);
		return;
	}

	const body = await readRepresentation(encoding, relativePath, sourceRoot, cacheRoot);
	if (body === undefined) {
		// Contract section 6: an unreadable file answers exactly like the dist
		// server's miss (404), never a 500.
		respondNotFound(res);
		return;
	}

	headers['content-length'] = String(body.length);
	sendResponse(res, 200, headers, req.method === 'HEAD' ? undefined : body);
}

/**
 * Read the bytes for one already-validated representation.
 *
 * @param encoding - `'br'`, `'gzip'` or `'identity'`.
 * @param relativePath - manifest key.
 * @param sourceRoot - directory holding identity bytes.
 * @param cacheRoot - directory holding compressed products.
 * @returns the bytes, or `undefined` when the file cannot be read.
 */
async function readRepresentation(encoding, relativePath, sourceRoot, cacheRoot) {
	if (encoding === 'identity') return readFileBytes(resolve(sourceRoot, relativePath));
	const suffix = ENCODING_SUFFIX[encoding];
	return readFileBytes(resolve(cacheRoot, `${relativePath}${suffix}`));
}

/**
 * Serve a file that exists under `source` but not in the manifest.
 *
 * This is the safety net from contract section 5.3: a manifest that misses a
 * file (symlinks are excluded by the rdsh scanner, a stale cache can lack
 * newly built assets) must still produce a working response, as identity bytes.
 *
 * @param req - request.
 * @param res - response to write.
 * @param relativePath - path relative to /assets.
 * @param sourceRoot - dist assets root from the manifest.
 */
async function serveSourceFile(req, res, relativePath, sourceRoot) {
	const target = resolve(sourceRoot, relativePath);
	if (!isInside(sourceRoot, target)) {
		respondNotFound(res);
		return;
	}

	const body = await readFileBytes(target);
	if (body === undefined) {
		respondNotFound(res);
		return;
	}

	// The headers mirror the optimized path; the file is under the same
	// content-addressed dist tree, and a proxied no-store miss would defeat the
	// header tap installed by this plugin for every other shell asset.
	const headers = {
		'content-type': contentTypeFor(relativePath),
		'cache-control': IMMUTABLE,
		'content-length': String(body.length),
	};
	sendResponse(res, 200, headers, req.method === 'HEAD' ? undefined : body);
}

/**
 * Read a file for serving; every failure becomes a 404-able `undefined`.
 *
 * @param path - absolute file path.
 * @returns file bytes, or `undefined`.
 */
async function readFileBytes(path) {
	try {
		return await readFile(path);
	} catch {
		return undefined;
	}
}

/**
 * Write one complete response.
 *
 * Headers are installed with `setHeader` before `writeHead` so the
 * cache-control tap sees an explicit decision and leaves the response alone:
 * exactly one `cache-control` value, no duplicate header.
 *
 * @param res - response with no headers sent yet.
 * @param status - HTTP status.
 * @param headers - header name -> value.
 * @param body - bytes to send; omitted for HEAD/304.
 */
function sendResponse(res, status, headers, body) {
	for (const [header, value] of Object.entries(headers)) res.setHeader(header, value);
	res.writeHead(status);
	res.end(body);
}

/** @param res - response for a path the route cannot serve. */
function respondNotFound(res) {
	res.writeHead(404);
	res.end();
}

/**
 * The pathname of a request, or `undefined` when the URL is malformed.
 *
 * @param req - node:http request.
 * @returns the pathname component.
 */
function requestPathname(req) {
	try {
		return new URL(req.url ?? '/', 'http://localhost').pathname;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Part 5: activation.
// ---------------------------------------------------------------------------

/**
 * Install both behaviours, each independently guarded.
 *
 * @param ctx - plugin context.
 * @param config - resolved plugin config (`{ enabled?: boolean }`).
 */
export function apply(ctx, config = {}) {
	if (config.enabled === false) return;
	if (process.env.RDSH_WEB_CACHE === '0') return;

	installHeaderTap(ctx);

	const configured = process.env.RDSH_WEB_ASSETS;
	if (typeof configured !== 'string' || configured.trim().length === 0) return;

	const cacheDirectory = resolve(configured.trim());
	const manifest = loadManifest(cacheDirectory);
	if (manifest === undefined) {
		ctx.logger?.warn?.(
			`rdsh-web-cache: ${cacheDirectory}/manifest.json is missing or invalid; not serving precompressed assets`,
		);
		return;
	}

	const route = Object.freeze({
		kind: 'prefix',
		path: ASSET_ROUTE_PATH,
		handler: createAssetHandler(manifest, cacheDirectory),
	});
	if (!registerRoute(ctx, route)) return;

	ctx.logger?.info?.(
		`rdsh-web-cache: serving ${manifest.assets.size} assets from ${cacheDirectory} (br/gzip precompressed)`,
	);
}

/**
 * Register the prefix route through whichever context shape is available.
 *
 * Plugins normally run before the webserver service exists, so the canonical
 * path is `ctx.inject(["webServer"], ...)`; a test or an already-composed
 * context exposes `ctx.webServer` directly. Registration failures (for
 * example a duplicate route) are logged and swallowed: the header tap is still
 * useful and the fallback server still serves the shell.
 *
 * @param ctx - plugin context.
 * @param route - route descriptor handed to `webServer.register`.
 * @returns true when a registration path was installed.
 */
function registerRoute(ctx, route) {
	// The canonical path: a plugin bundle loads before the webserver service is
	// created, and reading ctx.webServer before that throws in cordis. Inject
	// on the service instead; the callback runs as soon as it is available.
	if (typeof ctx.inject === 'function') {
		ctx.inject(['webServer'], (webCtx) => {
			try {
				webCtx.effect(() => webCtx.webServer.register(route), 'rdsh-web-cache: /assets route');
			} catch (error) {
				// A duplicate route or an inactive fiber must not break boot.
				webCtx.logger?.warn?.(error);
			}
		});
		return true;
	}

	// A context that already exposes the service (tests, manual composition).
	try {
		if (
			ctx.webServer !== undefined
			&& typeof ctx.webServer.register === 'function'
			&& typeof ctx.effect === 'function'
		) {
			ctx.effect(() => ctx.webServer.register(route), 'rdsh-web-cache: /assets route');
			return true;
		}
	} catch (error) {
		ctx.logger?.warn?.(error);
	}
	return false;
}
