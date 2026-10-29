#!/usr/bin/env node
/**
 * Generate the dsh-locale-ja package manifest, host entry, browser client,
 * batch manifest, and translation status from the committed JSON data.
 *
 * Stage 2 of #80. The English snapshot is read-only here. Japanese source files
 * contain only reviewed values; untranslated keys become development-only
 * English fallbacks in the generated client and are counted in
 * locale/translation-status.json.
 *
 * Usage:
 *   node tools/build-client.mjs
 *   node tools/build-client.mjs --check
 *   node tools/build-client.mjs --package-dir /tmp/dsh-locale-ja
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DEFAULT_PACKAGE_DIR,
	buildArtifacts,
	checkArtifacts,
	writeArtifacts,
} from './locale-data.mjs';

export { buildArtifacts, checkArtifacts, writeArtifacts };

function parseArguments(argv) {
	const options = { check: false, packageDir: DEFAULT_PACKAGE_DIR, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--check') options.check = true;
		else if (argument === '--package-dir') {
			const value = argv[index + 1];
			if (value === undefined) throw new Error('--package-dir requires a path');
			options.packageDir = path.resolve(value);
			index += 1;
		} else if (argument === '--help' || argument === '-h') options.help = true;
		else throw new Error('unknown argument "' + argument + '"; see --help');
	}
	return options;
}

function printHelp() {
	console.log([
		'Usage: node tools/build-client.mjs [options]',
		'',
		'Reads locale/upstream.json, locale/package-meta.json,',
		'locale/namespaces/en/*.json and locale/namespaces/ja/*.json, then writes:',
		'  package.json, index.js, client.js,',
		'  locale/batches.json, locale/translation-status.json',
		'',
		'Options:',
		'  --check             Compare the generated files with the committed copies.',
		'  --package-dir <path> Package directory (default: packages/dsh-locale-ja).',
		'  --help              Show this help.',
	].join('\n'));
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const options = parseArguments(process.argv.slice(2));
		if (options.help) {
			printHelp();
		} else if (options.check) {
			const result = checkArtifacts({ packageDir: options.packageDir });
			for (const warning of result.warnings) console.warn('warning: ' + warning);
			if (result.problems.length > 0) {
				console.error('dsh-locale-ja generated files are out of date:');
				for (const problem of result.problems) console.error('  - ' + problem);
				process.exitCode = 1;
			} else {
				const totals = result.artifacts.status.totals;
				console.log('dsh-locale-ja generated files are up to date: ' + totals.namespaces + ' namespaces, ' + totals.keys + ' keys, ' + totals.translated + ' translated, ' + totals.fallback + ' development-only English fallbacks');
			}
		} else {
			const artifacts = buildArtifacts({ packageDir: options.packageDir });
			for (const warning of artifacts.warnings) console.warn('warning: ' + warning);
			const written = writeArtifacts(artifacts);
			const totals = artifacts.status.totals;
			console.log('wrote ' + written.length + ' generated files to ' + path.relative(process.cwd(), options.packageDir) + ': ' + totals.namespaces + ' namespaces, ' + totals.keys + ' keys, ' + totals.translated + ' translated, ' + totals.fallback + ' development-only English fallbacks, ' + artifacts.batches.totals.batches + ' batches');
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
