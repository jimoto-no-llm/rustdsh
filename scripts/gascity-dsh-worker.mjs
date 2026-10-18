#!/usr/bin/env node
// Gas City owns sessions; DSH owns the complete agent loop.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const config = JSON.parse(await readFile(process.env.RDSH_SWARM_CONFIG, 'utf8'));
const session = process.env.GC_SESSION_ID;
if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error('A Gas City session ID is required');
const attempt = path.join(config.stateDir, session);
await mkdir(attempt); // Refuse a duplicate launch; never reuse another attempt's state.
let key;
try {
for (const name of ['home', 'dsh-home', 'tmp']) await mkdir(path.join(attempt, name));
const keyText = await readFile(config.keyFile, 'utf8');
key = keyText.split(/\r?\n/).find(line => /^\s*DEEPINFRA_API_KEY=/.test(line))
  ?.split('=').slice(1).join('=').trim().replace(/^(['"])(.*)\1$/, '$2');
if (!key) throw new Error('Configured provider credential is unavailable');
const patch = path.join(attempt, 'worker.patch.yml');
await writeFile(patch, JSON.stringify([
  { id: 'agent-default-model', config: { provider: 'rdsh-deepinfra', model: config.model } },
  { id: 'llm-pi-ai', config: { providers: { 'rdsh-deepinfra': {
    api: 'openai-completions', baseURL: 'https://api.deepinfra.com/v1/openai', apiKeyEnv: 'DEEPINFRA_API_KEY',
    retryPolicy: { mode: 'normal', maxRetries: 0 },
    models: [{ id: config.model, contextWindow: 131072, maxTokens: 4096, reasoning: false }],
  } } } },
  ...['typert', 'typert-loader', 'typert-gateway', 'session-title-llm', 'session-telemetry-otel',
    'llm-deepseek', 'llm-deepseek-account', 'deepseek-account', 'credentials', 'authorization',
    'session-log-deepseek', 'plugin-package-inventory-deepseek', 'hmr', 'tool-plugin-manager',
    'subagent', 'tool-subagent', 'tool-subagent-control', 'tool-subagent-list-agents',
    'subagent-spawn-in-process', 'subagent-fork-in-process', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow']
    .map(id => ({ id, disabled: true })),
]), { mode: 0o600 });
let task = process.argv.slice(2).join('\n');
if (!task.trim()) {
  // Gas City's manual session factory starts the command without a prompt arg.
  // Ask Gas City to render its configured prompt through the supported CLI.
  const prime = spawnSync(config.gc, ['prime', process.env.GC_TEMPLATE], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 15000,
  });
  if (prime.status !== 0) throw new Error('Gas City prompt rendering failed');
  task = prime.stdout;
}
if (!task.trim()) throw new Error('Gas City must supply a task prompt');
const startedAt = new Date().toISOString();
await writeFile(path.join(attempt, 'started.json'), JSON.stringify({ session, workspace: process.cwd(), startedAt }));
const child = spawn('/usr/bin/timeout', ['--kill-after=5s', `${config.timeoutSeconds ?? 180}s`,
  config.rdsh, '--profile', 'headless', '--patch', patch, '--json', task], {
  cwd: process.cwd(), env: {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: path.join(attempt, 'home'), DSH_HOME: path.join(attempt, 'dsh-home'), TMPDIR: path.join(attempt, 'tmp'),
    RDSH_ORIG_BIN: config.dshEntry, RDSH_AUTH_AUTOSYNC: '0', DEEPINFRA_API_KEY: key,
  }, stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16 * 1024 * 1024); });
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
const status = await new Promise(resolve => {
  child.once('error', () => resolve({ code: null, spawnError: true }));
  child.once('close', (code, signal) => resolve({ code, signal }));
});
const redact = text => text.split(key).join('[REDACTED]');
await writeFile(path.join(attempt, 'stdout.jsonl'), redact(stdout), { mode: 0o600 });
await writeFile(path.join(attempt, 'stderr.txt'), redact(stderr), { mode: 0o600 });
const events = stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const result = { gc_session_id: session, worker: process.env.GC_AGENT, workspace: process.cwd(),
  started_at: startedAt, ended_at: new Date().toISOString(), ...status,
  dsh_session_id: events.find(event => event.type === 'session')?.sessionId,
  completed: events.some(event => event.phase === 'turn_end' && event.reason?.kind === 'completed'),
  final: events.findLast(event => event.type === 'final')?.text,
  event_types: [...new Set(events.map(event => event.type))],
  steps: events.filter(event => event.phase === 'step_end').map(event => ({ step: event.step, usage: event.usage })),
};
await writeFile(path.join(attempt, 'result.json'), redact(JSON.stringify(result, null, 2)), { mode: 0o600 });
console.log(JSON.stringify({ session, code: result.code, completed: result.completed }));
process.exitCode = result.code === 0 && result.completed ? 0 : (result.code || 1);
} catch (error) {
  // Preserve a terminal failure even when the runtime never reaches a model.
  const message = key ? String(error.message).split(key).join('[REDACTED]') : String(error.message);
  await writeFile(path.join(attempt, 'result.json'), JSON.stringify({ gc_session_id: session,
    workspace: process.cwd(), completed: false, code: 1, error: message, ended_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.error(message);
  process.exitCode = 1;
}
