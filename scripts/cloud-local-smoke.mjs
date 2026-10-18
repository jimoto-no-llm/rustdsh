// Ten real headless DSH processes; model responses stay on loopback (no API bill).
// Linux: LOCAL_RDSH_BIN=/absolute/rdsh LOCAL_DSH_ENTRY=/absolute/bin.js node this-file
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const rdsh = process.env.LOCAL_RDSH_BIN;
const dsh = process.env.LOCAL_DSH_ENTRY;
if (process.platform !== 'linux' || !path.isAbsolute(rdsh ?? '') || !path.isAbsolute(dsh ?? '')) {
  throw new Error('Linux and absolute LOCAL_RDSH_BIN / LOCAL_DSH_ENTRY paths are required');
}
const count = 10;
const root = await mkdtemp('/tmp/rdsh-local-ten-');
const children = new Set();
const requests = Array(count).fill(0);
const waiting = new Map();
let maxWaiting = 0;
let peakRssKiB = 0;
let samples = 0;
let sampling = false;
let barrierAtMs = null;
let started = performance.now();

async function treeRss(pid, seen = new Set()) {
  if (seen.has(pid)) return 0;
  seen.add(pid);
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const descendants = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim();
    let total = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
    for (const child of descendants.split(/\s+/).filter(Boolean)) total += await treeRss(child, seen);
    return total;
  } catch { return 0; } // A process can exit between procfs reads.
}

function respond(res, index) {
  const text = `LOCAL_OK_${index}`;
  const item = { type: 'message', id: `message-${index}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: `response-${index}`, object: 'response', model: 'gpt-4o-mini',
    status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id,
      part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: text },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

const server = http.createServer((req, res) => {
  const match = /^\/worker-(\d+)\/v1\/responses$/.exec(req.url);
  const index = Number(match?.[1]);
  req.resume();
  req.on('end', () => {
    if (!match || req.method !== 'POST' || index >= count || ++requests[index] !== 1) {
      res.writeHead(400).end(); return;
    }
    waiting.set(index, res);
    res.once('close', () => waiting.delete(index));
    maxWaiting = Math.max(maxWaiting, waiting.size);
    if (waiting.size === count) {
      barrierAtMs = performance.now() - started;
      // Hold all ten open together, also allowing the RSS sampler to observe them.
      setTimeout(() => { for (const [id, response] of waiting) respond(response, id); }, 250);
    }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const workers = [];
for (let index = 0; index < count; index++) {
  const dir = path.join(root, `worker-${index}`);
  for (const name of ['home', 'dsh-home', 'workspace', 'tmp']) await mkdir(path.join(dir, name), { recursive: true });
  const patch = path.join(dir, 'local.patch.yml');
  await writeFile(patch, JSON.stringify([
    { id: 'agent-default-model', config: { provider: 'openai', model: 'gpt-4o-mini' } },
    { id: 'llm-pi-ai', config: { providers: { openai: {
      baseURL: `http://127.0.0.1:${port}/worker-${index}/v1`, apiKeyEnv: 'LOCAL_FAKE_KEY',
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    } } } },
    ...['session-title-llm', 'session-telemetry-otel', 'typert', 'typert-loader', 'typert-gateway']
      .map(id => ({ id, disabled: true })),
  ]));
  workers.push({ index, dir, patch });
}

started = performance.now();
const timer = setInterval(async () => {
  if (sampling) return;
  sampling = true;
  const values = await Promise.allSettled([...children].map(child => treeRss(child.pid)));
  peakRssKiB = Math.max(peakRssKiB, values.reduce((sum, value) => sum + (value.status === 'fulfilled' ? value.value : 0), 0));
  samples++;
  sampling = false;
}, 100);
const runs = await Promise.allSettled(workers.map(async ({ index, dir, patch }) => {
  const child = spawn('/usr/bin/time', [
    '-f', 'elapsed_seconds=%e\nmax_rss_kib=%M\nuser_cpu_seconds=%U\nsystem_cpu_seconds=%S',
    '-o', path.join(dir, 'resources.txt'), 'timeout', '--kill-after=2s', '30s', rdsh,
    '--profile', 'headless', '--patch', patch, '--json', `Reply LOCAL_OK_${index}`,
  ], {
    cwd: path.join(dir, 'workspace'),
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(dir, 'home'),
      DSH_HOME: path.join(dir, 'dsh-home'), TMPDIR: path.join(dir, 'tmp'),
      RDSH_ORIG_BIN: dsh, RDSH_AUTH_AUTOSYNC: '0', LOCAL_FAKE_KEY: 'local-test-no-account' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1048576); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1048576); });
  const status = await new Promise(resolve => {
    child.once('error', error => resolve({ code: null, spawnError: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  children.delete(child);
  await writeFile(path.join(dir, 'stdout.jsonl'), stdout);
  await writeFile(path.join(dir, 'stderr.txt'), stderr);
  const resources = await readFile(path.join(dir, 'resources.txt'), 'utf8').catch(() => '');
  const events = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const session = events.find(event => event.type === 'session');
  return { index, ...status, requests: requests[index],
    session_id: session?.sessionId, workspace_matches: session?.cwd === path.join(dir, 'workspace'),
    completed: events.some(event => event.type === 'status' && event.phase === 'turn_end' && event.reason?.kind === 'completed'),
    marker: events.some(event => event.type === 'final' && event.text === `LOCAL_OK_${index}`),
    resources: Object.fromEntries([...resources.matchAll(/^(\w+)=([\d.]+)$/gm)].map(([, key, value]) => [key, Number(value)])),
    stdout, stderr };
}));
clearInterval(timer);
server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
const results = runs.map((run, index) => run.status === 'fulfilled' ? run.value : { index, error: String(run.reason) });
const report = { kind: 'local_dsh_ten_loopback_smoke', created_at: new Date().toISOString(),
  workers: count, elapsed_seconds: (performance.now() - started) / 1000,
  max_concurrent_model_requests: maxWaiting, barrier_at_ms: barrierAtMs,
  sampled_worker_tree_rss_peak_kib: peakRssKiB, rss_samples: samples,
  paid_api_requests: 0, fixture: root, results };
report.unique_sessions = new Set(results.map(r => r.session_id).filter(Boolean)).size;
report.passed = maxWaiting === count && report.unique_sessions === count &&
  results.every(r => r.code === 0 && r.requests === 1 && r.marker && r.completed && r.workspace_matches);
await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, results: results.map(({ stdout, stderr, ...result }) => result) }, null, 2));
process.exitCode = report.passed ? 0 : 1;
