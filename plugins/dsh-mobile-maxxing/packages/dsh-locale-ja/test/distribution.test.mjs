/**
 * Distribution and install smoke tests for the optional Japanese locale pack.
 *
 * These run without a DSH process and without a browser. They pack the real
 * package with npm, inspect the tarball, import the installed host half, and
 * materialize the installed browser half through the same
 * window.__ModuleLoader__.load({ id, factory }) registration DSH uses. They
 * prove that the package is a standalone, private, optional ja owner rather
 * than something the mobile tarball installs.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { LOCALE_REQUIREMENTS, localePublishDecision, tarballName } from '../../../scripts/pack-all.mjs';
import { loadClientModule } from './client-loader.mjs';

const packageDir = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(packageDir, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(packageDir, 'locale', 'package-meta.json'), 'utf8'));
const upstream = JSON.parse(fs.readFileSync(path.join(packageDir, 'locale', 'upstream.json'), 'utf8'));
const rootLicense = fs.readFileSync(path.join(repo, 'LICENSE'), 'utf8');

function temporaryDirectory(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locale-ja-dist-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function pack(t) {
	const destination = temporaryDirectory(t);
	execFileSync('npm', ['pack', '--pack-destination', destination], { cwd: packageDir, stdio: 'pipe' });
	const file = path.join(destination, tarballName(manifest));
	assert.equal(fs.existsSync(file), true, 'npm pack did not create the predictable tarball name');
	return { file, destination };
}

function tarballEntries(file) {
	return execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
}

test('the package is a separate, private web client with its own exports', () => {
	assert.equal(manifest.name, 'dsh-locale-ja');
	assert.equal(manifest.private, true, 'the package stays private until its actual release');
	assert.equal(manifest.type, 'module');
	assert.equal(manifest.description, meta.description, 'the generated description drifted from package-meta.json');
	assert.equal(manifest.dsh?.client?.platform, 'web', 'the locale pack must be usable on the web');
	assert.equal(manifest.dsh?.client?.immediately, true);
	assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
	assert.ok(manifest.files.includes('cordis.patch.yml'));
	assert.deepEqual(manifest.dsh?.client?.inject, ['@deepseek-ai/dsh-client-locale']);
	assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh-client-locale'], meta.clientLocalePeer);
	assert.equal(meta.clientLocalePeer, '0.2.1-rc.2 || 0.2.1-rc.3', 'both distribution channels must advertise the same peer range');
	assert.equal(manifest.exports?.['.'], './index.js');
	assert.equal(manifest.exports?.['./client'], './client.js');
	for (const target of Object.values(manifest.exports)) {
		if (typeof target === 'string' && !target.includes('*')) {
			assert.equal(fs.existsSync(path.join(packageDir, target)), true, 'export target is missing: ' + target);
		}
	}
	assert.doesNotMatch(JSON.stringify(manifest.dependencies ?? {}), /dsh-mobile-maxxing/,
		'the locale pack must not depend on or install the mobile package');
	assert.equal(manifest.files.some((entry) => entry === 'work' || entry.startsWith('work/')), false);
	assert.ok(manifest.files.includes('LICENSE'), 'the manifest must ship the package MIT license');
	assert.ok(manifest.files.includes('NOTICE'), 'the manifest must ship the upstream notice');

	// The mobile package is the optional consumer's neighbour, not its owner:
	// nothing silently installs or enables the locale pack.
	const rootManifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
	for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
		assert.equal(rootManifest[field]?.['dsh-locale-ja'], undefined, 'the root package silently depends on ' + field);
	}
	assert.doesNotMatch(fs.readFileSync(path.join(repo, 'cordis.patch.yml'), 'utf8'), /dsh-locale-ja/,
		'the mobile bundle silently enables the locale pack');
	assert.equal(rootManifest.files.some((entry) => entry.includes('dsh-locale-ja')), false,
		'the root file list ships the locale package');
});

test('the rename left one identity: dsh-locale-ja, and no old name in the tracked tree', () => {
	assert.equal(manifest.name, 'dsh-locale-ja');
	assert.equal(meta.name, manifest.name, 'the generated manifest and package-meta.json disagree');
	assert.equal(path.basename(packageDir), manifest.name, 'the directory name is the package name');
	assert.equal(manifest.repository?.directory, 'packages/dsh-locale-ja');
	assert.equal(manifest.homepage?.endsWith('/packages/dsh-locale-ja#readme'), true, 'the homepage points elsewhere');

	// The old name belongs to no live file. Spelled in parts so this guard is
	// itself not a hit; historical notes, if any, live outside this repository.
	const oldName = ['rdsh', 'locale', 'ja'].join('-');
	const tracked = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
	assert.equal(tracked.some((file) => file.startsWith('packages/' + oldName + '/')), false, 'the old package directory is still tracked');
	const offenders = tracked.filter((file) => fs.readFileSync(path.join(repo, file), 'utf8').includes(oldName));
	assert.deepEqual(offenders, [], 'the old package name survives in tracked files');
});

test('npm pack is a standalone install: no work directory and every export resolves', async (t) => {
	const { file } = pack(t);
	const entries = tarballEntries(file);
	for (const required of [
		'package/package.json',
		'package/index.js',
		'package/client.js',
		'package/cordis.patch.yml',
		'package/locale/translation-status.json',
		'package/locale/namespaces/en/common.json',
		'package/locale/namespaces/ja/common.json',
		'package/README.md',
	]) {
		assert.ok(entries.includes(required), 'the tarball is missing ' + required);
	}
	assert.deepEqual(entries.filter((entry) => /(^|\/)work(\/|$)/.test(entry)), [], 'work/ must not ship');
	assert.deepEqual(entries.filter((entry) => entry.includes('.gitignore')), []);

	const extracted = temporaryDirectory(t);
	execFileSync('tar', ['-xzf', file, '-C', extracted, '--strip-components=1'], { stdio: 'pipe' });
	assert.equal(fs.existsSync(path.join(extracted, 'work')), false, 'installing created a work directory');

	const installedManifest = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8'));
	for (const [subpath, target] of Object.entries(manifest.exports)) {
		assert.equal(installedManifest.exports[subpath], target, 'export changed during install: ' + subpath);
		const normalized = target.replace('./', '');
		if (!normalized.includes('*')) {
			assert.equal(fs.existsSync(path.join(extracted, normalized)), true, 'installed export target is missing: ' + target);
		}
	}

	const host = await import(pathToFileURL(path.join(extracted, 'index.js')).href);
	assert.equal(typeof host.apply, 'function');

	// The public ./client export is browser-only: the installed bytes must
	// register through the DSH loader, so evaluate them the way the Host does
	// instead of importing them as an ES module in bare Node.
	const client = loadClientModule(fs.readFileSync(path.join(extracted, 'client.js'), 'utf8'));
	assert.equal(client.registration.id, 'dsh-locale-ja');
	assert.deepEqual(Object.keys(client.registration).sort(), ['factory', 'id']);
	assert.equal(typeof client.registration.factory, 'function');
	assert.deepEqual(client.language, { id: 'ja', label: '日本語', fallback: 'en' });
	assert.deepEqual(client.inject, ['locale']);
	assert.equal(Object.keys(client.dictionaries).length, upstream.totals.namespaces);
	assert.equal(typeof client.apply, 'function');
});

test('npm pack carries the MIT terms and accurate upstream attribution', (t) => {
	const { file } = pack(t);
	const entries = tarballEntries(file);
	for (const required of ['package/LICENSE', 'package/NOTICE']) {
		assert.ok(entries.includes(required), 'the tarball is missing ' + required);
	}

	const extracted = temporaryDirectory(t);
	execFileSync('tar', ['-xzf', file, '-C', extracted, '--strip-components=1'], { stdio: 'pipe' });
	const installedManifest = JSON.parse(fs.readFileSync(path.join(extracted, 'package.json'), 'utf8'));
	assert.equal(installedManifest.license, 'MIT');

	// The shipped license is the repository MIT text plus the upstream snapshot's
	// copyright line: the permission notice and disclaimer stay byte-identical.
	const expectedLicense = rootLicense.replace(
		'Copyright (c) 2026 kuraneko1\n',
		'Copyright (c) 2026 kuraneko1\nCopyright (c) 2026 DeepSeek\n',
	);
	const license = fs.readFileSync(path.join(extracted, 'LICENSE'), 'utf8');
	assert.equal(license, expectedLicense, 'the packed LICENSE is not the repository MIT text plus the upstream copyright');

	const notice = fs.readFileSync(path.join(extracted, 'NOTICE'), 'utf8');
	assert.match(notice, /Copyright \(c\) 2026 DeepSeek/u, 'the upstream copyright holder is not named');
	for (const line of notice.split('\n').filter((entry) => entry.includes('Copyright'))) {
		assert.match(line, /Copyright \(c\) 2026 (?:kuraneko1|DeepSeek)/u, 'the notice invents or misattributes a copyright holder: ' + line);
	}
	// Every package recorded as an owner of the English snapshot is DeepSeek's,
	// which is what the notice claims; no third author is invented.
	for (const namespace of Object.values(upstream.namespaces)) {
		for (const owner of namespace.owners) assert.match(owner, /^@deepseek-ai\//u, 'the English snapshot has a non-DeepSeek owner: ' + owner);
	}
	assert.match(notice, /@deepseek-ai\/dsh-client-locale/u, 'the upstream locale package is not named');
	assert.ok(notice.includes(upstream.dsh.version), 'the notice does not name the snapshot version ' + upstream.dsh.version);
	assert.match(notice, /locale\/namespaces\/en\/\*\.json/u, 'the notice does not say which files are the English snapshot');
	assert.match(notice, /derivative translations/u, 'the notice does not mark the ja values as translations');
	assert.match(notice, /MIT License/u);
});

test('the installed client is the single ja owner and coexists/disposes cleanly', async (t) => {
	const { file } = pack(t);
	const extracted = temporaryDirectory(t);
	execFileSync('tar', ['-xzf', file, '-C', extracted, '--strip-components=1'], { stdio: 'pipe' });
	const source = fs.readFileSync(path.join(extracted, 'client.js'), 'utf8');
	const client = loadClientModule(source);
	assert.equal((source.match(/\.addLanguage\(/gu) ?? []).length, 1, 'exactly one owner must addLanguage(ja)');
	assert.doesNotMatch(source, /\.setLocale\(/, 'the locale pack must not set the shared language');
	assert.doesNotMatch(source, /dsh-mobile-maxxing/, 'the locale pack must not reach into the mobile package');

	const registered = new Map();
	const languages = [];
	const disposers = [];
	registered.set('foreign.namespace', { untouched: 'yes' });
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
				assert.equal(locale, 'ja');
				registered.set(namespace, dictionary);
				return () => {
					if (registered.get(namespace) === dictionary) registered.delete(namespace);
				};
			},
		},
	};
	client.apply(ctx);
	assert.equal(languages.length, 1);
	assert.deepEqual(languages[0], { id: 'ja', label: '日本語', fallback: 'en' });
	assert.equal(registered.size, 66 + 1, '65 dictionaries, one language and the foreign namespace');
	assert.equal(disposers.length, 66);
	for (const dispose of disposers) dispose();
	assert.deepEqual([...registered.keys()], ['foreign.namespace'], 'dispose removed a foreign registration');
	assert.equal(registered.get('foreign.namespace').untouched, 'yes');

	// A second activation (HMR / plugin reload) is clean too.
	client.apply(ctx);
	assert.equal(registered.size, 66 + 1);
	for (const dispose of disposers) dispose();
	assert.deepEqual([...registered.keys()], ['foreign.namespace'], 'a repeated dispose removed a foreign registration');
});

test('pack-all publishes the locale only for the complete 65/2915 zero-fallback status', () => {
	assert.deepEqual(LOCALE_REQUIREMENTS, { namespaces: 65, keys: 2915, fallback: 0 });
	const current = JSON.parse(fs.readFileSync(path.join(packageDir, 'locale', 'translation-status.json'), 'utf8'));
	const complete = {
		...current,
		status: 'complete',
		developmentOnlyEnglishFallback: false,
		totals: { ...current.totals, translated: 2915, fallback: 0 },
	};

	assert.equal(localePublishDecision(complete).publish, true);
	assert.equal(tarballName(manifest), `dsh-locale-ja-${manifest.version}.tgz`);

	assert.equal(current.status, current.totals.fallback === 0 ? 'complete' : 'incomplete');
	if (current.totals.fallback > 0) {
		const decision = localePublishDecision(current);
		assert.equal(decision.publish, false, 'an incomplete locale must not be packed');
		assert.match(decision.reason, /incomplete|fallback/);
	}
	assert.equal(localePublishDecision({ ...complete, totals: { ...complete.totals, translated: 2914, fallback: 1 } }).publish, false);
	assert.equal(localePublishDecision({ ...complete, totals: { ...complete.totals, keys: 2914 } }).publish, false);
	assert.equal(localePublishDecision({ ...complete, locale: 'zh' }).publish, false);
	assert.equal(localePublishDecision({ ...complete, developmentOnlyEnglishFallback: true }).publish, false);
	assert.equal(localePublishDecision(null).publish, false);
});
function isolatedRepo(t) {
	const destination = path.join(temporaryDirectory(t), 'fixture with spaces');
	fs.mkdirSync(destination);
	for (const entry of ['packages', 'scripts', 'tools', 'package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']) {
		fs.cpSync(path.join(repo, entry), path.join(destination, entry), { recursive: true });
	}
	return destination;
}

test('pack-all preserves unrelated dist files and publishes complete artifacts', (t) => {
	const copy = isolatedRepo(t);
	fs.mkdirSync(path.join(copy, 'dist'));
	fs.writeFileSync(path.join(copy, 'dist', 'keep.txt'), 'keep');
	const result = spawnSync('node', [path.join(copy, 'scripts', 'pack-all.mjs'), '--require-locale'], { cwd: copy, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.readFileSync(path.join(copy, 'dist', 'keep.txt'), 'utf8'), 'keep');
	assert.equal(fs.existsSync(path.join(copy, 'dist', tarballName(manifest))), true);
	assert.equal(fs.existsSync(path.join(copy, 'dist', tarballName(JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8'))))), true);
});

test('pack-all preserves old artifacts and docs when required locale is stale', (t) => {
	const copy = isolatedRepo(t);
	const dist = path.join(copy, 'dist');
	fs.mkdirSync(dist);
	for (const file of ['keep.txt', tarballName(manifest), 'dsh-mobile-maxxing-0.7.0.tgz']) fs.writeFileSync(path.join(dist, file), 'old artifact');
	const dictionary = path.join(copy, 'packages/dsh-locale-ja/locale/namespaces/ja/sidebarRight.json');
	fs.writeFileSync(dictionary, fs.readFileSync(dictionary, 'utf8').replace('その他のツール', '変更後の翻訳'));
	const readme = path.join(copy, 'README.md');
	const original = fs.readFileSync(readme, 'utf8') + '\nhttps://github.com/kuraneko1/dsh-mobile-maxxing/releases/download/v0.1.0/dsh-mobile-maxxing-0.1.0.tgz\n';
	fs.writeFileSync(readme, original);
	const result = spawnSync('node', [path.join(copy, 'scripts', 'pack-all.mjs'), '--require-locale'], { cwd: copy, encoding: 'utf8' });
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stdout, /REFUSED: dsh-locale-ja generated files are stale/);
	for (const file of ['keep.txt', tarballName(manifest), 'dsh-mobile-maxxing-0.7.0.tgz']) assert.equal(fs.readFileSync(path.join(dist, file), 'utf8'), 'old artifact');
	assert.equal(fs.readFileSync(readme, 'utf8'), original);
});
test('optional incomplete packing refuses to reuse a previous locale tarball', (t) => {
	const copy = isolatedRepo(t);
	const dist = path.join(copy, 'dist');
	fs.mkdirSync(dist);
	fs.writeFileSync(path.join(dist, tarballName(manifest)), 'old locale');
	const statusPath = path.join(copy, 'packages/dsh-locale-ja/locale/translation-status.json');
	const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
	status.status = 'incomplete';
	fs.writeFileSync(statusPath, JSON.stringify(status));
	const result = spawnSync('node', [path.join(copy, 'scripts', 'pack-all.mjs')], { cwd: copy, encoding: 'utf8' });
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stdout, /Existing locale artifacts in dist\/ were preserved/);
	assert.equal(fs.readFileSync(path.join(dist, tarballName(manifest)), 'utf8'), 'old locale');
});

test('pack-all refuses a directory where an artifact must be written', (t) => {
	const copy = isolatedRepo(t);
	const dist = path.join(copy, 'dist');
	fs.mkdirSync(dist);
	fs.writeFileSync(path.join(dist, 'dsh-mobile-maxxing-0.7.0.tgz'), 'old mobile');
	fs.mkdirSync(path.join(dist, tarballName(manifest)));
	const result = spawnSync('node', [path.join(copy, 'scripts', 'pack-all.mjs'), '--require-locale'], { cwd: copy, encoding: 'utf8' });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Refusing to replace a non-file/);
	assert.equal(fs.readFileSync(path.join(dist, 'dsh-mobile-maxxing-0.7.0.tgz'), 'utf8'), 'old mobile');
	assert.ok(fs.statSync(path.join(dist, tarballName(manifest))).isDirectory());
});

test('pack-all rolls back earlier artifacts when promotion fails', (t) => {
	const copy = isolatedRepo(t);
	const dist = path.join(copy, 'dist');
	fs.mkdirSync(dist);
	const files = ['dsh-mobile-maxxing-0.7.0.tgz', 'dsh-mobile-maxxing.tgz'];
	for (const file of files) fs.writeFileSync(path.join(dist, file), 'old ' + file);
	const preload = path.join(temporaryDirectory(t), 'fail-promotion.cjs');
	fs.writeFileSync(preload, `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const rename = fs.renameSync; let promotions = 0;
if (process.argv[1]?.endsWith('pack-all.mjs')) fs.renameSync = (from, to) => {
  if (String(from).includes('.dsh-pack-') && String(to).includes('/dist/') && ++promotions === 2) throw new Error('injected promotion failure');
  return rename(from, to);
};
syncBuiltinESMExports();`);
	const result = spawnSync('node', [path.join(copy, 'scripts', 'pack-all.mjs'), '--require-locale'], { cwd: copy, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--require=' + preload } });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /injected promotion failure/);
	for (const file of files) assert.equal(fs.readFileSync(path.join(dist, file), 'utf8'), 'old ' + file);
});

test('packed locale accepts the advertised rc.2 peer under strict resolution', (t) => {
	const { file } = pack(t);
	const dir = temporaryDirectory(t);
	const peer = path.join(dir, 'peer');
	fs.mkdirSync(peer);
	fs.writeFileSync(path.join(peer, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-locale', version: '0.2.1-rc.2' }));
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'locale-peer-test', version: '1.0.0', private: true, dependencies: { '@deepseek-ai/dsh-client-locale': 'file:./peer', 'dsh-locale-ja': 'file:' + file } }));
	const result = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--strict-peer-deps'], { cwd: dir, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
});

function releaseCommand(copy) {
	const readme = fs.readFileSync(path.join(copy, 'README.md'), 'utf8');
	const match = readme.match(/## リリース\n\n```sh\n([\s\S]*?)\n```/);
	assert.ok(match, 'the README must document the release command');
	return match[1];
}

function fakeReleaseCli(t) {
	const dir = temporaryDirectory(t);
	const executable = path.join(dir, 'gh');
	const log = path.join(dir, 'gh-args.json');
	fs.writeFileSync(executable, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.DSH_TEST_GH_LOG, JSON.stringify(process.argv.slice(2)))\n');
	fs.chmodSync(executable, 0o755);
	return { log, env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, DSH_TEST_GH_LOG: log } };
}

test('documented release attaches only current artifacts, not retained old tarballs', (t) => {
	const copy = isolatedRepo(t);
	const dist = path.join(copy, 'dist');
	fs.mkdirSync(dist);
	const old = path.join(dist, 'dsh-mobile-maxxing-0.0.1.tgz');
	fs.writeFileSync(old, 'keep old file');
	const fake = fakeReleaseCli(t);
	const result = spawnSync('bash', ['-c', releaseCommand(copy)], { cwd: copy, env: fake.env, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	const rootManifest = JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8'));
	const markdown = JSON.parse(fs.readFileSync(path.join(copy, 'packages/dsh-md-rendering/package.json'), 'utf8'));
	assert.deepEqual(JSON.parse(fs.readFileSync(fake.log, 'utf8')), [
		'release', 'create', 'v' + rootManifest.version,
		'dist/' + tarballName(rootManifest), 'dist/dsh-mobile-maxxing.tgz',
		'dist/' + tarballName(markdown), 'dist/' + tarballName(manifest),
	]);
	assert.equal(fs.readFileSync(old, 'utf8'), 'keep old file');
});

test('documented release does not run gh after locale validation fails', (t) => {
	const copy = isolatedRepo(t);
	const dictionary = path.join(copy, 'packages/dsh-locale-ja/locale/namespaces/ja/sidebarRight.json');
	fs.writeFileSync(dictionary, fs.readFileSync(dictionary, 'utf8').replace('その他のツール', '変更後の翻訳'));
	const fake = fakeReleaseCli(t);
	const result = spawnSync('bash', ['-c', releaseCommand(copy)], { cwd: copy, env: fake.env, encoding: 'utf8' });
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /REFUSED: dsh-locale-ja generated files are stale/);
	assert.equal(fs.existsSync(fake.log), false, 'gh must not run after a failed pack');
});

test('docs describe the optional local-tarball install and never a fake release asset', () => {
	const readme = fs.readFileSync(path.join(packageDir, 'README.md'), 'utf8');
	assert.doesNotMatch(readme, /releases\/download\/[^\s"']*dsh-locale-ja/, 'the unreleased locale must not link a release asset');
	assert.match(readme, /dsh plugin --profile web add \.\/dist\/dsh-locale-ja-0\.1\.1\.tgz/);
	assert.match(readme, /REFUSED/);
	assert.match(readme, /sole owner|only owner/i, 'the sole-owner migration must be explicit');
	const rootReadme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
	assert.doesNotMatch(rootReadme, /releases\/download\/[^\s"']*dsh-locale-ja/);
	const jaUsage = fs.readFileSync(path.join(repo, 'packages', 'dsh-mobile-maxxing', 'docs', 'USAGE.ja.md'), 'utf8');
	assert.doesNotMatch(jaUsage, /この端末では日本語も選べます/, 'the mobile docs still claim a built-in ja pack');
	const issueNotes = fs.readFileSync(path.join(repo, 'packages', 'dsh-mobile-maxxing', 'docs', 'ISSUES.md'), 'utf8');
	assert.match(issueNotes, /唯一の所有者/);
	assert.match(issueNotes, /REFUSED/);
});
