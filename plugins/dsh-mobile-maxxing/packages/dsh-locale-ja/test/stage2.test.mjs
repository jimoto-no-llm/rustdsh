import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	BATCH_MAX,
	BATCH_MIN,
	DEFAULT_PACKAGE_DIR,
	EXPECTED_KEYS,
	EXPECTED_NAMESPACES,
	assertPlaceholders,
	buildArtifacts,
	checkArtifacts,
	dictionaryHash,
	duplicateValueWarnings,
	isIntentionalBlank,
	jsonText,
	loadEnglish,
	loadJapanese,
	localePaths,
	parseStrictJson,
	placeholders,
	readJsonFile,
	validateBatchManifest,
	validateMeta,
	writeArtifacts,
} from '../../../tools/locale-data.mjs';
import { mergeReviewedBatches } from '../../../tools/merge-batches.mjs';
import { loadClientModule } from './client-loader.mjs';

const packageDir = path.resolve(import.meta.dirname, '..');

test('locale peer metadata must be a nonempty string when supplied', () => {
	const base = { name: 'dsh-locale-ja', version: '0.1.1', description: 'test' };
	assert.equal(validateMeta(base), base);
	assert.equal(validateMeta({ ...base, clientLocalePeer: '0.2.1-rc.2 || 0.2.1-rc.3' }).clientLocalePeer, '0.2.1-rc.2 || 0.2.1-rc.3');
	for (const invalid of [null, '', '  ', 3]) assert.throws(() => validateMeta({ ...base, clientLocalePeer: invalid }), /clientLocalePeer/);
});

/**
 * The generated client is a browser bundle, not an ES module: load it through
 * the same window.__ModuleLoader__.load({ id, factory }) registration the DSH
 * Host queues in a classic <script> batch, then materialize the factory.
 */
const clientSource = fs.readFileSync(path.join(packageDir, 'client.js'), 'utf8');
const browserClient = loadClientModule(clientSource);
const { apply, dictionaries, inject, language } = browserClient;

/**
 * Immutable evidence of the 83 values migrated from the old mobile pack.
 *
 * The fixture is never regenerated from a moving source: it pins the exact
 * reviewed strings and their hash, so a later dictionary edit cannot quietly
 * change a migrated value. New translations arrive through reviewed batches.
 */
const seedFixture = readJsonFile(path.join(packageDir, 'test', 'fixtures', 'seed-ja-83.json'));

function seedDictionaries() {
	return seedFixture.dictionaries;
}

function seedHash(dictionarySet) {
	return 'sha256:' + createHash('sha256').update(JSON.stringify(dictionarySet)).digest('hex');
}

function temporaryDirectory(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locale-ja-stage2-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/**
 * A temporary package with the English snapshot and only the explicit 83-key
 * seed fixture as Japanese. Mutation tests start from this fixed incomplete
 * state, so they behave the same before and after the remaining batches land.
 */
function copyPackageLocale(t) {
	const directory = temporaryDirectory(t);
	fs.cpSync(path.join(packageDir, 'locale'), path.join(directory, 'locale'), { recursive: true });
	const jaDirectory = path.join(directory, 'locale', 'namespaces', 'ja');
	fs.rmSync(jaDirectory, { recursive: true, force: true });
	fs.mkdirSync(jaDirectory, { recursive: true });
	const upstream = readJsonFile(path.join(directory, 'locale', 'upstream.json'));
	for (const [namespace, dictionary] of Object.entries(seedDictionaries())) {
		writeJson(path.join(jaDirectory, upstream.namespaces[namespace].fileName), dictionary);
	}
	return directory;
}

/** A temporary package with no Japanese dictionary at all. */
function copyPackageWithoutJapanese(t) {
	const directory = copyPackageLocale(t);
	fs.rmSync(path.join(directory, 'locale', 'namespaces', 'ja'), { recursive: true, force: true });
	return directory;
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, jsonText(value));
}

function readBatchFile(packageDirectory) {
	return readJsonFile(path.join(packageDirectory, 'locale', 'batches.json'));
}

function batchById(packageDirectory, id) {
	const batch = readBatchFile(packageDirectory).batches.find((entry) => entry.id === id);
	assert.ok(batch, 'missing batch ' + id);
	return batch;
}

