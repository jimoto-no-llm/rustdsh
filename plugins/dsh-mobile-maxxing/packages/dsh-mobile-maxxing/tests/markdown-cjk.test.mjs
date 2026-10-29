/** Unit tests for the pure transforms: no DSH process, no browser. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKDOWN_FIX_PATH, patchMarkdownVendor, rewriteIndexChunk, rewriteIndexHtml } from '../lib/markdown-cjk-runtime.js';

/** A vendor chunk with the two autolink tokenizers the fix anchors on. */
const VENDOR = [
	'function kg(e,t){let n=0,r=0;return a;function a(s){return s===40?(n++,e.consume(s),a):s===null||fe(s)||pn(s)?t(s):(e.consume(s),a)}}',
	'function _g(e,t,n){return r;function r(o){return o===33||o===34||o===39?(e.consume(o),r):o===60||o===null||fe(o)||pn(o)?t(o):n(o)}}',
].join('');

/** An index chunk shaped like the built one: an import plus a dependency map. */
const CHUNK = 'const d=["./vendor-abc.js"];import{x as y}from"./vendor-abc.js";export{y};';

test('CJK punctuation ends a path', () => {
	const patched = patchMarkdownVendor(VENDOR);
	assert.equal(typeof patched, 'string');
	assert.ok(patched.includes('\\u3001-\\u3003'));
	assert.ok(patched.includes('s>127'), 'ASCII URLs are untouched');
});

test('CJK prose ends a trailing-punctuation run', () => {
	const patched = patchMarkdownVendor(VENDOR);
	assert.ok(patched.includes('\\u3040-\\u30ff'), 'kana closes a bold URL run');
	assert.ok(patched.includes('\\u4e00-\\u9fff'), 'ideographs too');
});

test('patching is idempotent', () => {
	const once = patchMarkdownVendor(VENDOR);
	assert.equal(patchMarkdownVendor(once), once);
});

test('an unknown chunk shape is refused, not half-patched', () => {
	assert.equal(patchMarkdownVendor('var unrelated = 1;'), null);
	assert.equal(patchMarkdownVendor(''), null);
});

test('the index chunk imports the served vendor', () => {
	const rewritten = rewriteIndexChunk(CHUNK, 'vendor-abc.js');
	assert.equal(typeof rewritten, 'string');
	assert.ok(rewritten.includes(`from"${MARKDOWN_FIX_PATH}/vendor-abc.js"`));
	assert.ok(rewritten.includes('"./vendor-abc.js"'), 'the lazy dependency table keeps its entry');
});

test('a chunk without the expected import is refused', () => {
	assert.equal(rewriteIndexChunk('var unrelated = 1;', 'vendor-abc.js'), null);
});

test('the document points at the served chunks in both URL forms', () => {
	const html = [
		'<script type="module" src="./assets/index-abc.js"></script>',
		'<link rel="modulepreload" href="/assets/vendor-abc.js">',
		'<link rel="stylesheet" href="./assets/vendor-abc.css">',
	].join('');
	const rewritten = rewriteIndexHtml(html, 'index-abc.js', 'vendor-abc.js');
	assert.ok(rewritten.includes(`src="${MARKDOWN_FIX_PATH}/index-abc.js"`));
	assert.ok(rewritten.includes(`href="${MARKDOWN_FIX_PATH}/vendor-abc.js"`));
	assert.ok(rewritten.includes('./assets/vendor-abc.css'), 'other assets stay put');
});
