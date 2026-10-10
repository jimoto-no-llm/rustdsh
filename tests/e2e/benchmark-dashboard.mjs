// Synthetic browser rendering, using the actual before/after frontend modules.
// Instrumentation and disabled background timers exist only in this runner.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { applyOperation, publicState } from '../../dashboard/state.mjs';

const { values } = parseArgs({ options: {
  'baseline-ref': { type: 'string' }, output: { type: 'string' }, n: { type: 'string', default: '21' },
} });
assert.ok(values['baseline-ref'] && values.output, 'Provide --baseline-ref and --output');
const n = Number(values.n);
assert.ok(Number.isInteger(n) && n >= 5, '--n must be an integer >= 5');
const repo = path.resolve(import.meta.dirname, '../..');
const exec = promisify(execFile);
const { chromium } = await import(process.env.RDSH_PLAYWRIGHT_MODULE || 'playwright');
const sources = { baseline: {}, candidate: {} };
for (const file of ['app.mjs', 'reports-view.mjs', 'ui.html']) {
  sources.baseline[file] = (await exec('git', ['show', `${values['baseline-ref']}:dashboard/${file}`], { cwd: repo, maxBuffer: 4 * 1024 * 1024 })).stdout;
  sources.candidate[file] = await readFile(path.join(repo, 'dashboard', file), 'utf8');
}
const allowed = new Set((await readdir(path.join(repo, 'dashboard'))).filter(name => name.endsWith('.mjs')));
const now = Date.now();
const fixture = { schema: 1, project: { id: 'synthetic', name: 'Rendering fixture', root: '/fixture' },
  revision: 1, updated_at: new Date(now).toISOString(), metrics: {}, tasks: [], questions: [], events: [], feedback: [] };
for (let i = 0; i < 100; i++) applyOperation(fixture, 'task', { id: `T${i}`, title: `Synthetic task ${i}`, status: ['todo', 'doing', 'done', 'blocked'][i % 4], observation: { kind: 'measured', source: 'fixture', observed_at: new Date(now).toISOString(), max_age_seconds: 3600 } });
for (let i = 0; i < 40; i++) applyOperation(fixture, 'question', { id: `Q${i}`, question: `Synthetic question ${i}`, urgency: 'normal' });
for (let i = 0; i < 30; i++) applyOperation(fixture, 'event', { type: 'progress', title: `Synthetic event ${i}`, detail: 'Generated fixture; no user data.' });
applyOperation(fixture, 'metrics', { input_tokens: 1000, cached_input_tokens: 500, tool_calls: 10, tool_errors: 0, observation: { kind: 'measured', source: 'fixture', observed_at: new Date(now).toISOString(), max_age_seconds: 3600 } });
const state = publicState(fixture);
const errors = [];
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/config' || pathname === '/api/state') {
      const data = pathname === '/api/state' ? state : { kind: 'project', project: state.project, share: { message: 'Synthetic local fixture', state: 'disabled', url: null } };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); return;
    }
    const [, label, rawAsset] = pathname.split('/');
    const asset = rawAsset || 'ui.html';
    if (!(label in sources) || (asset !== 'ui.html' && !allowed.has(asset))) {
      res.writeHead(404); res.end(); return;
    }
    let source = sources[label][asset] ?? await readFile(path.join(repo, 'dashboard', asset), 'utf8');
    if (asset === 'app.mjs') source += '\nglobalThis.__renderForBenchmark = render;\n';
    res.writeHead(200, { 'content-type': asset === 'ui.html' ? 'text/html' : 'text/javascript' }); res.end(source);
  } catch (error) { errors.push(error.message); res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.RDSH_CHROME_PATH ? { executablePath: process.env.RDSH_CHROME_PATH } : {}) });
const pages = {}, contexts = [];
const report = { measured_at_utc: new Date().toISOString(), os: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model, node: process.version, chromium: browser.version(),
  viewport: { width: 1280, height: 900 }, n, warmups: 5, order: 'alternating baseline/candidate',
  baseline_ref: values['baseline-ref'], scope: 'Synchronous render + forced layout in Chromium; 100 tasks, 40 legacy questions, 30 events. Does not measure network, model execution or INP.',
  sources_sha256: Object.fromEntries(Object.entries(sources).map(([label, files]) => [label, Object.fromEntries(Object.entries(files).map(([file, text]) => [file, createHash('sha256').update(text).digest('hex')]))])), cases: {} };
