import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
	DEFAULT_BASE,
	PROVIDER_ID,
	apply,
	encodeQuery,
	resolveBase,
	shouldBridge,
	sourceFromJson,
	sourcesFromHtml
} from '../index.js';

function withEnv(t, values) {
	const previous = new Map();
	for (const [name, value] of Object.entries(values)) {
		previous.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	t.after(() => {
		for (const [name, previousValue] of previous) {
			if (previousValue === undefined) delete process.env[name];
			else process.env[name] = previousValue;
		}
	});
}

/** One-shot engine fixture: each request is answered by the next handler. */
async function engineFixture(t, handler) {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1');
	t.after(() => server.close());
	await once(server, 'listening');
	const port = server.address().port;
	return 'http://127.0.0.1:' + port;
}

function fakeWebContext() {
	const registered = [];
	return {
		registered,
		inject(names, callback) {
			assert.deepEqual(names, ['web']);
			callback({ web: { registerSearchProvider(p) { registered.push(p); } } });
		}
	};
}

test('shouldBridge follows the injected pin only', () => {
	assert.equal(shouldBridge({}), false);
	assert.equal(shouldBridge({ DSH_WEB_SEARCH_PROVIDER: 'deepseek-official' }), false);
	assert.equal(shouldBridge({ DSH_WEB_SEARCH_PROVIDER: PROVIDER_ID }), true);
});

test('resolveBase prefers the injected value and rejects hostile URLs', () => {
	assert.equal(resolveBase({ RDSH_SEARXNG_URL: 'http://127.0.0.1:9001' }), 'http://127.0.0.1:9001');
	assert.equal(resolveBase({}, { baseURL: 'http://127.0.0.1:9002' }), 'http://127.0.0.1:9002');
	assert.equal(resolveBase({}), DEFAULT_BASE);
	assert.equal(resolveBase({ RDSH_SEARXNG_URL: 'http://localhost:8888#frag' }), undefined);
	assert.equal(resolveBase({ RDSH_SEARXNG_URL: 'http://user@host:8888' }), undefined);
	assert.equal(resolveBase({ RDSH_SEARXNG_URL: 'https://remote.example' }), undefined, 'only http is spoken');
});

test('encodeQuery matches the Rust client', () => {
	assert.equal(encodeQuery('rust async foo'), 'rust+async+foo');
	assert.equal(encodeQuery('a&b=c'), 'a%26b%3Dc');
});

test('sourceFromJson maps rustxng rows and drops empty URLs', () => {
	const mapped = sourceFromJson({ url: 'https://x', title: 'T', content: 'S' });
	assert.deepEqual(mapped, { url: 'https://x', title: 'T', snippet: 'S' });
	assert.equal(sourceFromJson({ url: '', title: 'no' }), undefined);
	assert.equal(sourceFromJson(null), undefined);
});

test('sourcesFromHtml parses a SearXNG results page', () => {
	const body = [
		'<div id="results">',
		'<article class="result result-default">',
		'<h3><a href="https://one.example/a?x=1">One &amp; Two</a></h3>',
		'<p class="content">first snippet &lt;b&gt;</p>',
		'</article>',
		'<article class="result">',
		'<a href="https://two.example/b">Second</a>',
		'</article>',
		'</div>'
	].join('\n');
	const sources = sourcesFromHtml(body);
	assert.equal(sources.length, 2);
	assert.deepEqual(sources[0], { url: 'https://one.example/a?x=1', title: 'One & Two', snippet: 'first snippet <b>' });
	assert.deepEqual(sources[1], { url: 'https://two.example/b', title: 'Second' });
});

test('search maps the engine JSON answer', async (t) => {
	const seenQueries = [];
	const base = await engineFixture(t, (request, response) => {
		seenQueries.push(request.url);
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ results: [
			{ url: 'https://one.example/a', title: 'One', content: 'alpha' },
			{ url: 'https://one.example/a', title: 'dup', content: 'dup' },
			{ url: '', title: 'empty' }
		] }));
	});
	const provider = registeredProviderForTest(base, t);
	const result = await provider.search({ query: 'rust async foo' });
	assert.deepEqual(result, { sources: [{ url: 'https://one.example/a', title: 'One', snippet: 'alpha' }], truncated: false });
	assert.equal(seenQueries[0].includes('q=rust+async+foo'), true);
	assert.equal(seenQueries[0].includes('format=json'), true);
});

test('search falls back to HTML when the engine has no JSON API', async (t) => {
	const html = [
		'<article class="result result-default">',
		'<h3><a href="https://two.example/b">Second</a></h3>',
		'<p class="content">via html</p>',
		'</article>'
	].join('\n');
	assert.notDeepEqual(sourcesFromHtml(html), []);
	const base = await engineFixture(t, (request, response) => {
		response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		response.end(html);
	});
	const provider = registeredProviderForTest(base, t);
	const result = await provider.search({ query: 'fallback' });
	assert.deepEqual(result, { sources: [{ url: 'https://two.example/b', title: 'Second', snippet: 'via html' }], truncated: false });
});

test('search fails loud on a dead endpoint instead of falling back', async (t) => {
	const base = await engineFixture(t, (request, response) => {
		response.writeHead(500, { 'content-type': 'text/plain' });
		response.end('boom');
	});
	const provider = registeredProviderForTest(base, t);
	await assert.rejects(provider.search({ query: 'down' }), /HTTP 500/);
});

test('apply registers only with the injected pin and honors the off switch', async (t) => {
	withEnv(t, {
		DSH_WEB_SEARCH_PROVIDER: undefined,
		RDSH_SEARXNG_URL: undefined,
		RDSH_WEB_SEARCH_BRIDGE: undefined
	});
	const withoutPin = fakeWebContext();
	apply(withoutPin);
	assert.deepEqual(withoutPin.registered, []);

	withEnv(t, { DSH_WEB_SEARCH_PROVIDER: PROVIDER_ID, RDSH_SEARXNG_URL: 'http://127.0.0.1:9004' });
	const withPin = fakeWebContext();
	apply(withPin);
	assert.equal(withPin.registered.length, 1);
	assert.equal(withPin.registered[0].id, PROVIDER_ID);

	const off = fakeWebContext();
	withEnv(t, { RDSH_WEB_SEARCH_BRIDGE: '0' });
	apply(off);
	assert.deepEqual(off.registered, []);
});

test('apply keeps working when no web seam exists (old composition)', (t) => {
	withEnv(t, { DSH_WEB_SEARCH_PROVIDER: PROVIDER_ID, RDSH_SEARXNG_URL: 'http://127.0.0.1:9005' });
	apply({}); // no inject, no web: must not throw
});

/** Helper the tests above use: set the pin for base and claim the provider. */
function registeredProviderForTest(base, t) {
	const holder = { registered: [] };
	withEnv(t, { DSH_WEB_SEARCH_PROVIDER: PROVIDER_ID, RDSH_SEARXNG_URL: base });
	const wrapper = {
		inject(names, callback) {
			callback({ web: { registerSearchProvider(p) { holder.registered.push(p); } } });
		}
	};
	apply(wrapper);
	assert.equal(holder.registered.length, 1, 'fixture registered one provider');
	return holder.registered[0];
}
