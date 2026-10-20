/**
 * Integration tests for the precompressed /assets route (contract section 5).
 *
 * Every case builds a real cache directory in a tmpdir (manifest.json plus
 * .br/.gz products), installs the plugin into a stub cordis context, and
 * answers over a real node:http server that mirrors the DSH webserver's
 * matching rules (exact routes first, then longest prefix). Requests use
 * node:http instead of fetch so content-encoding bytes reach the test
 * byte-for-byte instead of being auto-decoded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import {
	apply,
	contentTypeFor,
	isSafeRelativePath,
	parseAcceptEncoding,
	relativeAssetPath,
	selectEncoding,
} from '../index.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const ETAG = '"0123456789abcdef"';
const FONT_ETAG = '"fedcba9876543210"';
const JSON_ETAG = '"0011223344556677"';

const APP = Buffer.from('export const answer = 42;\n');
const APP_BR = brotliCompressSync(APP);
const APP_GZIP = gzipSync(APP);
const FONT = Buffer.from('wOF2 fake woff2 bytes');
const JSON_BODY = Buffer.from('{"lang":"rust","ok":true}');
const JSON_BR = brotliCompressSync(JSON_BODY);
const JSON_GZIP = gzipSync(JSON_BODY);
const EXTRA = Buffer.from('/* not listed in the manifest */\n');

/** The manifest rdsh writes for the fixture tree (contract section 3). */
function defaultManifest(source) {
	return {
		version: 1,
		source,
		assets: {
			'app-ABCD1234.js': {
				identity: APP.length,
				br: APP_BR.length,
				gzip: APP_GZIP.length,
				etag: ETAG,
			},
			'font-ABCD1234.woff2': {
				identity: FONT.length,
				br: null,
				gzip: null,
				etag: FONT_ETAG,
			},
			'langs/rust-ABCD1234.json': {
				identity: JSON_BODY.length,
				br: JSON_BR.length,
				gzip: JSON_GZIP.length,
				etag: JSON_ETAG,
			},
			// Listed but deliberately not written: an unreadable file must be 404.
			'gone-ABCD1234.js': {
				identity: 10,
				br: null,
				gzip: null,
				etag: '"aaaaaaaaaaaaaaaa"',
			},
		},
	};
}

/**
 * Build a throwaway dist/assets tree and matching cache directory.
 *
 * @param t - test context for cleanup.
 * @param options.manifest - undefined for the default manifest, null to omit
 *   manifest.json, a string to write raw bytes, or a function (source) => object.
 */
