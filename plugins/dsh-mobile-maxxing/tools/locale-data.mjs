/**
 * Shared data model and validation for the dsh-locale-ja stage-2 pipeline.
 *
 * The English snapshot (stage 1 of #80) is the source of keys and English
 * values. The Japanese source files hold only reviewed translations; every
 * key absent from them is generated as a development-only English fallback so
 * the package can register a complete dictionary for all 65 namespaces
 * without claiming a translation that does not exist.
 *
 * Nothing in this module writes the English snapshot. The only writes are the
 * generated package artifacts and (in merge-batches) the Japanese dictionaries.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PACKAGE_DIR = path.join(REPO_ROOT, 'packages', 'dsh-locale-ja');
export const LANGUAGE = Object.freeze({ id: 'ja', label: '日本語', fallback: 'en' });
export const EXPECTED_NAMESPACES = 65;
export const EXPECTED_KEYS = 2915;
export const BATCH_MIN = 40;
export const BATCH_MAX = 50;
export const STATUS_SCHEMA = 1;
export const BATCH_SCHEMA = 1;

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu;

/** @param {unknown} value */
export function jsonText(value) {
	return JSON.stringify(value, null, 2) + '\n';
}

/** @param {string | Buffer} value */
export function sha256(value) {
	return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value */
export function canonicalJson(value) {
	if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
	if (value !== null && typeof value === 'object') {
		return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
	}
	return JSON.stringify(value);
}

/** Hash used by stage 1's upstream.json for each dictionary. @param {Record<string, unknown>} dictionary */
export function dictionaryHash(dictionary) {
	return sha256(canonicalJson(dictionary) + '\n');
}

/**
 * Parse JSON without the duplicate-key silent overwrite of JSON.parse.
 * The dictionaries and batch files are review inputs, so a duplicated key is
 * a hard error rather than "the last value wins".
 *
 * @param {string} text
 * @param {string} [file]
 * @returns {unknown}
 */
export function parseStrictJson(text, file = '<json>') {
	let index = 0;
	const fail = (/** @type {string} */ message) => {
		throw new Error(file + ': ' + message + ' at offset ' + index);
	};
	const skipWhitespace = () => {
		while (index < text.length && /[\t\n\r ]/u.test(text[index])) index += 1;
	};
	const parseString = () => {
		const start = index;
		index += 1;
		while (index < text.length) {
			const character = text[index];
			if (character === '\\') {
				index += 2;
				continue;
			}
			if (character === '"') {
				index += 1;
				try {
					return JSON.parse(text.slice(start, index));
				} catch {
					fail('invalid string');
				}
			}
			index += 1;
		}
		fail('unterminated string');
	};
	const parseNumber = () => {
		const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index));
		if (match === null) fail('invalid number');
		index += match[0].length;
		return Number(match[0]);
	};
	const parseValue = () => {
		skipWhitespace();
		const character = text[index];
		if (character === '"') return parseString();
		if (character === '{') return parseObject();
		if (character === '[') return parseArray();
		if (text.startsWith('true', index)) {
			index += 4;
			return true;
		}
		if (text.startsWith('false', index)) {
			index += 5;
			return false;
		}
		if (text.startsWith('null', index)) {
			index += 4;
			return null;
		}
		if (character === '-' || (character >= '0' && character <= '9')) return parseNumber();
		fail('unexpected token');
	};
	const parseObject = () => {
		index += 1;
		const value = {};
		const keys = new Set();
		skipWhitespace();
		if (text[index] === '}') {
			index += 1;
			return value;
		}
		for (;;) {
			skipWhitespace();
			if (text[index] !== '"') fail('expected an object key');
			const key = parseString();
			if (keys.has(key)) fail('duplicate key ' + JSON.stringify(key));
			keys.add(key);
			skipWhitespace();
			if (text[index] !== ':') fail('expected : after ' + JSON.stringify(key));
			index += 1;
			const entry = parseValue();
			Object.defineProperty(value, key, { value: entry, enumerable: true, writable: true, configurable: true });
			skipWhitespace();
			if (text[index] === ',') {
				index += 1;
				continue;
			}
			if (text[index] === '}') {
				index += 1;
				return value;
			}
			fail('expected , or }');
		}
	};
	const parseArray = () => {
		index += 1;
		const value = [];
		skipWhitespace();
		if (text[index] === ']') {
			index += 1;
			return value;
		}
		for (;;) {
			value.push(parseValue());
			skipWhitespace();
			if (text[index] === ',') {
				index += 1;
				continue;
			}
			if (text[index] === ']') {
				index += 1;
				return value;
			}
			fail('expected , or ]');
		}
	};
	const value = parseValue();
	skipWhitespace();
	if (index !== text.length) fail('trailing data');
	return value;
}

