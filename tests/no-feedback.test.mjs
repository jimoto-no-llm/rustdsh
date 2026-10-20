import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// The DSH feedback surface is three stock entries: the server Remote
// (message-feedback), the browser surface (ui-message-feedback) and the
// log-only slash command (command-feedback). rdsh ships one bundle that turns
// all three off by adding `disabled: true` rows to the loader patch tree. This
// file is the contract for that patch: which ids it targets, that it names the
// packages it expects (the loader skips a patch whose `name` does not match),
// and that plugins/install.sh only attaches the bundle when the user asked for
// it through features.feedback=false.

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
const plugin = join(repo, 'plugins', 'rdsh-no-feedback');
const patch = await readFile(join(plugin, 'cordis.patch.yml'), 'utf8');
const manifest = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));

// A minimal reader for the top-level patch list this bundle carries: each row
// is `- id: <entry>` with indented `name:` / `disabled:` keys. Parsing
// rather than string-matching is what makes the assertions below able to fail
// on a malformed row instead of on wording.
function parsePatches(source) {
  const rows = [];
  let current = null;
  for (const raw of source.split('\n')) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const top = /^-\s+id:\s*(\S+)\s*$/.exec(raw);
    if (top) {
      current = { id: top[1], keys: {} };
      rows.push(current);
      continue;
    }
    const nested = /^\s+([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(raw);
    if (nested && current) {
      current.keys[nested[1]] = nested[2].replace(/^['"]|['"]$/g, '');
      continue;
    }
    throw new Error('unparsed patch line: ' + raw);
  }
  return rows;
}

const rows = parsePatches(patch);
const rowFor = (id) => rows.find((row) => row.id === id);

// Disabling the server half alone would leave the browser plugin's required
// `remote.messageFeedback` / `remote.sessionFeedback` injects unsatisfied,
// because dsh-message-feedback is the only package that registers them. The
// bundle therefore has to cover every half together.
const EXPECTED = [
  ['message-feedback', '@deepseek-ai/dsh-message-feedback'],
  ['ui-message-feedback', '@deepseek-ai/dsh-client-ui-message-feedback'],
  ['command-feedback', '@deepseek-ai/dsh-command-feedback'],
];

test('the patch disables every half of the feedback surface', () => {
  assert.equal(rows.length, EXPECTED.length, 'unexpected number of patch rows');
  for (const [id, name] of EXPECTED) {
    const row = rowFor(id);
    assert.ok(row, 'patch does not target ' + id);
    assert.equal(row.keys.disabled, 'true', id + ' is not disabled');
    assert.equal(row.keys.name, name, id + ' names the wrong package');
  }
});

test('the package composes as a loader bundle', () => {
  assert.equal(manifest.name, 'rdsh-no-feedback');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  // No client half: the bundle only edits the loader tree, so a browser
  // platform declaration here would be a lie.
  assert.equal(manifest.dsh.client, undefined);
});

test('the patch targets ids the shipped DSH web profile actually carries', async (t) => {
  // Composing against the real profile is the only check that proves the ids
  // exist; a renamed upstream entry must fail here rather than silently leave
  // the surface on. Skipped when the CLI or the web profile is absent.
  let composed;
  try {
    const { stdout } = await exec('dsh',
      ['--profile', 'web', '--patch', join(plugin, 'cordis.patch.yml'), '--dump-config'],
      { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    composed = stdout;
  } catch {
    t.skip('dsh CLI or the web profile is not available');
    return;
  }
  for (const [id] of EXPECTED) {
    const entry = new RegExp('^- id: ' + id + '\\n(?:.*\\n)*?  disabled: true$', 'm');
    assert.match(composed, entry, id + ' is not disabled in the composed tree');
  }
});

test('plugins/install.sh attaches the bundle only when the switch is off', { skip: process.platform === 'win32' }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'rdsh-no-feedback-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const base = {
    ...process.env,
    PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? ''),
    HOME: home, DSH_HOME: home, PROFILE: 'web', DRY_RUN: '1', RECOMMENDED: 'none',
  };
  // `document` is written verbatim so the corrupt-JSON case is expressible.
  const run = async (document, profile = 'web') => {
    if (document === undefined) await rm(join(home, 'rdsh.json'), { force: true });
    else await writeFile(join(home, 'rdsh.json'), document);
    return (await exec('sh', [join(repo, 'plugins', 'install.sh')],
      { cwd: repo, env: { ...base, PROFILE: profile } })).stdout;
  };
  const attached = /plugins\/rdsh-no-feedback/;

  // Default: the stock DSH feedback surface stays untouched.
  assert.doesNotMatch(await run(undefined), attached);
  assert.doesNotMatch(await run(JSON.stringify({ features: { feedback: true } })), attached);
  // Explicit off: the bundle joins the run on every profile.
  const off = JSON.stringify({ features: { feedback: false } });
  assert.match(await run(off), attached);
  for (const profile of ['headless', 'desktop']) {
    assert.match(await run(off, profile), attached, profile + ' does not attach the bundle');
  }
  // A corrupt file must not attach a bundle the user did not ask for.
  assert.doesNotMatch(await run('{broken json'), attached);
});
