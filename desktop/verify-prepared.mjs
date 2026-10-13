// Validate generated source using the upstream's actual pure release helpers.
// No Electron launch, account/config access, model calls or publication.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { contentHash, FEED_URL, PATCH_PATHS } from './overlay.mjs';
import { prepare } from './prepare.mjs';

const root = resolve(process.argv[2] || '');
assert.equal(lstatSync(join(root, '.rdsh-fork.json')).isSymbolicLink(), false);
assert.ok(lstatSync(join(root, '.rdsh-fork.json')).size < 65536);
const state = JSON.parse(readFileSync(join(root, '.rdsh-fork.json'), 'utf8'));
const native = Object.keys(state.outputs).find(path => /^apps\/desktop\/rdsh-build-assets\/rdsh(?:\.exe)?$/.test(path));
assert.ok(native);
assert.deepEqual(Object.keys(state.outputs).sort(), [...PATCH_PATHS, 'apps/desktop/rdsh-bootstrap.cjs', 'apps/desktop/rdsh-build.json', native].sort());
for (const [path, hash] of Object.entries(state.outputs)) assert.equal(contentHash(readFileSync(join(root, path))), hash);
const modules = resolve('desktop/sdk/node_modules');
const helpers = resolve('target/desktop-sdk-verify/helpers');
mkdirSync(helpers, { recursive: true });
if (!existsSync(join(helpers, 'node_modules'))) symlinkSync(modules, join(helpers, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
for (const name of ['desktop-build-version.mjs', 'macos-app-update-config.mjs']) writeFileSync(join(helpers, name), readFileSync(join(root, 'apps/desktop/scripts', name)));
const versions = await import(pathToFileURL(join(helpers, 'desktop-build-version.mjs')));
assert.equal(versions.resolveDesktopBuildVersion({}, '0.2.1-alpha.2'), state.rdshVersion);
assert.equal(versions.validateDesktopBuildVersion(state.rdshVersion, '0.2.1-alpha.2'), state.rdshVersion);
const mac = await import(pathToFileURL(join(helpers, 'macos-app-update-config.mjs')));
const feed = mac.resolveMacOSAppUpdateFeed([{ provider: 'generic', url: FEED_URL, channel: 'rdsh-desktop' }]);
assert.equal(feed.publicUrl, FEED_URL);
assert.throws(() => mac.resolveMacOSAppUpdateFeed([{ provider: 'generic', url: FEED_URL, channel: 'nightly' }]));
new vm.Script(readFileSync(join(root, 'apps/desktop/rdsh-bootstrap.cjs'), 'utf8'));
const { transform } = await import('../tests/e2e/node_modules/esbuild/lib/main.js');
for (const path of PATCH_PATHS.filter(path => /\.(mjs|ts)$/.test(path))) await transform(readFileSync(join(root, path), 'utf8'), { loader: path.endsWith('.ts') ? 'ts' : 'js', platform: 'node', target: 'node24' });
assert.equal(prepare({ checkout: root, rdshBin: join(root, native) }).unchanged, true);
const bootstrap = join(root, 'apps/desktop/rdsh-bootstrap.cjs');
const before = readFileSync(bootstrap, 'utf8');
try {
  writeFileSync(bootstrap, before + '\n// synthetic local edit\n');
  assert.throws(() => prepare({ checkout: root, rdshBin: join(root, native) }), /local changes/);
} finally { writeFileSync(bootstrap, before); }
console.log('PASS prepared official source: Rust/Harness dual identity, dedicated macOS feed, bootstrap syntax, overlay transpilation and file hashes');