async function createFixture(t, options = {}) {
	const root = await mkdtemp(join(tmpdir(), 'rdsh-web-cache-route-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, 'dist', 'assets');
	const cacheDirectory = join(root, 'cache');
	await mkdir(join(source, 'langs'), { recursive: true });
	await mkdir(join(cacheDirectory, 'langs'), { recursive: true });

	await writeFile(join(source, 'app-ABCD1234.js'), APP);
	await writeFile(join(cacheDirectory, 'app-ABCD1234.js.br'), APP_BR);
	await writeFile(join(cacheDirectory, 'app-ABCD1234.js.gz'), APP_GZIP);
	await writeFile(join(source, 'font-ABCD1234.woff2'), FONT);
	await writeFile(join(source, 'langs', 'rust-ABCD1234.json'), JSON_BODY);
	await writeFile(join(cacheDirectory, 'langs', 'rust-ABCD1234.json.br'), JSON_BR);
	await writeFile(join(cacheDirectory, 'langs', 'rust-ABCD1234.json.gz'), JSON_GZIP);
	// Present under source but absent from the manifest: the safety net.
	await writeFile(join(source, 'extra-ABCD1234.js'), EXTRA);

	let manifest = options.manifest;
	if (manifest === undefined) manifest = defaultManifest(source);
	else if (typeof manifest === 'function') manifest = manifest(source);

	if (manifest !== null) {
		const bytes = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
		await writeFile(join(cacheDirectory, 'manifest.json'), bytes);
	}

	return { root, source, cacheDirectory, manifest };
}

/** Minimal cordis-context replacement: collects routes and effect disposers. */
function createContext() {
	const registered = [];
	const disposers = [];
	const ctx = {
		effect(fn) {
			disposers.push(fn());
		},
		logger: { info() {}, warn() {} },
		webServer: {
			register(route) {
				registered.push(route);
				return () => {
					const at = registered.indexOf(route);
					if (at !== -1) registered.splice(at, 1);
				};
			},
		},
	};
	return {
		ctx,
		registered,
		dispose() {
			while (disposers.length > 0) disposers.pop()?.();
		},
	};
}

/** Set env vars for one test and restore them afterwards. */
function useEnvironment(t, values) {
	const saved = new Map();
	for (const [key, value] of Object.entries(values)) {
		saved.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	t.after(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

/** Same matching rules as @deepseek-ai/dsh-host-webserver. */
function matchRoute(routes, pathname) {
	for (const route of routes) {
		if (route.kind === 'exact' && route.path === pathname) return route;
	}
	let best;
	for (const route of routes) {
		if (route.kind !== 'prefix') continue;
		if (pathname !== route.path && !pathname.startsWith(route.path + '/')) continue;
		if (best === undefined || route.path.length > best.path.length) best = route;
	}
	return best;
}

/** One request/response exchange through the DSH-style router. */
function dispatch(routes, req, res) {
	let pathname;
	try {
		pathname = new URL(req.url === undefined ? '/' : req.url, 'http://localhost').pathname;
	} catch {
		res.writeHead(400);
		res.end();
		return;
	}
	const route = matchRoute(routes, pathname);
	if (route === undefined) {
		res.writeHead(404);
		res.end();
		return;
	}
	Promise.resolve(route.handler(req, res)).catch(() => {
		if (res.headersSent) res.destroy();
		else {
			res.writeHead(400);
			res.end();
		}
	});
}

/** Listen on an ephemeral loopback port. */
async function listen(t, routes) {
	const server = createServer((req, res) => dispatch(routes, req, res));
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	t.after(() => new Promise((resolve) => {
		server.closeAllConnections();
		server.close(resolve);
	}));
	return address.port;
}

/** Install the plugin with the fixture cache and expose its HTTP port. */
async function startPlugin(t, cacheDirectory) {
	useEnvironment(t, { RDSH_WEB_ASSETS: cacheDirectory, RDSH_WEB_CACHE: undefined });
	const context = createContext();
	apply(context.ctx);
	t.after(() => context.dispose());
	const port = await listen(t, context.registered);
	return { context, port };
}

/** Raw HTTP request; bodies are not decompressed. */
function requestRaw(port, path, options = {}) {
	return new Promise((resolve, reject) => {
		const request = httpRequest({
			host: '127.0.0.1',
			port,
			path,
			method: options.method === undefined ? 'GET' : options.method,
			headers: options.headers === undefined ? {} : options.headers,
			agent: false,
		}, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('end', () => resolve({
				status: response.statusCode,
				headers: response.headers,
				body: Buffer.concat(chunks),
			}));
		});
		request.on('error', reject);
		request.end();
	});
}

// ---------------------------------------------------------------------------
// Content negotiation.
// ---------------------------------------------------------------------------

test('br wins when the client offers brotli', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const response = await requestRaw(port, '/assets/app-ABCD1234.js', {
		headers: { 'accept-encoding': 'gzip, deflate, br' },
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers['content-encoding'], 'br');
	assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
	assert.equal(response.headers['cache-control'], IMMUTABLE);
	assert.equal(response.headers.etag, ETAG);
	assert.equal(response.headers.vary, 'accept-encoding');
	assert.equal(Number(response.headers['content-length']), APP_BR.length);
	assert.deepEqual(response.body, APP_BR);
});

test('gzip is used when the client only lists gzip', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const response = await requestRaw(port, '/assets/langs/rust-ABCD1234.json', {
		headers: { 'accept-encoding': 'gzip' },
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers['content-encoding'], 'gzip');
	assert.equal(response.headers['content-type'], 'application/json');
	assert.equal(Number(response.headers['content-length']), JSON_GZIP.length);
	assert.deepEqual(response.body, JSON_GZIP);
});

test('br;q=0 falls through to gzip', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const response = await requestRaw(port, '/assets/app-ABCD1234.js', {
		headers: { 'accept-encoding': 'br;q=0' },
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers['content-encoding'], 'gzip');
	assert.deepEqual(response.body, APP_GZIP);
});

test('identity is used when the client sends no Accept-Encoding', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const response = await requestRaw(port, '/assets/app-ABCD1234.js');

	assert.equal(response.status, 200);
	assert.equal(response.headers['content-encoding'], undefined);
	assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
	assert.equal(Number(response.headers['content-length']), APP.length);
	// Compressed variants exist, so a cache must key on accept-encoding.
	assert.equal(response.headers.vary, 'accept-encoding');
	assert.deepEqual(response.body, APP);
});

test('identity is used when the client only accepts identity', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const response = await requestRaw(port, '/assets/app-ABCD1234.js', {
		headers: { 'accept-encoding': 'identity' },
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers['content-encoding'], undefined);
	assert.deepEqual(response.body, APP);
});

test('non-compressible assets stay identity and are not negotiable', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const response = await requestRaw(port, '/assets/font-ABCD1234.woff2', {
		headers: { 'accept-encoding': 'br, gzip' },
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers['content-encoding'], undefined);
	assert.equal(response.headers['content-type'], 'font/woff2');
	assert.equal(response.headers.vary, undefined);
	assert.equal(Number(response.headers['content-length']), FONT.length);
	assert.deepEqual(response.body, FONT);
});

// ---------------------------------------------------------------------------
// Conditional requests and methods.
// ---------------------------------------------------------------------------

test('If-None-Match returns 304 for the manifest etag, 200 otherwise', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);

	const revalidated = await requestRaw(port, '/assets/app-ABCD1234.js', {
		headers: { 'accept-encoding': 'br', 'if-none-match': ETAG },
	});
	assert.equal(revalidated.status, 304);
	assert.equal(revalidated.headers.etag, ETAG);
	assert.equal(revalidated.headers['cache-control'], IMMUTABLE);
	assert.equal(revalidated.body.length, 0);

	const mismatched = await requestRaw(port, '/assets/app-ABCD1234.js', {
		headers: { 'accept-encoding': 'br', 'if-none-match': '"0000000000000000"' },
	});
	assert.equal(mismatched.status, 200);
	assert.deepEqual(mismatched.body, APP_BR);
});

test('HEAD sends the GET headers but no body', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const response = await requestRaw(port, '/assets/app-ABCD1234.js', {
		method: 'HEAD',
		headers: { 'accept-encoding': 'br' },
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers['content-encoding'], 'br');
	assert.equal(Number(response.headers['content-length']), APP_BR.length);
	assert.equal(response.body.length, 0);
});

test('methods other than GET and HEAD are 405', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const response = await requestRaw(port, '/assets/app-ABCD1234.js', { method: 'POST' });

	assert.equal(response.status, 405);
	assert.equal(response.body.length, 0);
});