function makeOutput(packageDirectory, id, { sourceHash = null, omit = null, transform = (value) => '【改】' + value } = {}) {
	const batch = batchById(packageDirectory, id);
	const upstream = readJsonFile(path.join(packageDirectory, 'locale', 'upstream.json'));
	const english = readJsonFile(path.join(packageDirectory, 'locale', 'namespaces', 'en', upstream.namespaces[batch.namespace].fileName));
	const values = {};
	for (const key of batch.keys) {
		if (key === omit) continue;
		values[key] = transform(english[key]);
	}
	return {
		schemaVersion: 1,
		batch: id,
		namespace: batch.namespace,
		sourceHash: sourceHash ?? batch.sourceHash,
		values,
	};
}

function writeReviewed(workDirectory, reviewed) {
	writeJson(path.join(workDirectory, 'reviewed.json'), { schemaVersion: 1, reviewed });
}

function englishFileHashes(packageDirectory) {
	const upstream = readJsonFile(path.join(packageDirectory, 'locale', 'upstream.json'));
	const hashes = {};
	for (const [namespace, entry] of Object.entries(upstream.namespaces)) {
		hashes[namespace] = dictionaryHash(readJsonFile(path.join(packageDirectory, 'locale', 'namespaces', 'en', entry.fileName)));
	}
	return hashes;
}

test('generated files are fresh and keep the stage-1 65/2915 snapshot', () => {
	const check = checkArtifacts({ packageDir });
	assert.deepEqual(check.problems, []);
	const { upstream, dictionaries: english } = loadEnglish(packageDir);
	assert.equal(Object.keys(english).length, EXPECTED_NAMESPACES);
	assert.equal(Object.keys(upstream.namespaces).length, EXPECTED_NAMESPACES);
	assert.equal(Object.values(english).reduce((sum, dictionary) => sum + Object.keys(dictionary).length, 0), EXPECTED_KEYS);
	assert.equal(upstream.totals.keys, EXPECTED_KEYS);

	const status = readJsonFile(path.join(packageDir, 'locale', 'translation-status.json'));
	assert.equal(status.locale, 'ja');
	assert.equal(status.fallbackPolicy, 'development-only-english');
	assert.equal(status.totals.namespaces, EXPECTED_NAMESPACES);
	assert.equal(status.totals.keys, EXPECTED_KEYS);
	let translated = 0;
	let fallback = 0;
	for (const [namespace, entry] of Object.entries(upstream.namespaces)) {
		const counts = status.namespaces[namespace];
		assert.equal(counts.sourceHash, entry.sourceHash, namespace + ' status names the wrong source');
		assert.equal(counts.keys, Object.keys(english[namespace]).length, namespace + ' key count drifted');
		assert.equal(counts.translated + counts.fallback, counts.keys, namespace + ' does not account for every key');
		assert.equal(counts.status, counts.translated === 0 ? 'fallback' : counts.fallback === 0 ? 'translated' : 'partial');
		translated += counts.translated;
		fallback += counts.fallback;
	}
	assert.equal(status.totals.translated, translated);
	assert.equal(status.totals.fallback, fallback);
	assert.equal(status.status, fallback === 0 ? 'complete' : 'incomplete');
	assert.equal(status.developmentOnlyEnglishFallback, fallback > 0);
});

