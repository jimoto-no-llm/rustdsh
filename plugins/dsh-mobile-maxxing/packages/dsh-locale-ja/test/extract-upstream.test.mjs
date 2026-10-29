import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildSnapshot, checkSnapshot, writeSnapshot } from '../../../tools/extract-upstream.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const snapshotDir = path.join(repoRoot, 'packages', 'dsh-locale-ja', 'locale');
const englishDir = path.join(snapshotDir, 'namespaces', 'en');
const fixtureRoot = path.join(repoRoot, 'packages', 'dsh-locale-ja', 'test', 'fixtures', 'runtime', '@deepseek-ai');
const committedUpstream = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'upstream.json'), 'utf8'));
const placeholderPattern = /\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu;

let installedSnapshot = null;
let installedError = null;
try {
	installedSnapshot = await buildSnapshot();
} catch (error) {
	installedError = error;
}

function installedOrSkip(t) {
	if (installedError !== null) {
		if (installedError.message.includes('could not find an installed')) {
			t.skip('installed DSH runtime not available in this environment');
			return null;
		}
		assert.fail(installedError.message);
	}
	return installedSnapshot;
}

function placeholders(value) {
	return [...value.matchAll(placeholderPattern)].map((match) => match[1]).sort();
}

test('committed English snapshot reproduces from the installed runtime', (t) => {
	const snapshot = installedOrSkip(t);
	if (snapshot === null) return;
	if (snapshot.upstream.dsh.version !== committedUpstream.dsh.version) {
		t.skip('installed DSH ' + snapshot.upstream.dsh.version + ' differs from snapshot ' + committedUpstream.dsh.version + '; re-run the extractor');
		return;
	}
	assert.equal(snapshot.upstream.totals.namespaces, 65, 'the current snapshot must expose exactly 65 locale namespaces');
	assert.equal(snapshot.upstream.totals.keys, 2915, 'the current snapshot must expose exactly 2915 English keys');
	assert.equal(snapshot.upstream.totals.locales.en, 2915);
	assert.equal(snapshot.upstream.totals.locales.zh, 2915);
	assert.deepEqual(snapshot.upstream, committedUpstream, 'locale/upstream.json must match a fresh extraction');
	assert.deepEqual(checkSnapshot(snapshot, snapshotDir), [], 'committed English files must be byte-identical to a fresh extraction');
	assert.equal(fs.readdirSync(englishDir).filter((file) => file.endsWith('.json')).length, 65);
	assert.equal(Object.keys(committedUpstream.namespaces).length, 65);
	assert.equal(Object.values(committedUpstream.namespaces).reduce((sum, entry) => sum + entry.keyCounts.en, 0), 2915);
	for (const [namespace, entry] of Object.entries(committedUpstream.namespaces)) {
		assert.equal(entry.owners.length, 1, namespace + ' must name its owning package');
		assert.equal(entry.sources.length >= 1, true, namespace + ' must record at least one source');
		assert.equal(entry.sourceHash.startsWith('sha256:'), true, namespace + ' must record a source hash');
		assert.equal(entry.dictionaryHashes.en.startsWith('sha256:'), true, namespace + ' must record an English dictionary hash');
		assert.equal(entry.dictionaryHashes.zh.startsWith('sha256:'), true, namespace + ' must record a Chinese dictionary hash');
		assert.equal(entry.keyCounts.en, entry.keyCounts.zh, namespace + ' must have the same key count in both upstream locales');
	}
});

test('upstream English and Chinese key sets and placeholders agree', (t) => {
	const snapshot = installedOrSkip(t);
	if (snapshot === null) return;
	if (snapshot.upstream.dsh.version !== committedUpstream.dsh.version) {
		t.skip('installed DSH version differs from the committed snapshot');
		return;
	}
	let checked = 0;
	for (const [namespace, dictionaries] of Object.entries(snapshot.dictionaries)) {
		const englishKeys = Object.keys(dictionaries.en).sort();
		const chineseKeys = Object.keys(dictionaries.zh).sort();
		assert.deepEqual(englishKeys, chineseKeys, namespace + ' has different en/zh key sets');
		for (const key of englishKeys) {
			checked += 1;
			assert.deepEqual(
				placeholders(dictionaries.en[key]),
				placeholders(dictionaries.zh[key]),
				namespace + '.' + key + ' has different placeholders',
			);
		}
	}
	assert.equal(checked, 2915);
});