// ---------------------------------------------------------------------------
// Fail-safe paths (contract sections 5.2, 5.3 and 6).
// ---------------------------------------------------------------------------

test('unknown paths and traversal attempts are 404', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const paths = [
		'/assets/missing-ABCD1234.js',
		'/assets/',
		'/assets',
		'/assets//app-ABCD1234.js',
		'/assets/..%2F..%2Fetc%2Fpasswd',
		'/assets/%2e%2e%2fmanifest.json',
		'/assets/app-ABCD1234.js.br',
	];
	for (const path of paths) {
		const response = await requestRaw(port, path);
		assert.equal(response.status, 404, path);
		assert.equal(response.body.length, 0, path);
	}
});

test('a file present under source but absent from the manifest is served', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const response = await requestRaw(port, '/assets/extra-ABCD1234.js');

	assert.equal(response.status, 200);
	assert.equal(response.headers['content-encoding'], undefined);
	assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
	assert.equal(response.headers['cache-control'], IMMUTABLE);
	assert.equal(response.headers.etag, undefined);
	assert.equal(Number(response.headers['content-length']), EXTRA.length);
	assert.deepEqual(response.body, EXTRA);
});

test('a manifest entry whose file cannot be read is 404', async (t) => {
	const fixture = await createFixture(t);
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const response = await requestRaw(port, '/assets/gone-ABCD1234.js');

	assert.equal(response.status, 404);
});