test('the client registers through the DSH browser module loader, not an ES module', () => {
	// The Host serves every plugin client file verbatim inside a classic
	// <script> batch (dsh-client-modules concatenates the bytes), so the only
	// accepted shape is window.__ModuleLoader__.load({ id, factory }). Raw ESM
	// exports fail to parse there ("Unexpected token 'export'") and register
	// nothing, which the loader reports as "loaded without registering".
	assert.deepEqual(browserClient.registration.id, 'dsh-locale-ja');
	assert.deepEqual(Object.keys(browserClient.registration).sort(), ['factory', 'id']);
	assert.equal(typeof browserClient.registration.factory, 'function');
	assert.equal(typeof browserClient.exports.apply, 'function');
	assert.equal(typeof browserClient.apply, 'function');
	assert.deepEqual(browserClient.language, { id: 'ja', label: '日本語', fallback: 'en' });
	assert.deepEqual(browserClient.inject, ['locale']);
	assert.equal(Object.keys(browserClient.dictionaries).length, EXPECTED_NAMESPACES);
	assert.equal((clientSource.match(/^window\.__ModuleLoader__\.load\(/gmu) ?? []).length, 1,
		'one script must register exactly one browser module');
	assert.doesNotMatch(clientSource, /^export\s/mu, 'the client bundle must not use ES module exports');
	assert.doesNotMatch(clientSource, /^import\s/mu, 'the client bundle must not use ES module imports');
});

test('single ownership: dsh-locale-ja is the only ja owner', () => {
	const source = fs.readFileSync(path.join(packageDir, 'client.js'), 'utf8');
	assert.equal((source.match(/\.addLanguage\(/gu) ?? []).length, 1, 'client.js must own exactly one addLanguage call');
	assert.equal((source.match(/\.register\(/gu) ?? []).length, EXPECTED_NAMESPACES, 'client.js must register every namespace');
	assert.deepEqual(language, { id: 'ja', label: '日本語', fallback: 'en' });
	assert.deepEqual(inject, ['locale']);
	assert.equal(Object.keys(dictionaries).length, EXPECTED_NAMESPACES);

	const javascriptFiles = [];
	const walk = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === 'work' || entry.name === 'node_modules') continue;
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (entry.name.endsWith('.js')) javascriptFiles.push(file);
		}
	};
	walk(packageDir);
	const owners = javascriptFiles.filter((file) => fs.readFileSync(file, 'utf8').includes('addLanguage('));
	assert.deepEqual(owners.map((file) => path.relative(packageDir, file)), ['client.js']);

	// The mobile package used to own a three-namespace ja pack (#64). It must
	// now ship neither the registration nor the injected pack (#80).
	const mobileDir = path.resolve(packageDir, '..', 'dsh-mobile-maxxing');
	const mobileFiles = [
		'index.js',
		'client.js',
		'sw.js',
		...(fs.readdirSync(path.join(mobileDir, 'lib')).filter((file) => file.endsWith('.js')).map((file) => path.join('lib', file))),
		...(fs.readdirSync(path.join(mobileDir, 'notify')).filter((file) => file.endsWith('.js')).map((file) => path.join('notify', file))),
	];
	for (const file of mobileFiles) {
		const text = fs.readFileSync(path.join(mobileDir, file), 'utf8');
		assert.equal(text.includes('addLanguage('), false, 'mobile still registers a ja language: ' + file);
		assert.equal(text.includes('LOCALE_PACKS'), false, 'mobile still owns a locale pack: ' + file);
		assert.equal(text.includes('__RDSH_PWA_LOCALES__'), false, 'mobile still injects a locale pack: ' + file);
	}
	assert.equal(Object.keys(seedDictionaries()).length, 3, 'the immutable seed fixture must cover the three migrated namespaces');
});

test('apply registers all 65 dictionaries and every effect can dispose its registration', () => {
	const registered = new Map();
	const languages = [];
	const disposers = [];
	const { dictionaries: english } = loadEnglish(packageDir);
	const ctx = {
		effect(effect) {
			const dispose = effect();
			disposers.push(dispose);
			return dispose;
		},
		locale: {
			addLanguage(input) {
				languages.push({ ...input });
				registered.set('__language__', input);
				return () => registered.delete('__language__');
			},
			register(namespace, locale, dictionary) {
				assert.equal(registered.has(namespace), false, 'duplicate registration for ' + namespace);
				registered.set(namespace, dictionary);
				return () => {
					if (registered.get(namespace) === dictionary) registered.delete(namespace);
				};
			},
		},
	};
	apply(ctx);
	assert.equal(languages.length, 1);
	assert.deepEqual(languages[0], { id: 'ja', label: '日本語', fallback: 'en' });
	assert.equal(registered.size, EXPECTED_NAMESPACES + 1);
	assert.equal(disposers.length, EXPECTED_NAMESPACES + 1);
	for (const dispose of disposers) assert.equal(typeof dispose, 'function');
	for (const namespace of Object.keys(dictionaries)) {
		assert.equal(registered.has(namespace), true, 'missing registration for ' + namespace);
		assert.deepEqual(Object.keys(registered.get(namespace)), Object.keys(english[namespace]));
	}
	assert.equal(registered.has('common'), true);
	for (const dispose of disposers) dispose();
	assert.equal(registered.size, 0);
});

test('the 83 migrated values stay byte-for-byte equal to the immutable seed fixture', () => {
	assert.equal(seedFixture.schemaVersion, 1);
	assert.equal(seedFixture.namespaces, 3);
	assert.equal(seedFixture.keys, 83);
	assert.equal(seedHash(seedDictionaries()), seedFixture.sha256, 'the seed fixture changed after migration');

	const upstream = readJsonFile(path.join(packageDir, 'locale', 'upstream.json'));
	let total = 0;
	for (const [namespace, source] of Object.entries(seedDictionaries())) {
		const fileName = upstream.namespaces[namespace].fileName;
		const destination = readJsonFile(path.join(packageDir, 'locale', 'namespaces', 'ja', fileName));
		const destinationKeys = Object.keys(destination);
		const sourceKeys = Object.keys(source);
		assert.deepEqual(destinationKeys.filter((key) => Object.hasOwn(source, key)), sourceKeys, namespace + ' seed key order changed');
		for (const [key, value] of Object.entries(source)) {
			assert.equal(destination[key], value, namespace + '.' + key + ' changed');
			assert.equal(dictionaries[namespace][key], value, 'the generated client lost ' + namespace + '.' + key);
			total += 1;
		}
	}
	assert.equal(total, 83);
	// The old mobile pack is gone; this fixture, not a live import, is the evidence.
});

