// One evaluation run: an isolated DSH home, the real `rdsh` binary, the real
// DSH headless profile and the compaction path the runtime uses. Nothing here
// reimplements compaction; the arms only differ in the settings file.
import { mkdir, writeFile, readFile, readdir, cp, symlink, rm, mkdtemp, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { score } from './score.mjs';

export const ARMS = ['none', 'current', 'candidate'];
const PLUGIN = fileURLToPath(new URL('../../../plugins/rdsh-compaction', import.meta.url));

// Model tools are switched off unless a task asks for them. A task with
// `tools: true` gets the file tools only, in a read-only sandbox, inside a
// workspace that holds nothing but the task's own files. Shell, web, jobs and
// subagent tools stay off in every run.
export const TOOL_ROWS = Object.freeze(['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs',
  'tool-fs-search', 'tool-skill', 'tool-subagent-control', 'tool-subagent-list-agents',
  'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-todo', 'tool-goal', 'tool-web']);
export const FILE_TOOL_ROWS = Object.freeze(['tool-fs', 'tool-fs-search']);

const yamlText = value => `'${String(value).replaceAll("'", "''")}'`;

function whole(value, name, min = 1) {
  if (!Number.isSafeInteger(value) || value < min) throw new TypeError(`compaction-eval: ${name} must be an integer >= ${min}`);
  return value;
}

/** Validate the run conditions shared by every arm. */
export function checkConditions(config) {
  const p = config?.provider ?? {};
  for (const key of ['name', 'baseUrl', 'apiKeyEnv', 'model']) {
    if (typeof p[key] !== 'string' || !p[key].trim() || /[\u0000-\u001f]/.test(p[key])) {
      throw new TypeError(`compaction-eval: provider.${key} must be a plain string`);
    }
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(p.apiKeyEnv)) throw new TypeError('compaction-eval: provider.apiKeyEnv must name an environment variable');
  if (!/^https?:\/\//.test(p.baseUrl)) throw new TypeError('compaction-eval: provider.baseUrl must be an http(s) URL');
  whole(p.contextWindow, 'provider.contextWindow');
  whole(p.outputReserve, 'provider.outputReserve');
  const t = config.thresholds ?? {};
  whole(t.trigger_tokens, 'thresholds.trigger_tokens');
  whole(t.retain_tokens, 'thresholds.retain_tokens', 0);
  whole(t.max_tokens, 'thresholds.max_tokens');
  if (t.retain_tokens >= t.trigger_tokens) throw new TypeError('compaction-eval: retain_tokens must be below trigger_tokens');
  if (t.trigger_tokens > p.contextWindow - p.outputReserve) throw new TypeError('compaction-eval: trigger_tokens does not fit in the window');
  return config;
}

/** The inputs that make two runs comparable; part of every run key. */
export function conditions(config) {
  const p = config.provider;
  return { provider: p.name, baseUrl: p.baseUrl, model: p.model, contextWindow: p.contextWindow,
    outputReserve: p.outputReserve, ...config.thresholds };
}

/** `rdsh-compaction.json` for one arm. Only `routes` and `instructions` differ. */
export function settings(config, arm, instruction) {
  if (!ARMS.includes(arm)) throw new TypeError(`compaction-eval: unknown arm ${arm}`);
  if ((arm === 'candidate') !== (typeof instruction === 'string')) {
    throw new TypeError('compaction-eval: only the candidate arm takes an instruction');
  }
  const p = config.provider;
  const document = { schema: 1, policies: [{ provider: p.name, model: p.model,
    context_window: p.contextWindow, output_reserve: p.outputReserve, ...config.thresholds }] };
  if (arm === 'none') document.routes = [{ provider: p.name, model: p.model, method: 'off' }];
  if (arm === 'candidate') document.instructions = instruction;
  return document;
}

/** The profile's patch layer: one route, the default model, tools off (file tools on for a tool task). */
export function profilePatch(config, { tools = false } = {}) {
  const p = config.provider;
  const lines = ['- id: llm-pi-ai', '  config:', '    providers:', `      ${p.name}:`,
    '        api: openai-completions', `        baseURL: ${yamlText(p.baseUrl)}`,
    `        apiKeyEnv: ${p.apiKeyEnv}`, '        models:', `          - id: ${yamlText(p.model)}`,
    '            name: Evaluation model', `            contextWindow: ${p.contextWindow}`,
    `            maxTokens: ${p.outputReserve}`, '- id: agent-default-model', '  config:',
    `    provider: ${p.name}`, `    model: ${yamlText(p.model)}`];
  for (const id of TOOL_ROWS) {
    if (tools && FILE_TOOL_ROWS.includes(id)) continue;
    lines.push(`- id: ${id}`, '  disabled: true');
  }
  return `${lines.join('\n')}\n`;
}

/** Events the headless `--json` stream reports for one turn. */
export function parseTurn(stdout) {
  const turn = { sessionId: undefined, final: undefined, ended: undefined };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'session') turn.sessionId = event.sessionId;
    else if (event.type === 'final') turn.final = event.text;
    else if (event.type === 'status' && event.phase === 'turn_end') turn.ended = event.reason?.kind;
  }
  return turn;
}

/** Counts from a session log: model calls, tokens, compactions and summaries. */
export function readLog(lines) {
  const metrics = { calls: 0, tokens: 0, compactions: 0, summaries: [], toolCalls: [] };
  const spent = usage => (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.outputTokens ?? 0);
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'assistant/message') {
      metrics.calls += 1;
      metrics.tokens += spent(row.data?.usage);
    } else if (row.type === 'tool/call') {
      if (typeof row.data?.name === 'string') metrics.toolCalls.push(row.data.name);
    } else if (row.type === 'compaction/summary') {
      metrics.calls += 1;
      metrics.tokens += spent(row.data?.usage);
      metrics.compactions += 1;
      const text = (row.data?.summary ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      metrics.summaries.push(text.slice(0, 16384));
    }
  }
  return metrics;
}