/** @param {string} file */
export function readJsonFile(file) {
	return parseStrictJson(fs.readFileSync(file, 'utf8'), file);
}

/** @param {string} file */
export function readFlatDictionary(file) {
	const value = readJsonFile(file);
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(file + ': dictionary must be a JSON object');
	}
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== 'string') throw new Error(file + ': ' + JSON.stringify(key) + ' must be a string');
	}
	return value;
}

/** @param {string} packageDir */
export function localePaths(packageDir = DEFAULT_PACKAGE_DIR) {
	const localeDir = path.join(packageDir, 'locale');
	return {
		packageDir,
		localeDir,
		upstreamFile: path.join(localeDir, 'upstream.json'),
		metaFile: path.join(localeDir, 'package-meta.json'),
		enDir: path.join(localeDir, 'namespaces', 'en'),
		jaDir: path.join(localeDir, 'namespaces', 'ja'),
		batchesFile: path.join(localeDir, 'batches.json'),
		statusFile: path.join(localeDir, 'translation-status.json'),
		workDir: path.join(packageDir, 'work'),
	};
}

/** @param {string} value */
export function placeholders(value) {
	return [...value.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]).sort();
}

/**
 * @param {string} namespace
 * @param {string} key
 * @param {string} japanese
 * @param {string} english
 */
export function assertPlaceholders(namespace, key, japanese, english) {
	const actual = placeholders(japanese);
	const expected = placeholders(english);
	if (actual.join('\u0000') !== expected.join('\u0000')) {
		throw new Error(
			namespace + '.' + key + ' changes placeholders: expected ' +
			(expected.length === 0 ? 'none' : expected.join(', ')) + ', got ' +
			(actual.length === 0 ? 'none' : actual.join(', ')),
		);
	}
}

/**
 * A blank Japanese value is intentional only where the English source is
 * blank too. Some English values are separators or join strings ("", " "),
 * not text, so a blank translation keeps the rendered output unchanged.
 * Blank values for ordinary English text are still missing translations.
 *
 * @param {string} japanese
 * @param {string} english
 */
export function isIntentionalBlank(japanese, english) {
	return japanese.trim() === '' && english.trim() === '';
}