test('generated Japanese has en/ja key parity and status counts match the ja source files', () => {
	const { upstream, dictionaries: english } = loadEnglish(packageDir);
	const status = readJsonFile(path.join(packageDir, 'locale', 'translation-status.json'));
	let translated = 0;
	for (const [namespace, englishDictionary] of Object.entries(english)) {
		assert.deepEqual(Object.keys(dictionaries[namespace]), Object.keys(englishDictionary), namespace + ' is not in parity with English');
		const counts = status.namespaces[namespace];
		assert.equal(counts.keys, Object.keys(englishDictionary).length);
		const fileName = upstream.namespaces[namespace].fileName;
		const japaneseFile = path.join(packageDir, 'locale', 'namespaces', 'ja', fileName);
		const japanese = fs.existsSync(japaneseFile) ? readJsonFile(japaneseFile) : {};
		const sourceKeys = Object.keys(japanese);
		assert.equal(counts.translated, sourceKeys.length, namespace + ' translated count is wrong');
		assert.equal(counts.fallback, Object.keys(englishDictionary).length - sourceKeys.length, namespace + ' fallback count is wrong');
		for (const key of sourceKeys) {
			assert.equal(dictionaries[namespace][key], japanese[key], namespace + '.' + key + ' lost its reviewed value');
		}
		translated += counts.translated;
	}
	assert.equal(status.totals.translated, translated);
	assert.equal(status.totals.fallback, EXPECTED_KEYS - translated);
	assert.equal(status.status, status.totals.fallback === 0 ? 'complete' : 'incomplete');
	assert.equal(status.developmentOnlyEnglishFallback, status.totals.fallback > 0);

	const seedKeys = Object.values(seedDictionaries()).reduce((sum, dictionary) => sum + Object.keys(dictionary).length, 0);
	assert.ok(status.totals.translated >= seedKeys, 'the migrated seed values are not counted as translated');
});

test('an explicit incomplete fixture generates fallback keys and an incomplete status', (t) => {
	const directory = copyPackageLocale(t);
	const artifacts = buildArtifacts({ packageDir: directory });
	const status = artifacts.status;
	assert.equal(status.status, 'incomplete');
	assert.equal(status.developmentOnlyEnglishFallback, true);
	assert.equal(status.fallbackPolicy, 'development-only-english');
	assert.equal(status.totals.keys, EXPECTED_KEYS);
	assert.equal(status.totals.translated, 83);
	assert.equal(status.totals.fallback, EXPECTED_KEYS - 83);
	assert.equal(status.totals.translatedNamespaces, 3);
	assert.equal(status.totals.fallbackNamespaces, EXPECTED_NAMESPACES - 3);
	assert.match(artifacts.files['client.js'], /DEVELOPMENT-ONLY ENGLISH FALLBACK: 83 of 2915/);
	assert.doesNotMatch(artifacts.files['client.js'], /COMPLETE:/);
});

const KEEP_ENGLISH = [
	['command', 'token.compact'],
	['command', 'token.export'],
	['command', 'token.feedback'],
	['command', 'token.goal'],
	['command', 'token.permission'],
	['command', 'token.plan'],
	['settings.account', 'onboardingArtworkLocale'],
];