/**
 * Decode a session log. DSH appends one zstd frame per write. Some Node
 * versions stop after the first frame, so any remaining frames are walked.
 */
export function zstd(buffer) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return execFileSync('zstd', ['-dc'], { input: buffer, maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
  }
  const parts = [];
  for (let offset = 0; offset < buffer.length;) {
    const frame = zlib.zstdDecompressSync(buffer.subarray(offset), { info: true });
    if (!frame.engine.bytesWritten) throw new Error('compaction-eval: the session log could not be decoded');
    parts.push(frame.buffer);
    offset += frame.engine.bytesWritten;
  }
  return Buffer.concat(parts).toString('utf8');
}

async function sessionLog(dshHome, sessionId) {
  const root = join(dshHome, 'sessions');
  for (const workspace of await readdir(root)) {
    try { return zstd(await readFile(join(root, workspace, sessionId, 'session.v4.jsonl.zstd'))).split('\n'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('compaction-eval: the session log was not found');
}

function turn(binary, args, options) {
  return new Promise(done => {
    execFile(binary, args, options, (error, stdout, stderr) => done({ error, stdout, stderr }));
  });
}

/** Build the isolated home for one arm under `root`. Exported for the boot test. */
export async function prepare(root, config, arm, instruction, task = {}) {
  const runtime = resolve(config.dshRuntime);
  const modules = join(runtime, 'node_modules');
  const home = join(root, 'home');
  const dshHome = join(home, '.dsh');
  const profile = join(dshHome, 'profiles', 'headless');
  const plugin = join(root, 'plugin');
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await mkdir(join(root, 'work'));
  for (const [path, body] of Object.entries(task.files ?? {})) {
    await mkdir(dirname(join(root, 'work', path)), { recursive: true });
    await writeFile(join(root, 'work', path), body);
  }
  await mkdir(join(root, 'tmp'));
  await cp(PLUGIN, plugin, { recursive: true, filter: path => !path.includes('node_modules') });
  const link = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(modules, join(plugin, 'node_modules'), link);
  await symlink(join(modules, '@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'), link);
  await symlink(plugin, join(profile, 'node_modules/rdsh-compaction'), link);
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'compaction-eval', private: true, type: 'module',
    dependencies: { 'rdsh-compaction': `file:${plugin.replaceAll('\\', '/')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'rdsh-compaction'] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), profilePatch(config, { tools: Boolean(task.tools) }));
  await writeFile(join(dshHome, 'rdsh.json'), JSON.stringify({ schema: 1,
    features: { compaction_policy: true, update_check: false, web_gzip_level: false } }));
  await writeFile(join(dshHome, 'rdsh-compaction.json'), JSON.stringify(settings(config, arm, instruction)));
  const env = { HOME: home, USERPROFILE: home, DSH_HOME: dshHome, TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(process.platform === 'win32' ? ';' : ':'),
    RDSH_ORIG_BIN: join(modules, '@deepseek-ai/dsh/lib/bin.js'), RDSH_LANG: 'en', RDSH_AUTH_AUTOSYNC: '0',
    RDSH_NO_TMP_GUARD: '1', DSH_PERMISSION_MODE: 'read-only',
    [config.provider.apiKeyEnv]: process.env[config.provider.apiKeyEnv] ?? '' };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot ?? '';
  return { dshHome, env, cwd: join(root, 'work') };
}

/**
 * Run one task in one arm and score it.
 * A turn that does not end normally fails the run; it is reported, not retried.
 */
export async function runTask({ task, arm, instruction, config, budget }) {
  checkConditions(config);
  const root = await mkdtemp(join(tmpdir(), 'rdsh-compaction-eval-'));
  try {
    const { dshHome, env, cwd } = await prepare(root, config, arm, instruction, task);
    const prompts = [...task.turns, task.question];
    let sessionId;
    let final = '';
    for (const prompt of prompts) {
      const args = ['--no-slim', 'headless', '--json', ...(sessionId ? ['--session-id', sessionId] : []), prompt];
      const out = await turn(resolve(config.rdsh), args, { cwd, env, timeout: budget.runTimeoutMs,
        maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      const parsed = parseTurn(out.stdout ?? '');
      sessionId ??= parsed.sessionId;
      if (out.error || !sessionId || parsed.ended === 'error' || parsed.final === undefined) {
        return { pass: false, failed: ['turn_did_not_finish'], tokens: 0, calls: 0, compactions: 0, summaries: [], toolCalls: [], final: '' };
      }
      final = parsed.final;
    }
    const metrics = readLog(await sessionLog(dshHome, sessionId));
    if (metrics.calls > budget.maxCallsPerRun) {
      return { ...metrics, pass: false, failed: ['over_call_limit'], final: '' };
    }
    const existing = [];
    for (const path of task.expect.files_absent ?? []) {
      if (await access(join(cwd, path)).then(() => true, () => false)) existing.push(path);
    }
    return { ...metrics, ...score(task, final, { toolCalls: metrics.toolCalls, existing }), final: final.slice(0, 8192) };
  } finally {
    if (root.startsWith(join(tmpdir(), 'rdsh-compaction-eval-'))) await rm(root, { recursive: true, force: true });
  }
}