/** @param {any} upstream */
export function validateUpstream(upstream) {
	if (upstream === null || typeof upstream !== 'object' || Array.isArray(upstream)) throw new Error('locale/upstream.json must be an object');
	if (upstream.schemaVersion !== 1) throw new Error('locale/upstream.json has an unsupported schemaVersion');
	const namespaces = upstream.namespaces;
	if (namespaces === null || typeof namespaces !== 'object' || Array.isArray(namespaces)) throw new Error('locale/upstream.json must contain namespaces');
	const entries = Object.entries(namespaces);
	if (entries.length !== EXPECTED_NAMESPACES) throw new Error('locale/upstream.json must contain exactly ' + EXPECTED_NAMESPACES + ' namespaces');
	let keys = 0;
	for (const [namespace, entry] of entries) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(namespace + ': invalid upstream entry');
		if (typeof entry.fileName !== 'string' || entry.fileName === '' || path.basename(entry.fileName) !== entry.fileName || !entry.fileName.endsWith('.json')) {
			throw new Error(namespace + ': invalid fileName');
		}
		if (!Array.isArray(entry.owners) || entry.owners.length !== 1 || typeof entry.owners[0] !== 'string') {
			throw new Error(namespace + ': exactly one owning package is required');
		}
		if (typeof entry.sourceHash !== 'string' || !entry.sourceHash.startsWith('sha256:')) throw new Error(namespace + ': missing sourceHash');
		if (!entry.keyCounts || !Number.isInteger(entry.keyCounts.en) || entry.keyCounts.en <= 0) throw new Error(namespace + ': invalid key count');
		if (!entry.dictionaryHashes || typeof entry.dictionaryHashes.en !== 'string') throw new Error(namespace + ': missing English dictionary hash');
		keys += entry.keyCounts.en;
	}
	if (keys !== EXPECTED_KEYS) throw new Error('locale/upstream.json must contain exactly ' + EXPECTED_KEYS + ' English keys (found ' + keys + ')');
	if (!upstream.totals || upstream.totals.namespaces !== EXPECTED_NAMESPACES || upstream.totals.keys !== EXPECTED_KEYS) {
		throw new Error('locale/upstream.json totals do not match the required ' + EXPECTED_NAMESPACES + ' namespaces / ' + EXPECTED_KEYS + ' keys snapshot');
	}
	return upstream;
}

/**
 * Load and verify the committed English snapshot.
 * @param {string} [packageDir]
 */
export function loadEnglish(packageDir = DEFAULT_PACKAGE_DIR) {
	const paths = localePaths(packageDir);
	const upstream = validateUpstream(readJsonFile(paths.upstreamFile));
	const dictionaries = {};
	let count = 0;
	const expectedFiles = new Set();
	for (const [namespace, entry] of Object.entries(upstream.namespaces)) {
		expectedFiles.add(entry.fileName);
		const file = path.join(paths.enDir, entry.fileName);
		if (!fs.existsSync(file)) throw new Error('missing English dictionary ' + path.relative(packageDir, file));
		const dictionary = readFlatDictionary(file);
		if (Object.keys(dictionary).length !== entry.keyCounts.en) {
			throw new Error(namespace + ': English dictionary has ' + Object.keys(dictionary).length + ' keys, upstream.json says ' + entry.keyCounts.en);
		}
		const actualHash = dictionaryHash(dictionary);
		if (actualHash !== entry.dictionaryHashes.en) throw new Error(namespace + ': English dictionary hash does not match upstream.json; re-run the stage-1 extractor');
		dictionaries[namespace] = dictionary;
		count += Object.keys(dictionary).length;
	}
	if (count !== EXPECTED_KEYS) throw new Error('English snapshot must contain exactly ' + EXPECTED_KEYS + ' keys');
	if (fs.existsSync(paths.enDir)) {
		for (const file of fs.readdirSync(paths.enDir)) {
			if (file.endsWith('.json') && !expectedFiles.has(file)) throw new Error('stale English dictionary ' + file + '; re-run the stage-1 extractor');
		}
	}
	return { upstream, dictionaries, paths };
}

/** @param {string} namespace @param {Record<string, string>} dictionary @param {Record<string, string>} english */
export function duplicateValueWarnings(namespace, dictionary, english) {
	const groups = new Map();
	for (const [key, value] of Object.entries(dictionary)) {
		if (!groups.has(value)) groups.set(value, []);
		groups.get(value).push(key);
	}
	const warnings = [];
	for (const [value, keys] of groups) {
		if (keys.length < 2) continue;
		const englishValues = new Set(keys.map((key) => english[key]));
		if (englishValues.size > 1) {
			warnings.push(namespace + ': duplicate Japanese value ' + JSON.stringify(value) + ' for ' + keys.join(', '));
		}
	}
	return warnings;
}