test('a complete 65-namespace ja fixture generates a complete status with zero fallback', (t) => {
	const directory = copyPackageWithoutJapanese(t);
	const { upstream, dictionaries: english } = loadEnglish(directory);
	const jaDirectory = path.join(directory, 'locale', 'namespaces', 'ja');
	fs.mkdirSync(jaDirectory, { recursive: true });
	for (const [namespace, dictionary] of Object.entries(english)) {
		const translated = {};
		for (const [key, value] of Object.entries(dictionary)) {
			const fullKey = namespace + '.' + key;
			if (KEEP_ENGLISH.some(([owner, name]) => owner === namespace && name === key)) {
				// Upstream control spellings have no ja alias; keep the English
				// execution token even in a complete catalog.
				translated[key] = value;
			} else if (fullKey === 'schedule.catalog.time.locale' || fullKey === 'schedule.manager.time.locale') {
				// Intl locale ids may be localized to ja/ja-JP, never left blank.
				translated[key] = 'ja-JP';
			} else if (value.trim() === '') {
				// Blank English values stay blank (intentional blank).
				translated[key] = value;
			} else {
				translated[key] = '【訳】' + value;
			}
		}
		writeJson(path.join(jaDirectory, upstream.namespaces[namespace].fileName), translated);
	}
	const artifacts = buildArtifacts({ packageDir: directory });
	const status = artifacts.status;
	assert.equal(status.status, 'complete');
	assert.equal(status.developmentOnlyEnglishFallback, false);
	assert.equal(status.totals.keys, EXPECTED_KEYS);
	assert.equal(status.totals.translated, EXPECTED_KEYS);
	assert.equal(status.totals.fallback, 0);
	assert.equal(status.totals.translatedNamespaces, EXPECTED_NAMESPACES);
	assert.equal(status.totals.fallbackNamespaces, 0);
	assert.equal(status.totals.partialNamespaces, 0);
	for (const counts of Object.values(status.namespaces)) {
		assert.equal(counts.status, 'translated');
		assert.equal(counts.fallback, 0);
	}
	const completeDictionaries = artifacts.dictionaries;
	for (const [namespace, key] of KEEP_ENGLISH) {
		assert.equal(completeDictionaries[namespace][key], english[namespace][key], namespace + '.' + key + ' lost its execution spelling');
	}
	assert.equal(completeDictionaries.chat['message.stepProcess.sharedPrefix'], '');
	assert.equal(completeDictionaries['schedule.catalog']['time.locale'], 'ja-JP');
	assert.equal(completeDictionaries['schedule.manager']['time.locale'], 'ja-JP');
	assert.match(artifacts.files['client.js'], /COMPLETE: all 2915 keys have a reviewed Japanese entry/);
	assert.doesNotMatch(artifacts.files['client.js'], /DEVELOPMENT-ONLY ENGLISH FALLBACK/);
	assert.doesNotMatch(status.note, /development-only/i);
});

test('execution tokens, artwork locale and Intl locale are intentionally not translated', () => {
	const english = loadEnglish(packageDir).dictionaries;
	for (const [namespace, key] of KEEP_ENGLISH) {
		assert.equal(dictionaries[namespace][key], english[namespace][key], namespace + '.' + key + ' must keep the English execution spelling');
	}
	assert.equal(english['settings.account'].onboardingArtworkLocale, 'en');
	assert.equal(dictionaries['settings.account'].onboardingArtworkLocale, 'en',
		'the artwork bundle only has en/zh assets');
	assert.equal(english.chat['message.stepProcess.sharedPrefix'], '');
	assert.equal(dictionaries.chat['message.stepProcess.sharedPrefix'], '',
		'the shared prefix must stay the same empty string as English');
	for (const namespace of ['schedule.catalog', 'schedule.manager']) {
		const value = dictionaries[namespace]['time.locale'];
		assert.equal(typeof value, 'string');
		assert.notEqual(value.trim(), '', namespace + ' time.locale must not be blank');
		assert.ok(
			value === english[namespace]['time.locale'] || value === 'ja' || value === 'ja-JP',
			namespace + ' time.locale must stay an Intl locale id (en in fallback, ja/ja-JP translated)',
		);
	}
});

test('placeholder preservation holds for every value and a broken placeholder is rejected', (t) => {
	const { dictionaries: english } = loadEnglish(packageDir);
	for (const namespace of Object.keys(english)) {
		for (const key of Object.keys(english[namespace])) {
			assert.deepEqual(placeholders(dictionaries[namespace][key]), placeholders(english[namespace][key]), namespace + '.' + key + ' placeholder mismatch');
		}
	}
	assert.throws(() => assertPlaceholders('fixture', 'key', 'hello {name}', 'hello {other}'), /placeholder/);

	const directory = copyPackageLocale(t);
	const japaneseFile = path.join(directory, 'locale', 'namespaces', 'ja', 'common.json');
	const japanese = readJsonFile(japaneseFile);
	japanese['copy.optionsHint'] = '右クリックでコピー方法を選択';
	writeJson(japaneseFile, japanese);
	assert.throws(() => buildArtifacts({ packageDir: directory }), /placeholder/);
});

