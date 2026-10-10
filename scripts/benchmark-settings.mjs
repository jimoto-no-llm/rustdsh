// Synthetic settings GET, including Node startup and plugin lifecycle work.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'baseline-ref': { type: 'string' }, n: { type: 'string', default: '5' },
  mib: { type: 'string', default: '32' }, output: { type: 'string' },
} });
assert.equal(process.platform, 'linux', 'RSS comparison is qualified on Linux only');
assert.ok(values['baseline-ref'], '--baseline-ref is required');
const count = Number(values.n), mib = Number(values.mib);
assert.ok(Number.isInteger(count) && count >= 1 && count <= 100);
assert.ok(Number.isInteger(mib) && mib >= 1 && mib <= 64);
const repo = path.resolve(import.meta.dirname, '..');
function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const baseline = git('rev-parse', '--verify', values['baseline-ref'] + '^{commit}').trim();
const relative = 'plugins/rdsh-settings/index.js';
const before = git('show', baseline + ':' + relative);
const after = await readFile(path.join(repo, relative), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
const root = await mkdtemp(path.join(tmpdir(), 'rdsh-settings-bench-'));
const samples = { before: [], after: [] };
const childSource = `
  import { Readable } from 'node:stream';
  const settings = await import(process.argv[1]);
  const routes = new Map();
  const ctx = {
    effect: fn => fn(), on: () => () => {},
    inject(names, setup) {
      const cleanup = names.every(name => this[name]) ? setup(this) : undefined;
      return { dispose: async () => { if (typeof cleanup === 'function') await cleanup(); } };
    },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    connection: { requestRejection: () => undefined },
  };
  const dispose = settings.apply(ctx, {});
  try {
    const req = Readable.from([]);Object.assign(req, { method: 'GET', headers: {} });
    let status, body;
    await routes.get('/api/rdsh-settings')(req, {
      writeHead(code) { status = code; },end(value) { body = JSON.parse(value); },
    });
    if (status !== 200 || body.config.general.default_profile !== 'a'.repeat(200)) {
      throw new Error('Incorrect settings prefix');
    }
    console.log(JSON.stringify({ max_rss_kib: process.resourceUsage().maxRSS, correct_prefix: true }));
  } finally { await dispose(); }
`;
try {
  const beforeFile = path.join(root, 'before.mjs');
  const discord = pathToFileURL(path.join(repo, 'plugins/rdsh-settings/discord.js')).href;
  await writeFile(beforeFile, before.replace("'./discord.js'", JSON.stringify(discord)));
  await writeFile(path.join(root, 'rdsh.json'), JSON.stringify({ general: { default_profile: 'a'.repeat(mib * 1024 * 1024) } }));
  const urls = { before: pathToFileURL(beforeFile).href, after: pathToFileURL(path.join(repo, relative)).href };
  function measure(kind) {
    const start = performance.now();
    const result = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '--eval', childSource, urls[kind]], {
      env: { PATH: process.env.PATH, HOME: root, DSH_HOME: root },
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    });
    const elapsed_ms = performance.now() - start;
    assert.equal(result.status, 0, result.stderr?.slice(-2000));
    return { ...JSON.parse(result.stdout), elapsed_ms };
  }
  measure('before');measure('after');
  for (let i = 0; i < count; i++) {
    for (const kind of i % 2 === 0 ? ['before', 'after'] : ['after', 'before']) samples[kind].push(measure(kind));
  }
  const median = numbers => {
    const sorted = [...numbers].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const report = {
    scope: 'Synthetic settings GET for one oversized known string. RSS and elapsed time include Node startup and plugin lifecycle; no DSH server, models or live services.',
    fixture: { input_mib: mib, field: 'general.default_profile', retained_characters: 200 },
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, max_old_space_mib: 256 },
    baseline_commit: baseline, source_sha256: { before: hash(before), after: hash(after) },
    n: count, warmups_per_variant: 1, sample_order: 'alternating', samples,
    medians: Object.fromEntries(Object.entries(samples).map(([kind, rows]) => [kind, {
      max_rss_kib: median(rows.map(row => row.max_rss_kib)), elapsed_ms: median(rows.map(row => row.elapsed_ms)),
    }])),
  };
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ n: count, fixture: report.fixture, medians: report.medians, output: values.output }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