/**
 * Load reviewed Japanese translations. Files are optional per namespace; a
 * missing namespace is a development-only English fallback, not an error.
 *
 * @param {any} upstream
 * @param {Record<string, Record<string, string>>} english
 * @param {string} [packageDir]
 */
export function loadJapanese(upstream, english, packageDir = DEFAULT_PACKAGE_DIR) {
	const paths = localePaths(packageDir);
	const dictionaries = {};
	const warnings = [];
	if (!fs.existsSync(paths.jaDir)) return { dictionaries, warnings, paths };
	const byFileName = new Map(Object.entries(upstream.namespaces).map(([namespace, entry]) => [entry.fileName, namespace]));
	for (const file of fs.readdirSync(paths.jaDir).sort()) {
		if (!file.endsWith('.json')) continue;
		const namespace = byFileName.get(file);
		if (namespace === undefined) throw new Error('stale Japanese dictionary ' + file + ' (no matching upstream namespace)');
		const dictionary = readFlatDictionary(path.join(paths.jaDir, file));
		for (const [key, value] of Object.entries(dictionary)) {
			if (!Object.hasOwn(english[namespace], key)) throw new Error(namespace + '.' + key + ': Japanese dictionary has a key that is not in English');
			if (value.trim() === '' && !isIntentionalBlank(value, english[namespace][key])) {
				throw new Error(namespace + '.' + key + ': Japanese value must not be blank unless the English source is blank');
			}
			assertPlaceholders(namespace, key, value, english[namespace][key]);
		}
		dictionaries[namespace] = dictionary;
		warnings.push(...duplicateValueWarnings(namespace, dictionary, english[namespace]));
	}
	return { dictionaries, warnings, paths };
}

/**
 * Chunk the upstream keys into 40-50 key batches where a namespace is large
 * enough, one shorter batch for namespaces below the minimum. A namespace is
 * never split across two batch files, so a worker owns one namespace per file.
 *
 * @param {any} upstream
 * @param {Record<string, Record<string, string>>} english
 */
export function buildBatches(upstream, english) {
	const batches = [];
	for (const [namespace, entry] of Object.entries(upstream.namespaces)) {
		const keys = Object.keys(english[namespace]);
		if (keys.length !== entry.keyCounts.en) throw new Error(namespace + ': English key count changed while building batches');
		const chunkCount = Math.max(1, Math.ceil(keys.length / BATCH_MAX));
		const chunkSize = Math.max(BATCH_MIN, Math.ceil(keys.length / chunkCount));
		for (let start = 0, index = 1; start < keys.length; start += chunkSize, index += 1) {
			batches.push({
				id: namespace + '-' + String(index).padStart(2, '0'),
				namespace,
				sourceHash: entry.sourceHash,
				keys: keys.slice(start, start + chunkSize),
			});
		}
	}
	const ids = new Set();
	const seen = new Set();
	for (const batch of batches) {
		if (ids.has(batch.id)) throw new Error('duplicate batch id ' + batch.id);
		ids.add(batch.id);
		for (const key of batch.keys) {
			const token = batch.namespace + '\u0000' + key;
			if (seen.has(token)) throw new Error('key appears in more than one batch: ' + batch.namespace + '.' + key);
			seen.add(token);
		}
	}
	if (seen.size !== EXPECTED_KEYS) throw new Error('batch manifest does not cover all English keys');
	return {
		schemaVersion: BATCH_SCHEMA,
		locale: LANGUAGE.id,
		snapshotLocale: 'en',
		dsh: upstream.dsh,
		chunking: { min: BATCH_MIN, max: BATCH_MAX },
		totals: { namespaces: EXPECTED_NAMESPACES, keys: EXPECTED_KEYS, batches: batches.length },
		batches,
	};
}