function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { median_ms: sorted[Math.floor(sorted.length / 2)], p95_ms: sorted[Math.ceil(sorted.length * .95) - 1], samples_ms: samples };
}
try {
  for (const label of ['baseline', 'candidate']) {
    const context = await browser.newContext({ viewport: report.viewport, locale: 'ja-JP' }); contexts.push(context);
    const page = await context.newPage(); pages[label] = page;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      globalThis.setInterval = () => 0;
      globalThis.EventSource = class { addEventListener() {} };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/${label}/`);
    await page.waitForFunction(() => typeof __renderForBenchmark === 'function');
    await page.evaluate(() => {
      document.querySelectorAll('details').forEach(element => { element.open = true; });
      const area = document.querySelector('#question-Q0 textarea'); area.value = 'Keep the draft'; area.focus(); area.setSelectionRange(2, 7);
    });
  }
  for (const kind of ['idle', 'metrics_changed']) {
    const results = Object.fromEntries(Object.keys(pages).map(label => [label, { samples: [], mutations: [], identities: [], drafts: [] }]));
    const render = async (page, iteration, warmup = false) => {
      const snapshot = structuredClone(state);
      if (kind === 'metrics_changed') {
        snapshot.revision = 100 + iteration;
        snapshot.metrics.input_tokens += iteration;
      }
      return page.evaluate(({ snapshot, warmup }) => {
        const old = document.querySelector('#question-Q0 textarea');
        const observer = new MutationObserver(() => {});
        for (const id of ['cards', 'tasks', 'questions', 'events']) observer.observe(document.getElementById(id), { subtree: true, childList: true, attributes: true, characterData: true });
        const start = performance.now();
        globalThis.__renderForBenchmark(snapshot);
        document.body.getBoundingClientRect();
        const elapsed = performance.now() - start;
        const mutations = observer.takeRecords().length; observer.disconnect();
        const area = document.querySelector('#question-Q0 textarea');
        const evidence = { task_ids: [...document.querySelectorAll('#tasks tr[id]')].map(e => e.id),
          task_titles: [...document.querySelectorAll('#tasks tr[id]')].map(e => e.children[2].childNodes[0].textContent),
          questions: [...document.querySelectorAll('#questions h3')].map(e => e.textContent),
          events: [...document.querySelectorAll('#events strong')].map(e => e.textContent),
          draft: [area.value, document.activeElement === area, area.selectionStart, area.selectionEnd] };
        return { elapsed, mutations, same_node: old === area, evidence: warmup ? null : evidence };
      }, { snapshot, warmup });
    };
    for (const page of Object.values(pages)) for (let i = 0; i < 5; i++) await render(page, i, true);
    let evidence;
    for (let i = 0; i < n; i++) {
      const order = i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const label of order) {
        const value = await render(pages[label], i + 5);
        evidence ??= value.evidence; assert.deepEqual(value.evidence, evidence, 'visible data and focused draft must agree');
        results[label].samples.push(value.elapsed); results[label].mutations.push(value.mutations); results[label].identities.push(value.same_node); results[label].drafts.push(value.evidence.draft);
      }
    }
    report.cases[kind] = { visible_data_and_draft_equal: true, results: Object.fromEntries(Object.entries(results).map(([label, r]) => [label, { ...summary(r.samples), mutation_records: r.mutations, same_question_node: r.identities, draft_and_caret_retained: r.drafts.every(d => d[0] === 'Keep the draft' && d[1] && d[2] === 2 && d[3] === 7) }])) };
  }
  assert.deepEqual(errors, []);
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(report.cases).map(([kind, value]) => [kind, Object.fromEntries(Object.entries(value.results).map(([label, result]) => [label, { median_ms: result.median_ms, p95_ms: result.p95_ms, mutations: result.mutation_records[0] }]))])), null, 2));
} finally {
  for (const context of contexts) await context.close();
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
