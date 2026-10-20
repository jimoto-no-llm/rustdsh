import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { apply } from '../index.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Boot a throwaway server, install the plugin's tap, and report the header the
 * client actually receives for one path.
 */
async function headerFor(path) {
	const server = createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/javascript' });
		res.end('/* body */');
	});

	// The plugin only needs ctx.effect and an optional logger. Cordis passes
	// the disposer returned by the effect callback back to its own lifecycle,
	// so this stub does the same and apply() returns nothing.
	const disposers = [];
	const ctx = {
		effect(fn) {
			disposers.push(fn());
		},
		logger: { info() {} },
	};

	apply(ctx);
	const dispose = () => {
		for (const d of disposers) d?.();
	};

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();

	const response = await fetch(`http://127.0.0.1:${port}${path}`);
	await response.arrayBuffer();

	await new Promise((resolve) => server.close(resolve));
	dispose();

	return response.headers.get('cache-control');
}

test('a hashed shell asset receives the immutable header', async () => {
	assert.equal(await headerFor('/assets/index-CN7NIWNw.js'), IMMUTABLE);
});

test('the response body is untouched', async () => {
	const server = createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/javascript' });
		res.end('/* body */');
	});
	const ctx = { effect: (fn) => fn(), logger: { info() {} } };
	apply(ctx);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	const text = await (await fetch(`http://127.0.0.1:${port}/assets/index-CN7NIWNw.js`)).text();
	await new Promise((resolve) => server.close(resolve));
	assert.equal(text, '/* body */');
});

test('a non-hashed path keeps its own headers', async () => {
	assert.equal(await headerFor('/assets/index.js'), null);
	assert.equal(await headerFor('/'), null);
});