/** @param {any} upstream @param {Record<string, Record<string, string>>} english @param {Record<string, Record<string, string>>} japanese */
export function buildStatus(upstream, english, japanese) {
	const namespaces = {};
	const totals = { namespaces: 0, keys: 0, translated: 0, fallback: 0, translatedNamespaces: 0, fallbackNamespaces: 0, partialNamespaces: 0 };
	for (const [namespace, entry] of Object.entries(upstream.namespaces)) {
		const englishKeys = Object.keys(english[namespace]);
		const translated = Object.keys(japanese[namespace] ?? {}).length;
		const fallback = englishKeys.length - translated;
		const status = translated === 0 ? 'fallback' : fallback === 0 ? 'translated' : 'partial';
		namespaces[namespace] = {
			sourceHash: entry.sourceHash,
			keys: englishKeys.length,
			translated,
			fallback,
			status,
		};
		totals.namespaces += 1;
		totals.keys += englishKeys.length;
		totals.translated += translated;
		totals.fallback += fallback;
		if (status === 'translated') totals.translatedNamespaces += 1;
		else if (status === 'fallback') totals.fallbackNamespaces += 1;
		else totals.partialNamespaces += 1;
	}
	if (totals.namespaces !== EXPECTED_NAMESPACES || totals.keys !== EXPECTED_KEYS) throw new Error('translation status does not match the snapshot totals');
	return {
		schemaVersion: STATUS_SCHEMA,
		locale: LANGUAGE.id,
		status: totals.fallback === 0 ? 'complete' : 'incomplete',
		developmentOnlyEnglishFallback: totals.fallback > 0,
		fallbackPolicy: 'development-only-english',
		note: totals.fallback === 0
			? 'Every key has a reviewed Japanese entry; no value is an English fallback.'
			: 'Values without a reviewed Japanese entry repeat the English snapshot verbatim. They are development-only fallbacks, not translations.',
		dsh: upstream.dsh,
		totals,
		namespaces,
	};
}

/** @param {Record<string, string>} dictionary @param {number} level */
function renderDictionary(dictionary, level) {
	const pad = '\t'.repeat(level);
	const entries = Object.entries(dictionary);
	if (entries.length === 0) return '{}';
	return '{\n' + entries.map(([key, value]) => pad + '\t' + JSON.stringify(key) + ': ' + JSON.stringify(value) + ',').join('\n') + '\n' + pad + '}';
}