test('extractor follows spreads, templates, joins, comments, multi-namespace files and 3-argument registers', async () => {
	const snapshot = await buildSnapshot({ dshRoot: fixtureRoot });
	assert.deepEqual(Object.keys(snapshot.dictionaries).sort(), ['fixture.alpha', 'fixture.beta', 'fixture.gamma']);
	assert.deepEqual(snapshot.upstream.totals, { namespaces: 3, keys: 9, locales: { en: 9, zh: 9 } });
	assert.equal(snapshot.warnings.length, 0);

	const alpha = snapshot.dictionaries['fixture.alpha'].en;
	assert.equal(alpha['shared.one'], 'One {name}', 'object spread must be materialized');
	assert.equal(alpha['template.value'], 'Hello right\nsecond line', 'template literals must keep their cooked text');
	assert.equal(alpha['concat.value'], 'left-right', 'string concatenation must be resolved');
	assert.equal(alpha['joined.value'], 'line one\n\nline two', 'array join() must be resolved');
	assert.equal(alpha['brace.value'], 'literal } brace {and} escaped "quote"', 'braces and escaped quotes in strings must not confuse the parser');
	assert.equal(Object.keys(alpha).length, 6);
	assert.equal(Object.keys(snapshot.dictionaries['fixture.alpha'].zh).length, 6);
	assert.equal(snapshot.dictionaries['fixture.beta'].en.beta, 'Beta');
	assert.equal(snapshot.dictionaries['fixture.gamma'].en.gamma, 'Gamma {count}');
	assert.equal(snapshot.dictionaries['fixture.gamma'].zh.gamma, 'ガンマ {count}');

	assert.equal(snapshot.dictionaries['fixture.decoy'], undefined, 'commented-out registrations must be ignored');
	assert.equal(snapshot.dictionaries['fixture.string'], undefined, 'registration text inside strings must be ignored');
	assert.equal('fake' in snapshot.dictionaries['fixture.beta'].en, false);

	const alphaEntry = snapshot.upstream.namespaces['fixture.alpha'];
	const betaEntry = snapshot.upstream.namespaces['fixture.beta'];
	assert.deepEqual(alphaEntry.owners, ['@deepseek-ai/dsh-fixture-a']);
	assert.equal(alphaEntry.sources[0].file, 'lib/client.js');
	assert.equal(betaEntry.sources[0].file, 'lib/client.js', 'two namespaces from one file must both be recorded');
	assert.equal(alphaEntry.keyCounts.en, 6);
	assert.equal(betaEntry.keyCounts.en, 2);
	assert.equal(snapshot.upstream.namespaces['fixture.gamma'].sources[0].line > 0, true);
});

test('writeSnapshot writes only the English snapshot and upstream.json, leaving existing ja data untouched', async () => {
	const snapshot = await buildSnapshot({ dshRoot: fixtureRoot });
	const output = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locale-ja-'));
	try {
		const japaneseDir = path.join(output, 'namespaces', 'ja');
		fs.mkdirSync(japaneseDir, { recursive: true });
		const japaneseFile = path.join(japaneseDir, 'common.json');
		const japaneseText = '{\n  "ok": "既存の値"\n}\n';
		fs.writeFileSync(japaneseFile, japaneseText);

		writeSnapshot(snapshot, output);
		assert.equal(fs.readFileSync(japaneseFile, 'utf8'), japaneseText, 'stage 1 must not rewrite existing Japanese values');
		assert.equal(fs.readdirSync(path.join(output, 'namespaces', 'en')).length, 3);
		assert.deepEqual(checkSnapshot(snapshot, output), []);

		fs.writeFileSync(path.join(output, 'namespaces', 'en', 'fixture.alpha.json'), '{}\n');
		fs.writeFileSync(path.join(output, 'namespaces', 'en', 'stale.json'), '{}\n');
		const problems = checkSnapshot(snapshot, output);
		assert.equal(problems.some((problem) => problem.startsWith('different ') && problem.includes('fixture.alpha.json')), true);
		assert.equal(problems.some((problem) => problem.startsWith('stale ') && problem.includes('stale.json')), true);
	} finally {
		fs.rmSync(output, { recursive: true, force: true });
	}
});
