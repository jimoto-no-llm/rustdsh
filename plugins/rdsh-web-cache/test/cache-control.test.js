import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheControlFor } from '../index.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

test('hashed shell assets become immutable', () => {
	assert.equal(cacheControlFor('/assets/index-CN7NIWNw.js'), IMMUTABLE);
	assert.equal(cacheControlFor('/assets/vendor-DcuzkuQH.js'), IMMUTABLE);
	assert.equal(cacheControlFor('/assets/index-BxpfOGf3.css'), IMMUTABLE);
	assert.equal(cacheControlFor('/assets/vendor-DV2921Zo.css'), IMMUTABLE);
});

test('non-hashed assets keep the upstream policy', () => {
	// No content hash: a long max-age could serve stale bytes after a rebuild.
	assert.equal(cacheControlFor('/assets/index.js'), undefined);
	assert.equal(cacheControlFor('/assets/vendor.css'), undefined);
	assert.equal(cacheControlFor('/assets/favicon.ico'), undefined);
});

test('the document and plugin combo are never touched', () => {
	// index.html is rendered per request and plugins already set their own header.
	assert.equal(cacheControlFor('/'), undefined);
	assert.equal(cacheControlFor('/index.html'), undefined);
	assert.equal(cacheControlFor('/plugins/??a/client.js&rev=abc'), undefined);
});

test('unknown extensions are left alone', () => {
	assert.equal(cacheControlFor('/assets/data-abc12345.json'), undefined);
	assert.equal(cacheControlFor('/assets/note-abc12345.txt'), undefined);
});

test('degenerate inputs do not throw', () => {
	assert.equal(cacheControlFor(''), undefined);
	assert.equal(cacheControlFor('/assets/'), undefined);
	assert.equal(cacheControlFor('/assets/.js'), undefined);
	assert.equal(cacheControlFor(undefined), undefined);
	assert.equal(cacheControlFor(null), undefined);
});