/** @param {Record<string, Record<string, string>>} dictionaries @param {any} status */
export function renderClient(dictionaries, status) {
	const total = status.totals;
	const lines = [];
	lines.push('/**');
	lines.push(' * dsh-locale-ja — generated client half. Do not edit by hand.');
	lines.push(' *');
	lines.push(' * Generated by tools/build-client.mjs from locale/upstream.json,');
	lines.push(' * locale/namespaces/en/*.json and locale/namespaces/ja/*.json.');
	lines.push(' *');
	if (total.fallback === 0) {
		lines.push(' * COMPLETE: all ' + total.keys + ' keys have a reviewed Japanese entry.');
		lines.push(' * No value is an English fallback.');
	} else {
		lines.push(' * DEVELOPMENT-ONLY ENGLISH FALLBACK: ' + total.translated + ' of ' + total.keys + ' values are Japanese.');
		lines.push(' * The other ' + total.fallback + ' repeat the English snapshot verbatim so every one of the');
		lines.push(' * ' + total.namespaces + ' namespaces can register a complete dictionary. They are not translations.');
	}
	lines.push(' * See locale/translation-status.json for the per-namespace split.');
	lines.push(' *');
	lines.push(' * Browser bundle, not an ES module: DSH concatenates plugin client files');
	lines.push(' * verbatim into a classic <script> batch, so this file only registers a lazy');
	lines.push(' * factory with window.__ModuleLoader__.load({ id, factory }). The loader');
	lines.push(' * materializes the factory once on first import and uses the returned');
	lines.push(' * { inject, apply }; language and dictionaries ride along as metadata.');
	lines.push(' */');
	lines.push('');
	lines.push('window.__ModuleLoader__.load({');
	lines.push('\tid: "dsh-locale-ja",');
	lines.push('\tfactory(require) {');
	lines.push('\t\tvar module = { exports: {} };');
	lines.push('\t\tvar exports = module.exports;');
	lines.push('\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });');
	lines.push('');
	lines.push('\t\tconst language = Object.freeze(' + JSON.stringify(LANGUAGE) + ');');
	lines.push('');
	lines.push('\t\tconst dictionaries = Object.freeze({');
	for (const [namespace, dictionary] of Object.entries(dictionaries)) {
		lines.push('\t\t\t' + JSON.stringify(namespace) + ': Object.freeze(' + renderDictionary(dictionary, 3) + '),');
	}
	lines.push('\t\t});');
	lines.push('');
	lines.push('\t\tconst inject = ["locale"];');
	lines.push('');
	lines.push('\t\t/**');
	lines.push('\t\t * DSH 0.2.2 and later define ja, with their own ja dictionaries, before the');
	lines.push('\t\t * locale service is provided. Defining the language or a ja dictionary a');
	lines.push('\t\t * second time throws, so this pack owns ja only while nothing else has');
	lines.push('\t\t * defined it (DSH 0.2.1-rc.2 / rc.3). Locale ids compare case-insensitively.');
	lines.push('\t\t */');
	lines.push('\t\tfunction japaneseIsDefined(locale) {');
	lines.push('\t\t\treturn locale.getSnapshot().locales.some((definition) => definition.id.toLowerCase() === language.id);');
	lines.push('\t\t}');
	lines.push('');
	lines.push('\t\tfunction apply(ctx) {');
	lines.push('\t\t\tif (japaneseIsDefined(ctx.locale)) return;');
	lines.push('\t\t\tctx.effect(() => ctx.locale.addLanguage(language), "dsh-locale-ja: addLanguage(ja)");');
	for (const namespace of Object.keys(dictionaries)) {
		const entry = status.namespaces[namespace];
		lines.push('');
		lines.push('\t\t\t// ' + namespace + ': ' + entry.translated + '/' + entry.keys + ' translated, ' + entry.fallback + ' development-only English fallback' + (entry.fallback === 1 ? '' : 's') + '.');
		lines.push('\t\t\tctx.effect(() => ctx.locale.register(' + JSON.stringify(namespace) + ', "ja", dictionaries[' + JSON.stringify(namespace) + ']), "dsh-locale-ja: ' + namespace + '");');
	}
	lines.push('\t\t}');
	lines.push('');
	lines.push('\t\texports.language = language;');
	lines.push('\t\texports.dictionaries = dictionaries;');
	lines.push('\t\texports.inject = inject;');
	lines.push('\t\texports.apply = apply;');
	lines.push('');
	lines.push('\t\treturn module.exports;');
	lines.push('\t},');
	lines.push('});');
	return lines.join('\n') + '\n';
}

/** @param {any} meta */
export function renderIndex(meta) {
	return [
		'/**',
		' * ' + meta.name + ' — generated host entry. Do not edit by hand.',
		' *',
		' * The host half is intentionally empty: this is a pure browser plugin. The',
		' * locale dictionaries and addLanguage/register calls live in ./client.js,',
		' * discovered through package.json dsh.client and exports["./client"].',
		' */',
		'export function apply() {}',
		'',
	].join('\n');
}

