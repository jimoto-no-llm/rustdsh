#!/usr/bin/env node
/**
 * Atomically merge human-reviewed translation batches into the Japanese
 * dictionaries. Stage 2 of #80.
 *
 * A worker writes only work/out/<batch>.json. A reviewer records the exact
 * batch sourceHash in work/reviewed.json:
 *
 *   {
 *     "schemaVersion": 1,
 *     "reviewed": { "common-01": "sha256:..." }
 *   }
 *
 * This tool accepts only batches named in that ledger. It validates every
 * reviewed output against locale/batches.json and the English snapshot before
 * writing anything, writes only locale/namespaces/ja/*.json, and restores the
 * original files if a rename fails. The English snapshot is never a write
 * target.
 *
 * Usage:
 *   node tools/merge-batches.mjs
 *   node tools/merge-batches.mjs --check
 *   node tools/merge-batches.mjs --package-dir /tmp/dsh-locale-ja --work-dir /tmp/work
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DEFAULT_PACKAGE_DIR,
	assertPlaceholders,
	duplicateValueWarnings,
	isIntentionalBlank,
	jsonText,
	loadEnglish,
	loadJapanese,
	localePaths,
	readJsonFile,
	validateBatchManifest,
} from './locale-data.mjs';

const REVIEW_SCHEMA = 1;
const OUTPUT_SCHEMA = 1;

/** @param {any} reviewed */
function validateReviewLedger(reviewed, file) {
	if (reviewed === null || typeof reviewed !== 'object' || Array.isArray(reviewed)) throw new Error(file + ': review ledger must be an object');
	if (reviewed.schemaVersion !== REVIEW_SCHEMA) throw new Error(file + ': unsupported review schemaVersion');
	if (reviewed.reviewed === null || typeof reviewed.reviewed !== 'object' || Array.isArray(reviewed.reviewed)) {
		throw new Error(file + ': reviewed must be an object mapping batch ids to source hashes');
	}
	for (const [id, sourceHash] of Object.entries(reviewed.reviewed)) {
		if (typeof sourceHash !== 'string' || !sourceHash.startsWith('sha256:')) {
			throw new Error(file + ': reviewed batch ' + JSON.stringify(id) + ' needs a sha256 sourceHash');
		}
	}
	return reviewed.reviewed;
}

/** @param {string} directory */
function listOutputBatches(directory) {
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory)
		.filter((file) => file.endsWith('.json'))
		.map((file) => file.slice(0, -'.json'.length))
		.sort();
}

/** @param {Record<string, string>} before @param {Record<string, string>} after */
function sameKeys(before, after) {
	const left = Object.keys(before).sort();
	const right = Object.keys(after).sort();
	return left.length === right.length && left.every((key, index) => key === right[index]);
}

/**
 * Validate and apply reviewed batches.
 * @param {{ packageDir?: string, workDir?: string, check?: boolean }} [options]
 */