test('a missing compressed product is 404, not 500', async (t) => {
	const fixture = await createFixture(t);
	await rm(join(fixture.cacheDirectory, 'app-ABCD1234.js.br'));
	const { port } = await startPlugin(t, fixture.cacheDirectory);
	const response = await requestRaw(port, '/assets/app-ABCD1234.js', {
		headers: { 'accept-encoding': 'br' },
	});

	assert.equal(response.status, 404);
});

test('a broken or missing manifest leaves the route unregistered', async (t) => {
	const cases = [
		{ name: 'missing manifest', manifest: null },
		{ name: 'invalid json', manifest: '{"version": 1,' },
		{ name: 'wrong version', manifest: (source) => ({ ...defaultManifest(source), version: 2 }) },
		{ name: 'relative source', manifest: (source) => ({ ...defaultManifest(source), source: 'dist/assets' }) },
		{
			name: 'missing etag',
			manifest: (source) => {
				const broken = defaultManifest(source);
				delete broken.assets['app-ABCD1234.js'].etag;
				return broken;
			},
		},
		{
			name: 'unsafe manifest key',
			manifest: (source) => {
				const broken = defaultManifest(source);
				broken.assets['../escape.js'] = { identity: 1, br: null, gzip: null, etag: '"x"' };
				return broken;
			},
		},
		{ name: 'assets is an array', manifest: (source) => ({ version: 1, source, assets: [] }) },
	];

	for (const invalid of cases) {
		const fixture = await createFixture(t, { manifest: invalid.manifest });
		useEnvironment(t, { RDSH_WEB_ASSETS: fixture.cacheDirectory, RDSH_WEB_CACHE: undefined });
		const context = createContext();
		apply(context.ctx);
		assert.equal(context.registered.length, 0, invalid.name);

		const port = await listen(t, context.registered);
		const response = await requestRaw(port, '/assets/app-ABCD1234.js');
		assert.equal(response.status, 404, invalid.name);
		context.dispose();
	}
});

test('registers through ctx.inject when the webserver is not live yet', async (t) => {
	const fixture = await createFixture(t);
	useEnvironment(t, { RDSH_WEB_ASSETS: fixture.cacheDirectory, RDSH_WEB_CACHE: undefined });

	const injected = [];
	const live = createContext();
	const loadingCtx = {
		effect(fn) {
			fn();
			return () => {};
		},
		logger: { info() {}, warn() {} },
		inject(deps, callback) {
			injected.push({ deps, callback });
			return { dispose() {} };
		},
	};

	apply(loadingCtx);
	assert.equal(live.registered.length, 0);
	assert.equal(injected.length, 1);
	assert.deepEqual(injected[0].deps, ['webServer']);

	// The webserver service becomes available: the inject callback runs then.
	injected[0].callback(live.ctx);
	assert.equal(live.registered.length, 1);
	assert.equal(live.registered[0].path, '/assets');

	const port = await listen(t, live.registered);
	const response = await requestRaw(port, '/assets/app-ABCD1234.js', {
		headers: { 'accept-encoding': 'br' },
	});
	assert.equal(response.status, 200);
	assert.equal(response.headers['content-encoding'], 'br');
	live.dispose();
});

test('a context without a webserver service is harmless', async (t) => {
	const fixture = await createFixture(t);
	useEnvironment(t, { RDSH_WEB_ASSETS: fixture.cacheDirectory, RDSH_WEB_CACHE: undefined });
	const ctx = {
		effect(fn) {
			fn();
			return () => {};
		},
		logger: { info() {}, warn() {} },
	};
	assert.doesNotThrow(() => apply(ctx));
});