/** @param {any} meta @param {any} upstream */
export function renderManifest(meta, upstream) {
	const exportedFiles = [
		'index.js',
		'client.js',
		'locale/upstream.json',
		'locale/batches.json',
		'locale/translation-status.json',
		'locale/namespaces/en/*.json',
		'locale/namespaces/ja/*.json',
		'README.md',
		'LICENSE',
		'NOTICE',
		'cordis.patch.yml',
	];
	const manifest = {
		name: meta.name,
		version: meta.version,
		private: meta.private !== false,
		type: 'module',
		description: meta.description,
		license: meta.license ?? 'MIT',
		exports: {
			'.': './index.js',
			'./client': './client.js',
			'./locale/upstream.json': './locale/upstream.json',
			'./locale/batches.json': './locale/batches.json',
			'./locale/translation-status.json': './locale/translation-status.json',
			'./locale/namespaces/en/*.json': './locale/namespaces/en/*.json',
			'./locale/namespaces/ja/*.json': './locale/namespaces/ja/*.json',
		},
		files: exportedFiles,
		scripts: { test: 'node --test test/*.test.mjs' },
		engines: { node: meta.nodeEngine ?? '>=22' },
		dsh: {
			client: {
				platform: 'web',
				immediately: true,
				inject: ['@deepseek-ai/dsh-client-locale'],
			},
			bundle: { patch: './cordis.patch.yml' },
		},
	};
	if (meta.author !== undefined) manifest.author = meta.author;
	if (meta.keywords !== undefined) manifest.keywords = meta.keywords;
	if (meta.repository !== undefined) manifest.repository = meta.repository;
	if (meta.homepage !== undefined) manifest.homepage = meta.homepage;
	if (meta.bugs !== undefined) manifest.bugs = meta.bugs;
	if (upstream.dsh && typeof upstream.dsh.version === 'string') manifest.peerDependencies = { '@deepseek-ai/dsh-client-locale': meta.clientLocalePeer ?? upstream.dsh.version };
	return jsonText(manifest);
}

/** @param {any} meta */
export function validateMeta(meta) {
	if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('locale/package-meta.json must be an object');
	if (typeof meta.name !== 'string' || meta.name === '') throw new Error('locale/package-meta.json: name is required');
	if (typeof meta.version !== 'string' || meta.version === '') throw new Error('locale/package-meta.json: version is required');
	if (typeof meta.description !== 'string' || meta.description === '') throw new Error('locale/package-meta.json: description is required');
	if (meta.clientLocalePeer !== undefined && (typeof meta.clientLocalePeer !== 'string' || !meta.clientLocalePeer.trim())) throw new Error('locale/package-meta.json: clientLocalePeer must be a nonempty string');
	return meta;
}

/**
 * Build every generated file in memory.
 * @param {{ packageDir?: string }} [options]
 */
export function buildArtifacts(options = {}) {
	const packageDir = path.resolve(options.packageDir ?? DEFAULT_PACKAGE_DIR);
	const { upstream, dictionaries: english, paths } = loadEnglish(packageDir);
	const meta = validateMeta(readJsonFile(paths.metaFile));
	const { dictionaries: japanese, warnings } = loadJapanese(upstream, english, packageDir);
	const batches = buildBatches(upstream, english);
	const status = buildStatus(upstream, english, japanese);
	const dictionaries = {};
	for (const namespace of Object.keys(upstream.namespaces)) {
		const dictionary = {};
		for (const [key, englishValue] of Object.entries(english[namespace])) {
			dictionary[key] = Object.hasOwn(japanese[namespace] ?? {}, key) ? japanese[namespace][key] : englishValue;
		}
		dictionaries[namespace] = dictionary;
	}
	const files = {
		'package.json': renderManifest(meta, upstream),
		'index.js': renderIndex(meta),
		'client.js': renderClient(dictionaries, status),
		'locale/batches.json': jsonText(batches),
		'locale/translation-status.json': jsonText(status),
	};
	return { packageDir, paths, upstream, english, japanese, dictionaries, batches, status, files, warnings };
}

