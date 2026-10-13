// Smoke-test the installed tgz through its public export in a consumer folder.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const consumer = resolve(process.argv[2]);
const require = createRequire(join(consumer, 'package.json'));
const entry = require.resolve('@jimoto-no-llm/rdsh-desktop-sdk');
const { createHarness, configureUpdater, desktopPaths, FEED_URL } = await import(pathToFileURL(entry));
const manifest = JSON.parse(await readFile(new URL('./package.json', pathToFileURL(entry)), 'utf8'));
assert.equal(manifest.dependencies['@deepseek-ai/dsh-sdk-client'], '0.2.1-alpha.2');
assert.match(await readFile(new URL('./index.d.ts', pathToFileURL(entry)), 'utf8'), /export function createHarness/);
const harness = createHarness({ sdkHome: join(consumer, 'synthetic-home'), cwd: consumer,
  dshBin: fileURLToPath(new URL('./fixtures/wire-runtime.mjs', import.meta.url)),
  provider: 'fixture-provider', model: 'fixture-model', initializeTimeoutMs: 5000, env: { node_options: '--synthetic-invalid-hook' } });
assert.equal(harness.client.options.env.node_options, undefined);
try { await harness.start(); assert.deepEqual(await harness.client.request('fixture/echo', { packageLoaded: true }), { packageLoaded: true }); }
finally { await harness.close(); }
const updater = { setFeedURL(feed) { assert.equal(feed.url, FEED_URL); } };
configureUpdater(updater); assert.equal(updater.channel, 'rdsh-desktop');
assert.equal(desktopPaths({ appData: consumer, resources: consumer }).home, join(consumer, 'rdsh-desktop', 'harness'));
console.log('PASS installed SDK tgz: public export, declarations, pinned dependency, real stdio request, cleanup and fork feed');