test('duplicate JSON keys and duplicate translated values are checked', (t) => {
	assert.throws(() => parseStrictJson('{"a":"one","a":"two"}', 'duplicate.json'), /duplicate key/);
	assert.deepEqual(duplicateValueWarnings('settings', seedDictionaries().settings, loadEnglish(packageDir).dictionaries.settings), [], 'two keys with the same English value are not a duplicate-translation warning');
	assert.equal(duplicateValueWarnings('fixture', { left: '同じ', right: '同じ' }, { left: 'Left', right: 'Right' }).length, 1);
	const directory = copyPackageLocale(t);
	const japaneseFile = path.join(directory, 'locale', 'namespaces', 'ja', 'common.json');
	fs.writeFileSync(japaneseFile, '{\n  "ok": "確定",\n  "ok": "決定"\n}\n');
	assert.throws(() => buildArtifacts({ packageDir: directory }), /duplicate key/);
});

test('intentional blank values are accepted only where the English source is blank', (t) => {
	const { dictionaries: english } = loadEnglish(packageDir);
	const blankKeys = [];
	for (const [namespace, dictionary] of Object.entries(english)) {
		for (const [key, value] of Object.entries(dictionary)) {
			if (value.trim() === '') blankKeys.push(namespace + '.' + key);
		}
	}
	assert.deepEqual(blankKeys.sort(), [
		'chat.message.stepProcess.sharedPrefix',
		'pluginManager.sentenceSeparator',
		'schedule.catalog.cron.part.join',
		'schedule.manager.cron.part.join',
	]);
	assert.equal(isIntentionalBlank('', ''), true);
	assert.equal(isIntentionalBlank(' ', ''), true);
	assert.equal(isIntentionalBlank('\t', ' '), true);
	assert.equal(isIntentionalBlank('', 'Preparing tool calls'), false);
	assert.equal(isIntentionalBlank('保存', 'Save'), false);

	const directory = copyPackageLocale(t);
	const jaDirectory = path.join(directory, 'locale', 'namespaces', 'ja');
	writeJson(path.join(jaDirectory, 'chat.json'), { 'message.stepProcess.sharedPrefix': '' });
	writeJson(path.join(jaDirectory, 'schedule.manager.json'), { 'cron.part.join': ' ' });
	writeJson(path.join(jaDirectory, 'pluginManager.json'), { sentenceSeparator: '  ' });
	const artifacts = buildArtifacts({ packageDir: directory });
	assert.equal(artifacts.dictionaries.chat['message.stepProcess.sharedPrefix'], '');
	assert.equal(artifacts.dictionaries['schedule.manager']['cron.part.join'], ' ');
	assert.equal(artifacts.dictionaries.pluginManager.sentenceSeparator, '  ');

	const commonFile = path.join(jaDirectory, 'common.json');
	const common = readJsonFile(commonFile);
	const ordinaryKey = Object.keys(english.common).find((key) => english.common[key].trim() !== '');
	common[ordinaryKey] = '   ';
	writeJson(commonFile, common);
	assert.throws(() => buildArtifacts({ packageDir: directory }), /must not be blank unless the English source is blank/);
});

test('batch manifest covers every key once in 40-50 key chunks and hashes the source namespaces', () => {
	const document = readBatchFile(packageDir);
	const { upstream, dictionaries: english } = loadEnglish(packageDir);
	const batches = validateBatchManifest(document, upstream, english);
	assert.equal(batches.size, document.batches.length);
	assert.equal(document.totals.batches, document.batches.length);
	assert.equal(document.totals.keys, EXPECTED_KEYS);
	assert.equal(document.batches.flatMap((batch) => batch.keys).length, EXPECTED_KEYS);
	assert.equal(new Set(document.batches.flatMap((batch) => batch.keys.map((key) => batch.namespace + '\u0000' + key))).size, EXPECTED_KEYS);
	const grouped = new Map();
	for (const batch of document.batches) {
		assert.equal(batch.sourceHash, upstream.namespaces[batch.namespace].sourceHash);
		if (!grouped.has(batch.namespace)) grouped.set(batch.namespace, []);
		grouped.get(batch.namespace).push(batch);
	}
	for (const [namespace, group] of grouped) {
		const count = Object.keys(english[namespace]).length;
		if (count < BATCH_MIN) {
			assert.equal(group.length, 1, namespace + ' should stay in one small batch');
			assert.equal(group[0].keys.length, count);
		} else {
			for (const [index, batch] of group.entries()) {
				assert.equal(batch.keys.length <= BATCH_MAX, true, batch.id + ' exceeds the maximum');
				if (index < group.length - 1) assert.equal(batch.keys.length >= BATCH_MIN, true, batch.id + ' is below the minimum before the final chunk');
			}
		}
	}
});