/** Write the generated files. Never touches the English snapshot or Japanese sources. */
export function writeArtifacts(artifacts) {
	const written = [];
	for (const [relative, content] of Object.entries(artifacts.files)) {
		const file = path.join(artifacts.packageDir, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		written.push(file);
	}
	return written;
}

/** Compare generated files in memory with the committed copies. */
export function checkArtifacts(options = {}) {
	const artifacts = buildArtifacts(options);
	const problems = [];
	for (const [relative, expected] of Object.entries(artifacts.files)) {
		const file = path.join(artifacts.packageDir, relative);
		if (!fs.existsSync(file)) {
			problems.push('missing ' + relative);
			continue;
		}
		if (fs.readFileSync(file, 'utf8') !== expected) problems.push('different ' + relative + '; run node tools/build-client.mjs');
	}
	return { problems, warnings: artifacts.warnings, artifacts };
}

/**
 * Validate a committed batch manifest against the English snapshot.
 * @param {any} document
 * @param {any} upstream
 * @param {Record<string, Record<string, string>>} english
 */
export function validateBatchManifest(document, upstream, english) {
	if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error('locale/batches.json must be an object');
	if (document.schemaVersion !== BATCH_SCHEMA) throw new Error('locale/batches.json has an unsupported schemaVersion');
	if (document.locale !== LANGUAGE.id) throw new Error('locale/batches.json must target ja');
	if (!Array.isArray(document.batches)) throw new Error('locale/batches.json must contain batches');
	if (!document.totals || document.totals.namespaces !== EXPECTED_NAMESPACES || document.totals.keys !== EXPECTED_KEYS || document.totals.batches !== document.batches.length) {
		throw new Error('locale/batches.json totals are stale; run node tools/build-client.mjs');
	}
	const byId = new Map();
	const perNamespace = new Map();
	const seen = new Set();
	for (const batch of document.batches) {
		if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) throw new Error('locale/batches.json: invalid batch entry');
		if (typeof batch.id !== 'string' || batch.id === '') throw new Error('locale/batches.json: batch id is required');
		if (byId.has(batch.id)) throw new Error('locale/batches.json: duplicate batch id ' + batch.id);
		byId.set(batch.id, batch);
		const entry = upstream.namespaces[batch.namespace];
		if (entry === undefined) throw new Error(batch.id + ': unknown namespace ' + batch.namespace);
		if (batch.sourceHash !== entry.sourceHash) throw new Error(batch.id + ': stale sourceHash; run node tools/build-client.mjs');
		if (!Array.isArray(batch.keys) || batch.keys.length === 0) throw new Error(batch.id + ': keys must be a non-empty array');
		if (!perNamespace.has(batch.namespace)) perNamespace.set(batch.namespace, []);
		perNamespace.get(batch.namespace).push(batch);
		for (const key of batch.keys) {
			if (typeof key !== 'string' || key === '') throw new Error(batch.id + ': invalid key');
			if (!Object.hasOwn(english[batch.namespace], key)) throw new Error(batch.id + ': unknown English key ' + key);
			const token = batch.namespace + '\u0000' + key;
			if (seen.has(token)) throw new Error(batch.namespace + '.' + key + ' appears in more than one batch');
			seen.add(token);
		}
	}
	for (const [namespace, batches] of perNamespace) {
		const expectedKeys = Object.keys(english[namespace]);
		const actualKeys = batches.flatMap((batch) => batch.keys);
		if (actualKeys.length !== expectedKeys.length || new Set(actualKeys).size !== expectedKeys.length) {
			throw new Error(namespace + ': batch manifest does not cover the namespace key set');
		}
		for (const key of expectedKeys) if (!actualKeys.includes(key)) throw new Error(namespace + ': batch manifest is missing ' + key);
		if (expectedKeys.length < BATCH_MIN) {
			if (batches.length !== 1 || batches[0].keys.length !== expectedKeys.length) throw new Error(namespace + ': small namespaces must stay in one batch');
		} else {
			batches.forEach((batch, index) => {
				if (index < batches.length - 1 && (batch.keys.length < BATCH_MIN || batch.keys.length > BATCH_MAX)) {
					throw new Error(batch.id + ': chunks must be ' + BATCH_MIN + '-' + BATCH_MAX + ' keys except the final chunk');
				}
				if (batch.keys.length > BATCH_MAX) throw new Error(batch.id + ': a batch cannot exceed ' + BATCH_MAX + ' keys');
			});
		}
	}
	if (seen.size !== EXPECTED_KEYS) throw new Error('locale/batches.json does not cover all ' + EXPECTED_KEYS + ' English keys');
	return byId;
}
