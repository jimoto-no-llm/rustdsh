import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const installer = await readFile(join(repo, 'plugins', 'install.sh'), 'utf8');
const catalog = JSON.parse(
  await readFile(join(repo, 'src', 'plugin_catalog.json'), 'utf8'));

// The catalog is compiled into the binary, so a release install can report and
// repair a profile without the checkout. It only stays useful while it names
// exactly what plugins/install.sh installs: this test is that contract. It
// exists because the essential tier lived only in the script, which nothing
// runs by itself, so an upgraded install silently missed every essential
// package.

const upstream = installer.match(/PKGS="\n([\s\S]*?)"\n/)[1]
  .split('\n').map((line) => line.trim()).filter(Boolean);
const bundled = installer.match(/ESSENTIAL_BUNDLED="([^"]*)"/)[1]
  .split(/\s+/).filter(Boolean);
// An essential bundle is added either under a profile condition (Web-only) or
// under a feature switch (installed whenever that switch is off). The catalog
// records both, so the parser keeps them apart instead of calling every
// appended name Web-only.
const webOnly = [...installer.matchAll(
  /if \[ "\$PROFILE" = "web" \]; then\n\s*ESSENTIAL_BUNDLED="\$ESSENTIAL_BUNDLED ([\w.-]+)"/g)]
  .map((match) => match[1]);
// The shell helper name maps to the feature id by dropping its suffix:
// `feedback_feature_off` gates the bundle on `features.feedback`.
const featureGated = new Map(
  [...installer.matchAll(
    /if (\w+)_feature_off; then\n\s*ESSENTIAL_BUNDLED="\$ESSENTIAL_BUNDLED ([\w.-]+)"/g)]
    .map((match) => [match[2], match[1]]));
const recommendedBundled = new Map(
  [...installer.matchAll(/if \[ "\$rec_(\w+)" = "1" \]; then RECOMMENDED_BUNDLED="\$RECOMMENDED_BUNDLED ([\w.-]+)"; fi/g)]
    .map((match) => [match[1], match[2]]));
const recommendedThirdParty = new Map(
  [...installer.matchAll(/if \[ "\$rec_(\w+)" = "1" \]; then\s*\n\s*run_add (github:\S+)/g)]
    .map((match) => [match[1], match[2]]));
const starter = new Set(
  [...installer.match(/recommended_starter\(\) \{\n([^}]*)\}/)[1]
    .matchAll(/rec_(\w+)=1/g)].map((match) => match[1]));
const starterProfiles = installer.match(/case "\$PROFILE" in ([\w|]+)\)/)[1].split('|');
const recommendedIds = installer.match(/RECOMMENDED_IDS="([^"]*)"/)[1].split(' ');

// Feature ids come from the compiled table, so a bundle gated on a switch that
// `rdsh features` does not list fails here instead of at install time.
const rustConfig = await readFile(join(repo, 'src', 'rdsh_config.rs'), 'utf8');
const features = new Set(
  [...rustConfig.match(/pub const FEATURES: &\[FeatureDef\] = &\[([\s\S]*?)\n\];/)[1]
    .matchAll(/id: "([^"]+)"/g)].map((match) => match[1]));

const normalize = (id) => id.replace(/-/g, '_');
const catalogEssential = catalog.essential;
const catalogRecommended = catalog.recommended;

test('the essential tier matches plugins/install.sh', () => {
  assert.deepEqual(catalogEssential.filter((e) => !e.bundled).map((e) => e.package), upstream);

  const expectedBundled = [...bundled, ...webOnly, ...featureGated.keys()];
  assert.deepEqual(catalogEssential.filter((e) => e.bundled).map((e) => e.package), expectedBundled);

  for (const name of webOnly) {
    const entry = catalogEssential.find((e) => e.package === name);
    assert.deepEqual(entry.profiles, ['web'], name + ' is Web-only in install.sh');
  }
  for (const name of bundled) {
    const entry = catalogEssential.find((e) => e.package === name);
    assert.equal(entry.profiles, undefined, name + ' is installed on every profile');
  }
  // A feature-gated bundle is added on every profile, so it carries no
  // `profiles` list; it records the switch it depends on instead, and that
  // id must be one `rdsh features` actually knows.
  for (const [name, feature] of featureGated) {
    const entry = catalogEssential.find((e) => e.package === name);
    assert.equal(entry.profiles, undefined, name + ' is installed on every profile');
    assert.equal(entry.feature, feature, name + ' records the wrong feature switch');
    assert.ok(features.has(feature), 'rdsh does not know feature ' + feature);
  }
  for (const entry of catalogEssential.filter((e) => e.bundled && e.feature)) {
    assert.ok(featureGated.has(entry.package),
      'install.sh does not gate ' + entry.package + ' on features.' + entry.feature);
  }
});

test('the recommended ids match plugins/install.sh', () => {
  assert.deepEqual(catalogRecommended.map((e) => e.id), recommendedIds);

  for (const entry of catalogRecommended) {
    const key = normalize(entry.id);
    const spec = recommendedBundled.get(key) ?? recommendedThirdParty.get(key);
    assert.ok(spec, 'install.sh does not install recommended id ' + entry.id);
    assert.equal(spec, entry.package, entry.id + ' spec differs');
    assert.equal(Boolean(entry.bundled), recommendedBundled.has(key),
      entry.id + ' bundled flag differs');
  }
  for (const key of [...recommendedBundled.keys(), ...recommendedThirdParty.keys()]) {
    assert.ok(catalogRecommended.some((e) => normalize(e.id) === key),
      'the catalog is missing recommended id ' + key);
  }
});

test('the starter set matches plugins/install.sh', () => {
  assert.deepEqual(catalog.starter_profiles, starterProfiles);
  assert.deepEqual(
    catalogRecommended.filter((e) => e.starter).map((e) => normalize(e.id)).sort(),
    [...starter].sort());
});

test('every bundled entry ships the package it names', async () => {
  for (const entry of [...catalogEssential, ...catalogRecommended]) {
    if (!entry.bundled) continue;
    const manifest = join(repo, 'plugins', entry.package, 'package.json');
    await access(manifest).catch(() => assert.fail('missing ' + manifest));
  }
});

test('every catalog entry carries a reason a user can recognize', () => {
  for (const entry of [...catalogEssential, ...catalogRecommended]) {
    assert.ok(entry.why && entry.why.length > 8, entry.package + ' has no reason');
  }
});