test('merge applies only reviewed batches, preserves English, and ignores unreviewed outputs', (t) => {
	const directory = copyPackageLocale(t);
	const workDirectory = path.join(directory, 'work');
	fs.mkdirSync(path.join(workDirectory, 'out'), { recursive: true });
	const beforeEnglish = englishFileHashes(directory);
	const beforeJapanese = readJsonFile(path.join(directory, 'locale', 'namespaces', 'ja', 'common.json'));

	const output = makeOutput(directory, 'common-01');
	writeJson(path.join(workDirectory, 'out', 'common-01.json'), output);
	writeJson(path.join(workDirectory, 'out', 'approval-01.json'), makeOutput(directory, 'approval-01'));
	writeReviewed(workDirectory, { 'common-01': batchById(directory, 'common-01').sourceHash });

	const result = mergeReviewedBatches({ packageDir: directory, workDir: workDirectory });
	assert.deepEqual(result.applied, ['common-01']);
	assert.deepEqual(result.written, [path.join('locale', 'namespaces', 'ja', 'common.json')]);
	assert.equal(result.warnings.some((warning) => warning.includes('ignoring unreviewed output')), true);
	assert.deepEqual(readJsonFile(path.join(directory, 'locale', 'namespaces', 'ja', 'common.json')), output.values);
	assert.equal(fs.existsSync(path.join(directory, 'locale', 'namespaces', 'ja', 'approval.json')), false, 'an unreviewed output must not create a Japanese dictionary');
	assert.deepEqual(englishFileHashes(directory), beforeEnglish, 'merge must never change the English snapshot');
	assert.notDeepEqual(readJsonFile(path.join(directory, 'locale', 'namespaces', 'ja', 'common.json')), beforeJapanese);
});

test('merge is all-or-nothing when one reviewed batch is invalid', (t) => {
	const directory = copyPackageLocale(t);
	const workDirectory = path.join(directory, 'work');
	fs.mkdirSync(path.join(workDirectory, 'out'), { recursive: true });
	const beforeJapanese = readJsonFile(path.join(directory, 'locale', 'namespaces', 'ja', 'common.json'));
	writeJson(path.join(workDirectory, 'out', 'common-01.json'), makeOutput(directory, 'common-01'));
	writeJson(path.join(workDirectory, 'out', 'approval-01.json'), makeOutput(directory, 'approval-01', { omit: batchById(directory, 'approval-01').keys[0] }));
	writeReviewed(workDirectory, {
		'common-01': batchById(directory, 'common-01').sourceHash,
		'approval-01': batchById(directory, 'approval-01').sourceHash,
	});
	assert.throws(() => mergeReviewedBatches({ packageDir: directory, workDir: workDirectory }), /missing/);
	assert.deepEqual(readJsonFile(path.join(directory, 'locale', 'namespaces', 'ja', 'common.json')), beforeJapanese, 'a later validation failure must not leave an earlier batch applied');
});

test('merge accepts an intentional blank for blank English and rejects ordinary blanks atomically', (t) => {
	const directory = copyPackageLocale(t);
	const workDirectory = path.join(directory, 'work');
	fs.mkdirSync(path.join(workDirectory, 'out'), { recursive: true });
	const validId = 'schedule.manager-01';
	const validBatch = batchById(directory, validId);
	const validOutput = makeOutput(directory, validId);
	validOutput.values['cron.part.join'] = '  ';
	writeJson(path.join(workDirectory, 'out', validId + '.json'), validOutput);
	writeReviewed(workDirectory, { [validId]: validBatch.sourceHash });
	const result = mergeReviewedBatches({ packageDir: directory, workDir: workDirectory });
	assert.deepEqual(result.applied, [validId]);
	const merged = readJsonFile(path.join(directory, 'locale', 'namespaces', 'ja', 'schedule.manager.json'));
	assert.deepEqual(Object.keys(merged), validBatch.keys);
	assert.equal(merged['cron.part.join'], '  ');

	const invalidDirectory = copyPackageLocale(t);
	const invalidWork = path.join(invalidDirectory, 'work');
	fs.mkdirSync(path.join(invalidWork, 'out'), { recursive: true });
	const blankId = 'schedule.manager-01';
	const blankBatch = batchById(invalidDirectory, blankId);
	const blankOutput = makeOutput(invalidDirectory, blankId);
	blankOutput.values['cron.part.join'] = '';
	const chatId = 'chat-03';
	const chatBatch = batchById(invalidDirectory, chatId);
	const chatOutput = makeOutput(invalidDirectory, chatId);
	const ordinaryKey = chatBatch.keys.find((key) => key !== 'message.stepProcess.sharedPrefix');
	chatOutput.values[ordinaryKey] = ' ';
	writeJson(path.join(invalidWork, 'out', blankId + '.json'), blankOutput);
	writeJson(path.join(invalidWork, 'out', chatId + '.json'), chatOutput);
	writeReviewed(invalidWork, { [blankId]: blankBatch.sourceHash, [chatId]: chatBatch.sourceHash });
	assert.throws(
		() => mergeReviewedBatches({ packageDir: invalidDirectory, workDir: invalidWork }),
		/must not be blank unless the English source is blank/,
	);
	assert.equal(fs.existsSync(path.join(invalidDirectory, 'locale', 'namespaces', 'ja', 'schedule.manager.json')), false, 'an earlier valid batch must not be written when a later batch fails');
	assert.equal(fs.existsSync(path.join(invalidDirectory, 'locale', 'namespaces', 'ja', 'chat.json')), false);
});