export function mergeReviewedBatches(options = {}) {
	const packageDir = path.resolve(options.packageDir ?? DEFAULT_PACKAGE_DIR);
	const workDir = path.resolve(options.workDir ?? path.join(packageDir, 'work'));
	const paths = localePaths(packageDir);
	const { upstream, dictionaries: english } = loadEnglish(packageDir);
	const batchDocument = readJsonFile(paths.batchesFile);
	const batches = validateBatchManifest(batchDocument, upstream, english);
	const { dictionaries: currentJapanese, warnings } = loadJapanese(upstream, english, packageDir);

	const reviewFile = path.join(workDir, 'reviewed.json');
	if (!fs.existsSync(reviewFile)) {
		throw new Error('no reviewed batches: ' + path.relative(packageDir, reviewFile) + ' is missing');
	}
	const reviewed = validateReviewLedger(readJsonFile(reviewFile), path.relative(packageDir, reviewFile));
	const reviewedIds = Object.keys(reviewed);
	if (reviewedIds.length === 0) throw new Error('no reviewed batches: reviewed.json is empty');

	const outputDir = path.join(workDir, 'out');
	for (const id of listOutputBatches(outputDir)) {
		if (!Object.hasOwn(reviewed, id)) warnings.push('ignoring unreviewed output ' + path.join(path.relative(packageDir, outputDir), id + '.json'));
	}

	const updates = new Map();
	const applied = [];
	for (const id of reviewedIds) {
		const batch = batches.get(id);
		if (batch === undefined) throw new Error('reviewed batch ' + JSON.stringify(id) + ' is not in locale/batches.json');
		const reviewHash = reviewed[id];
		if (reviewHash !== batch.sourceHash) {
			throw new Error('stale review for ' + id + ': reviewed ' + reviewHash + ', batch now requires ' + batch.sourceHash);
		}
		const outputFile = path.join(outputDir, id + '.json');
		if (!fs.existsSync(outputFile)) throw new Error('reviewed batch ' + id + ' has no output at ' + path.relative(packageDir, outputFile));
		const output = readJsonFile(outputFile);
		if (output === null || typeof output !== 'object' || Array.isArray(output)) throw new Error(id + ': output must be an object');
		if (output.schemaVersion !== OUTPUT_SCHEMA) throw new Error(id + ': unsupported output schemaVersion');
		if (output.batch !== id) throw new Error(id + ': output.batch is ' + JSON.stringify(output.batch) + ', expected ' + JSON.stringify(id));
		if (output.namespace !== batch.namespace) throw new Error(id + ': output.namespace is ' + JSON.stringify(output.namespace) + ', expected ' + JSON.stringify(batch.namespace));
		if (output.sourceHash !== batch.sourceHash) {
			throw new Error('stale output for ' + id + ': output has ' + JSON.stringify(output.sourceHash) + ', batch requires ' + batch.sourceHash);
		}
		if (output.values === null || typeof output.values !== 'object' || Array.isArray(output.values)) throw new Error(id + ': output.values must be an object');
		if (!sameKeys(output.values, Object.fromEntries(batch.keys.map((key) => [key, ''])))) {
			const missing = batch.keys.filter((key) => !Object.hasOwn(output.values, key));
			const extra = Object.keys(output.values).filter((key) => !batch.keys.includes(key));
			throw new Error(id + ': output values must cover exactly the batch keys' + (missing.length ? '; missing ' + missing.join(', ') : '') + (extra.length ? '; extra ' + extra.join(', ') : ''));
		}
		if (!updates.has(batch.namespace)) updates.set(batch.namespace, new Map());
		const target = updates.get(batch.namespace);
		for (const key of batch.keys) {
			const value = output.values[key];
			const englishValue = english[batch.namespace][key];
			if (typeof value !== 'string') throw new Error(id + ': ' + batch.namespace + '.' + key + ' must be a string');
			if (value.trim() === '' && !isIntentionalBlank(value, englishValue)) {
				throw new Error(id + ': ' + batch.namespace + '.' + key + ' must not be blank unless the English source is blank');
			}
			assertPlaceholders(batch.namespace, key, value, englishValue);
			if (target.has(key) && target.get(key) !== value) throw new Error(id + ': conflicting reviewed values for ' + batch.namespace + '.' + key);
			target.set(key, value);
		}
		applied.push(id);
	}

	const nextJapanese = {};
	for (const [namespace, dictionary] of Object.entries(currentJapanese)) {
		nextJapanese[namespace] = { ...dictionary };
	}
	for (const [namespace, target] of updates) {
		nextJapanese[namespace] ??= {};
		for (const [key, value] of target) nextJapanese[namespace][key] = value;
	}
	for (const [namespace, dictionary] of Object.entries(nextJapanese)) {
		for (const [key, value] of Object.entries(dictionary)) {
			if (!Object.hasOwn(english[namespace], key)) throw new Error(namespace + '.' + key + ': reviewed value is not an English key');
			assertPlaceholders(namespace, key, value, english[namespace][key]);
		}
		warnings.push(...duplicateValueWarnings(namespace, dictionary, english[namespace]));
	}

	const writes = [];
	for (const namespace of updates.keys()) {
		const file = path.join(paths.jaDir, namespace + '.json');
		const temporary = path.join(paths.jaDir, '.' + namespace + '.json.tmp-' + process.pid + '-' + writes.length);
		writes.push({ namespace, file, temporary, content: jsonText(nextJapanese[namespace]) });
	}
	const jaPrefix = paths.jaDir + path.sep;
	for (const write of writes) {
		if (!write.file.startsWith(jaPrefix) || path.extname(write.file) !== '.json') throw new Error('refusing to write outside the Japanese dictionaries: ' + write.file);
	}
	if (options.check) return { applied, written: [], warnings, updates: Object.fromEntries([...updates].map(([namespace, values]) => [namespace, Object.fromEntries(values)])) };

	const backups = new Map();
	const renamed = [];
	try {
		fs.mkdirSync(paths.jaDir, { recursive: true });
		for (const write of writes) {
			backups.set(write.file, fs.existsSync(write.file) ? fs.readFileSync(write.file) : null);
			fs.writeFileSync(write.temporary, write.content);
		}
		for (const write of writes) {
			fs.renameSync(write.temporary, write.file);
			renamed.push(write.file);
		}
	} catch (error) {
		for (const write of writes) {
			if (fs.existsSync(write.temporary)) fs.rmSync(write.temporary, { force: true });
		}
		for (const file of renamed) {
			const backup = backups.get(file);
			if (backup === null) fs.rmSync(file, { force: true });
			else fs.writeFileSync(file, backup);
		}
		throw new Error('could not commit the reviewed batches; restored the previous Japanese files: ' + (error instanceof Error ? error.message : String(error)));
	}

	return {
		applied,
		written: writes.map((write) => path.relative(packageDir, write.file)),
		warnings,
		updates: Object.fromEntries([...updates].map(([namespace, values]) => [namespace, Object.fromEntries(values)])),
	};
}

