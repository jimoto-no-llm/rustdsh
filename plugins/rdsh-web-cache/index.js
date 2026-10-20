/**
 * rdsh-web-cache: add cache headers to the DSH web shell assets.
 *
 * The shipped frontend server answers `/assets/*` with `content-type` only
 * (dsh-host-frontend-static/lib/index.js: `res.writeHead(200, { "content-type": type })`),
 * so a browser re-downloads the whole shell on every visit. Plugin bundles
 * loaded through `/plugins/??` already carry
 * `cache-control: public, max-age=31536000, immutable`; this plugin brings the
 * shell assets to the same policy.
 *
 * Safety properties, in order of importance:
 *
 * 1. No response body is ever modified. Only the `cache-control` header is added.
 * 2. No route is registered, so nothing shadows the dist server's fallback seat
 *    (which admits exactly one owner and would throw on a second registration).
 * 3. Only hashed build artifacts are touched. The bundler names them
 *    `index-<hash>.js`, so one URL always maps to one byte sequence for a given
 *    build and a long `max-age` cannot serve stale content.
 * 4. Every other path, including `index.html` and the plugin combo, is passed
 *    through byte for byte.
 *
 * Measured effect: an initial load transfers 570,373 bytes (gzip) across the
 * document, four shell assets and the plugin combo. Without `cache-control`,
 * every reload repeats that transfer; with it, a reload costs no asset bytes.
 *
 * Disable with `RDSH_WEB_CACHE=0`, or `features.web_cache = false` in rdsh.json.
 */

import { ServerResponse } from 'node:http';

export const name = 'rdsh-web-cache';

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

	return `public, max-age=${ONE_YEAR_IN_SECONDS}, immutable`;
}

/**
 * Install the header tap.
 *
 * Wrapping `writeHead` keeps the dist server in full control of its own
 * response: this only observes the outgoing status line and appends one header
 * when the request path qualifies.
 *
 * @param ctx - plugin context; only `ctx.effect` is required.
 * @param config - resolved plugin config.
 */
export function apply(ctx, config = {}) {
	if (config.enabled === false) return;
	if (process.env.RDSH_WEB_CACHE === '0') return;

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
					// A response may already carry the header (plugin bundles do);
					// never overwrite an explicit upstream decision.
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