test('merge rejects non-string values even for a blank English key', (t) => {
	const directory = copyPackageLocale(t);
	const workDirectory = path.join(directory, 'work');
	fs.mkdirSync(path.join(workDirectory, 'out'), { recursive: true });
	const id = 'schedule.manager-01';
	const batch = batchById(directory, id);
	const output = makeOutput(directory, id);
	output.values['cron.part.join'] = null;
	writeJson(path.join(workDirectory, 'out', id + '.json'), output);
	writeReviewed(workDirectory, { [id]: batch.sourceHash });
	assert.throws(() => mergeReviewedBatches({ packageDir: directory, workDir: workDirectory }), /must be a string/);
	assert.equal(fs.existsSync(path.join(directory, 'locale', 'namespaces', 'ja', 'schedule.manager.json')), false);
});

test('merge rejects stale source hashes and stale review hashes without writing', (t) => {
	const directory = copyPackageLocale(t);
	const workDirectory = path.join(directory, 'work');
	fs.mkdirSync(path.join(workDirectory, 'out'), { recursive: true });
	const before = readJsonFile(path.join(directory, 'locale', 'namespaces', 'ja', 'common.json'));

	writeJson(path.join(workDirectory, 'out', 'common-01.json'), makeOutput(directory, 'common-01', { sourceHash: 'sha256:' + '0'.repeat(64) }));
	writeReviewed(workDirectory, { 'common-01': batchById(directory, 'common-01').sourceHash });
	assert.throws(() => mergeReviewedBatches({ packageDir: directory, workDir: workDirectory }), /stale output/);
	assert.deepEqual(readJsonFile(path.join(directory, 'locale', 'namespaces', 'ja', 'common.json')), before);

	writeJson(path.join(workDirectory, 'out', 'common-01.json'), makeOutput(directory, 'common-01'));
	writeReviewed(workDirectory, { 'common-01': 'sha256:' + '1'.repeat(64) });
	assert.throws(() => mergeReviewedBatches({ packageDir: directory, workDir: workDirectory }), /stale review/);
	assert.deepEqual(readJsonFile(path.join(directory, 'locale', 'namespaces', 'ja', 'common.json')), before);
});

test('generated --check detects drift in a generated artifact', (t) => {
	const directory = copyPackageLocale(t);
	writeArtifacts(buildArtifacts({ packageDir: directory }));
	assert.deepEqual(checkArtifacts({ packageDir: directory }).problems, []);
	const clientFile = path.join(directory, 'client.js');
	fs.appendFileSync(clientFile, '// drift\n');
	const result = checkArtifacts({ packageDir: directory });
	assert.equal(result.problems.includes('different client.js; run node tools/build-client.mjs'), true);
});

test('work/ is gitignored and is not part of the shipped package files', () => {
	const manifest = readJsonFile(path.join(packageDir, 'package.json'));
	assert.equal(manifest.files.some((file) => file === 'work' || file.startsWith('work/')), false);
	assert.equal(Object.keys(manifest.exports).some((key) => key.includes('work')), false);
	for (const file of manifest.files) assert.equal(file.includes('work'), false, 'work must not be shipped: ' + file);
	const ignored = spawnSync('git', ['check-ignore', '-q', path.join('packages', 'dsh-locale-ja', 'work', 'out', 'probe.json')], { cwd: path.resolve(packageDir, '..', '..') });
	assert.equal(ignored.status, 0, 'work/out/probe.json must be ignored by git');
	const tracked = execFileSync('git', ['ls-files', 'packages/dsh-locale-ja/work'], { cwd: path.resolve(packageDir, '..', '..'), encoding: 'utf8' });
	assert.equal(tracked.trim(), '');
});