function parseArguments(argv) {
	const options = { check: false, packageDir: DEFAULT_PACKAGE_DIR, workDir: null, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--check') options.check = true;
		else if (argument === '--package-dir') {
			const value = argv[index + 1];
			if (value === undefined) throw new Error('--package-dir requires a path');
			options.packageDir = path.resolve(value);
			index += 1;
		} else if (argument === '--work-dir') {
			const value = argv[index + 1];
			if (value === undefined) throw new Error('--work-dir requires a path');
			options.workDir = path.resolve(value);
			index += 1;
		} else if (argument === '--help' || argument === '-h') options.help = true;
		else throw new Error('unknown argument "' + argument + '"; see --help');
	}
	return options;
}

function printHelp() {
	console.log([
		'Usage: node tools/merge-batches.mjs [options]',
		'',
		'Reads work/reviewed.json and work/out/<batch>.json, validates each reviewed',
		'batch against locale/batches.json and the English snapshot, then writes only',
		'locale/namespaces/ja/*.json. Unreviewed outputs are ignored; stale hashes,',
		'missing keys, bad placeholders and empty values abort with no changes.',
		'',
		'Options:',
		'  --check              Validate reviewed batches without writing.',
		'  --package-dir <path> Package directory (default: packages/dsh-locale-ja).',
		'  --work-dir <path>    Work directory (default: <package>/work).',
		'  --help               Show this help.',
		'',
		'Review ledger format:',
		'  { "schemaVersion": 1, "reviewed": { "<batch-id>": "<sourceHash>" } }',
	].join('\n'));
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const options = parseArguments(process.argv.slice(2));
		if (options.help) {
			printHelp();
		} else {
			const result = mergeReviewedBatches(options);
			for (const warning of result.warnings) console.warn('warning: ' + warning);
			const summary = 'reviewed batches: ' + result.applied.length + ' (' + result.applied.join(', ') + ')';
			if (options.check) console.log(summary + '; validation passed, no files written');
			else console.log(summary + '; wrote ' + result.written.length + ' Japanese dictionaries');
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
