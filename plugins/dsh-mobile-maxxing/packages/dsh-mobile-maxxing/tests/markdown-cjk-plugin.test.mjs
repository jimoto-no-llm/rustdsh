/** Host-half tests: mount the plugin on a fake Web server. */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
// The merged package mounts many host halves; this suite covers only the
// CJK one, so it drives that module directly instead of index.js.
import { apply } from '../lib/markdown-cjk.js';

/**
 * Locate the installed DSH launcher, or nothing.
 *
 * The CJK half patches the installed frontend chunks, so some cases only run
 * where DSH is installed. Resolve it the way DSH itself does (DSH_ORIG_BIN,
 * then the package) instead of assuming this machine's layout, and let the
 * cases that need it report a skip rather than silently pass.
 */
function resolveDshBin() {
	if (typeof process.env.DSH_ORIG_BIN === "string" && existsSync(process.env.DSH_ORIG_BIN)) return process.env.DSH_ORIG_BIN;
	try {
		return createRequire(import.meta.url).resolve("@deepseek-ai/dsh/lib/bin.js");
	} catch {
		return undefined;
	}
}

const DSH_BIN = resolveDshBin();
const installed = DSH_BIN !== undefined;

/** Mount the plugin against a fake server and collect what it registers. */
function mount(config) {
	const routes = [];
	const taps = [];
	const webServer = {
		register(route) {
			routes.push(route);
			return () => {};
		},
		tapIndex(tap) {
			taps.push(tap);
			return () => {};
		},
	};
	apply({ inject: (deps, callback) => callback({ webServer }) }, config);
	return { routes, taps };
}

test('the CJK module keeps its standalone API', () => {
	// The merged plugin no longer mounts it (a shared document cannot rewrite
	// the renderer for desktops only), so the independent rdsh-markdown-cjk
	// plugin owns the fix. This module still offers the same apply() for it.
	assert.equal(typeof apply, 'function');
});

test('config.enabled=false keeps stock rendering', () => {
	const { routes, taps } = mount({ enabled: false });
	assert.equal(routes.length, 0);
	assert.equal(taps.length, 0);
});

test('a linked plugin patches the installed chunks', { skip: !installed }, () => {
	const previous = process.env.DSH_ORIG_BIN;
	process.env.DSH_ORIG_BIN = DSH_BIN;
	try {
		const { routes, taps } = mount({});
		assert.equal(routes.length, 2, 'the vendor chunk and its index chunk');
		for (const route of routes) assert.ok(route.path.startsWith('/markdown-cjk/v1/'), route.path);
		assert.equal(taps.length, 1);
		const indexName = routes[1].path.split('/').at(-1);
		const html = taps[0](`<script type="module" src="./assets/${indexName}"></script>`);
		assert.ok(html.includes(`/markdown-cjk/v1/${indexName}`), 'the document points at the patched chunk');
		assert.ok(!html.includes(`./assets/${indexName}`), 'the stock path is gone');
	} finally {
		if (previous === undefined) delete process.env.DSH_ORIG_BIN;
		else process.env.DSH_ORIG_BIN = previous;
	}
});

test('the route answers GET and refuses other methods', { skip: !installed }, async () => {
	const previous = process.env.DSH_ORIG_BIN;
	process.env.DSH_ORIG_BIN = DSH_BIN;
	try {
		const { routes } = mount({});
		const [route] = routes;
		const chunks = [];
		let status;
		let headers;
		const response = {
			writeHead(code, value) {
				status = code;
				headers = value;
			},
			end(body) {
				if (body !== undefined) chunks.push(Buffer.from(body));
			},
		};
		await route.handler({ method: 'GET' }, response);
		assert.equal(status, 200);
		assert.equal(headers['content-type'], 'text/javascript; charset=utf-8');
		assert.ok(Buffer.concat(chunks).toString('utf8').includes('__DSH_CJK_AUTOLINK_FIX_V1__'));

		status = undefined;
		await route.handler({ method: 'POST' }, response);
		assert.equal(status, 405);
	} finally {
		if (previous === undefined) delete process.env.DSH_ORIG_BIN;
		else process.env.DSH_ORIG_BIN = previous;
	}
});