test('without RDSH_WEB_ASSETS only the header tap is installed', async (t) => {
	const fixture = await createFixture(t);
	useEnvironment(t, { RDSH_WEB_ASSETS: undefined, RDSH_WEB_CACHE: undefined });
	const context = createContext();
	apply(context.ctx);
	t.after(() => context.dispose());

	assert.equal(context.registered.length, 0);
	assert.ok(fixture.cacheDirectory.length > 0);
});

test('RDSH_WEB_CACHE=0 disables the route as well', async (t) => {
	const fixture = await createFixture(t);
	useEnvironment(t, { RDSH_WEB_ASSETS: fixture.cacheDirectory, RDSH_WEB_CACHE: '0' });
	const context = createContext();
	apply(context.ctx);
	t.after(() => context.dispose());

	assert.equal(context.registered.length, 0);
});

// ---------------------------------------------------------------------------
// Pure helpers: content types, negotiation and path safety.
// ---------------------------------------------------------------------------

test('content types follow the contract table', () => {
	const table = [
		['app-ABCD1234.js', 'text/javascript; charset=utf-8'],
		['app-ABCD1234.css', 'text/css; charset=utf-8'],
		['icon-ABCD1234.svg', 'image/svg+xml'],
		['data-ABCD1234.json', 'application/json'],
		['app-ABCD1234.js.map', 'application/json'],
		['site.webmanifest', 'application/manifest+json'],
		['index-ABCD1234.html', 'text/html; charset=utf-8'],
		['font-ABCD1234.woff2', 'font/woff2'],
		['font-ABCD1234.woff', 'font/woff'],
		['image-ABCD1234.png', 'image/png'],
		['favicon-ABCD1234.ico', 'image/x-icon'],
		['README', 'application/octet-stream'],
	];
	for (const [path, expected] of table) assert.equal(contentTypeFor(path), expected, path);
});

test('selectEncoding applies the contract priority and q=0 exclusions', () => {
	const entry = { identity: 1, br: 2, gzip: 3, etag: ETAG };
	const cases = [
		[undefined, 'identity'],
		['', 'identity'],
		['gzip', 'gzip'],
		['br', 'br'],
		['gzip, deflate, br', 'br'],
		['br;q=0', 'gzip'],
		['br;q=0, gzip;q=0', 'identity'],
		['identity', 'identity'],
		['*', 'identity'],
	];
	for (const [header, expected] of cases) {
		assert.equal(selectEncoding(header, entry), expected, String(header));
	}

	const identityOnly = { identity: 1, br: null, gzip: null, etag: ETAG };
	assert.equal(selectEncoding('br, gzip', identityOnly), 'identity');
});

test('Accept-Encoding parameters are parsed', () => {
	assert.equal(parseAcceptEncoding('br').get('br'), 1);
	assert.equal(parseAcceptEncoding('br;q=0, gzip;q=0.5').get('br'), 0);
	assert.equal(parseAcceptEncoding('br;q=0, gzip;q=0.5').get('gzip'), 0.5);
	assert.equal(parseAcceptEncoding('BR;Q=0').get('br'), 0);
	assert.equal(parseAcceptEncoding('*').has('*'), true);
});

test('request paths are decoded exactly once and traversal is rejected', () => {
	assert.equal(relativeAssetPath('/assets/app-ABCD1234.js'), 'app-ABCD1234.js');
	assert.equal(relativeAssetPath('/assets/langs/rust-ABCD1234.json'), 'langs/rust-ABCD1234.json');
	assert.equal(relativeAssetPath('/assets/'), undefined);
	assert.equal(relativeAssetPath('/assets'), undefined);
	assert.equal(relativeAssetPath('/assets//app-ABCD1234.js'), undefined);
	assert.equal(relativeAssetPath('/assets/a/%2e%2e/b.js'), undefined);
	assert.equal(relativeAssetPath('/assets/a/%00/b.js'), undefined);
	assert.equal(relativeAssetPath('/assets/%E0%A4%A'), undefined);

	assert.equal(isSafeRelativePath('a/b.js'), true);
	assert.equal(isSafeRelativePath('..'), false);
	assert.equal(isSafeRelativePath('../escape.js'), false);
	assert.equal(isSafeRelativePath('/etc/passwd'), false);
	assert.equal(isSafeRelativePath('a/../b'), false);
});
