import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, access, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { discordDefaults, normalizeDiscord, installDiscordPresence } from './discord.js';

// The presence also runs in headless/TUI profiles; HTTP routes need both services.
export const inject = [];

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function cfgPath() { return join(dshHome(), 'rdsh-context.json'); }
function settingsPath() { return join(dshHome(), 'rdsh.json'); }

async function savePrivateJson(path, value) {
  const temporary = `${path}.tmp.${randomBytes(16).toString('hex')}`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

function defaults() {
  return { token_budget: 4000, enable_retriever: true, enable_packer: true, enable_verifier: true, goal: '', decisions: [], constraints: [], working_files: [], open_tasks: [] };
}

function settingsDefaults() {
  return {
    schema: 1,
    discord: { ...discordDefaults },
    general: { slim: true, passthrough: false, dry_run: false, default_profile: '' },
    tokens: { default_budget: 4000 },
    search: { dir: '.', max: 100, web_limit: 10, searxng_url: '' },
    compact: { max_tokens: 8000 },
    sessions: { limit: 20, with_tokens: false, stale_secs: 60 },
    logs: { tail: 50 },
    serve: { port: 38080 },
    guard: { deny: [], reason: '' },
    bench: { n: 5 },
    setup: { web_port: 0 },
    beta: { context_engine: false },
    context: { token_budget: 4000, enable_retriever: true, enable_packer: true, enable_verifier: true, goal: '', decisions: [], constraints: [], working_files: [], open_tasks: [], max_code_hits: 20, max_sessions: 0, include_git_diff: true },
  };
}

async function readLegacyContext() {
  try {
    return obj(JSON.parse(await readFile(cfgPath(), 'utf8')));
  } catch (e) { return {}; }
}

async function loadCfg() {
  return sanitize(await readLegacyContext());
}

async function settingsForForm(current) {
  return sanitizeSettings({ ...current, context: current.context ?? await readLegacyContext() });
}

async function loadSettings() {
  return await settingsForForm(await readSettingsDocument());
}

async function readSettingsDocument() {
  try {
    const value = JSON.parse(await readFile(settingsPath(), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid settings');
    return value;
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

async function mergeSettings(current, input) {
  input = obj(input);
  const hasContext = current.context != null || input.context != null;
  if (current.context == null && input.context != null) {
    current = { ...current, context: (await settingsForForm(current)).context };
  }
  const source = { ...current, ...input };
  for (const [key, value] of Object.entries(settingsDefaults())) {
    if (typeof value === 'object') source[key] = { ...obj(current[key]), ...obj(input[key]) };
  }
  const normalized = sanitizeSettings(source);
  const result = { ...current, ...normalized };
  for (const [key, value] of Object.entries(normalized)) {
    if (typeof value === 'object') result[key] = { ...obj(current[key]), ...value };
  }
  if (hasContext) {
    // The legacy alias has been migrated into working_files, including empty lists.
    delete result.context.files;
  } else {
    // An unrelated partial save must not shadow the active legacy context.
    if (Object.hasOwn(current, 'context')) result.context = current.context;
    else delete result.context;
  }
  return result;
}

function textPrefix(value, maxC) {
  const prefix = [];
  for (const character of value) {
    if (prefix.length >= maxC) break;
    prefix.push(character);
  }
  return prefix.join('');
}

function strList(v, maxN, maxC) {
  if (!Array.isArray(v)) return [];
  const result = [];
  for (const value of v) {
    if (result.length >= maxN) break;
    if (typeof value !== 'string') continue;
    const text = textPrefix(value, maxC);
    if (text.trim() !== '') result.push(text);
  }
  return result;
}

function sanitize(j) {
  const d = defaults();
  const out = { ...d };
  const b = Number(j.token_budget);
  out.token_budget = Number.isFinite(b) ? Math.min(200000, Math.max(500, Math.round(b))) : 4000;
  for (const k of ['enable_retriever', 'enable_packer', 'enable_verifier']) {
    if (typeof j[k] === 'boolean') out[k] = j[k];
  }
  if (typeof j.goal === 'string') out.goal = textPrefix(j.goal, 2000);
  out.decisions = strList(j.decisions, 50, 500);
  out.constraints = strList(j.constraints, 50, 500);
  out.working_files = strList(j.working_files ?? j.files, 50, 300);
  out.open_tasks = strList(j.open_tasks, 50, 500);
  return out;
}

function clampInt(v, min, max, fb) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(v, fb) {
  return typeof v === 'boolean' ? v : fb;
}

function str(v, maxC, fb) {
  return typeof v === 'string' ? textPrefix(v, maxC) : fb;
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function sanitizeSettings(j) {
  const d = settingsDefaults();
  const src = obj(j);
  const g = obj(src.general); const dg = d.general;
  const tk = obj(src.tokens);
  const se = obj(src.search);
  const co = obj(src.compact);
  const ss = obj(src.sessions);
  const lg = obj(src.logs);
  const sv = obj(src.serve);
  const gu = obj(src.guard);
  const be = obj(src.bench);
  const su = obj(src.setup);
  const bt = obj(src.beta);
  const cx = obj(src.context);
  return {
    schema: 1,
    discord: normalizeDiscord(src.discord),
    general: {
      slim: bool(g.slim, dg.slim),
      passthrough: bool(g.passthrough, dg.passthrough),
      dry_run: bool(g.dry_run, dg.dry_run),
      default_profile: str(g.default_profile, 200, dg.default_profile),
    },
    tokens: {
      default_budget: clampInt(tk.default_budget, 500, 200000, d.tokens.default_budget),
    },
    search: {
      dir: str(se.dir, 300, d.search.dir),
      max: clampInt(se.max, 1, 100, d.search.max),
      web_limit: clampInt(se.web_limit, 1, 100, d.search.web_limit),
      searxng_url: str(se.searxng_url, 2000, d.search.searxng_url),
    },
    compact: {
      max_tokens: clampInt(co.max_tokens, 500, 200000, d.compact.max_tokens),
    },
    sessions: {
      limit: clampInt(ss.limit, 1, 100, d.sessions.limit),
      with_tokens: bool(ss.with_tokens, d.sessions.with_tokens),
      stale_secs: clampInt(ss.stale_secs, 0, 3600, d.sessions.stale_secs),
    },
    logs: {
      tail: clampInt(lg.tail, 1, 500, d.logs.tail),
    },
    serve: {
      port: clampInt(sv.port, 1, 65535, d.serve.port),
    },
    guard: {
      deny: strList(gu.deny, 50, 500),
      reason: str(gu.reason, 500, d.guard.reason),
    },
    bench: {
      n: clampInt(be.n, 1, 20, d.bench.n),
    },
    setup: {
      web_port: clampInt(su.web_port, 0, 65535, d.setup.web_port),
    },
    beta: {
      context_engine: bool(bt.context_engine, d.beta.context_engine),
    },
    context: {
      token_budget: clampInt(cx.token_budget, 500, 200000, d.context.token_budget),
      enable_retriever: bool(cx.enable_retriever, d.context.enable_retriever),
      enable_packer: bool(cx.enable_packer, d.context.enable_packer),
      enable_verifier: bool(cx.enable_verifier, d.context.enable_verifier),
      goal: str(cx.goal, 2000, d.context.goal),
      decisions: strList(cx.decisions, 50, 500),
      constraints: strList(cx.constraints, 50, 500),
      working_files: strList(cx.working_files ?? cx.files, 50, 300),
      open_tasks: strList(cx.open_tasks, 50, 500),
      max_code_hits: clampInt(cx.max_code_hits, 1, 100, d.context.max_code_hits),
      max_sessions: clampInt(cx.max_sessions, 0, 100, d.context.max_sessions),
      include_git_diff: bool(cx.include_git_diff, d.context.include_git_diff),
    },
  };
}

async function readBody(req, limit = 65536) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function authorize(ctx, req, res) {
  const status = typeof ctx.connection?.requestRejection === 'function'
    ? ctx.connection.requestRejection(req) : 503;
  if (status === undefined) return true;
  json(res, status, { ok: false, error: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'authentication-unavailable' });
  return false;
}

function registerWeb(ctx, presence) {
  return ctx.effect(() => {
    const offDiscordIcon = ctx.webServer.register({
      kind: 'exact', path: '/api/rdsh-discord/icon',
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          json(res, 405, { ok: false, error: 'method-not-allowed' }); return;
        }
        try {
          const icon = await readFile(new URL('./assets/rushDSH.png', import.meta.url));
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': icon.length,
            'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' });
          res.end(req.method === 'HEAD' ? undefined : icon);
        } catch { json(res, 500, { ok: false, error: 'icon-unavailable' }); }
      },
    });
    const offDiscord = ctx.webServer.register({
      kind: 'exact', path: '/api/rdsh-discord',
      handler: (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          json(res, 405, { ok: false, error: 'method-not-allowed' }); return;
        }
        json(res, 200, { ok: true, ...presence.status() });
      },
    });
    const offGet = ctx.webServer.register({
      kind: 'exact',
      path: '/api/rdsh-context',
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'method-not-allowed' }));
          return;
        }
        const cfg = await loadCfg();
        const body = JSON.stringify({ ok: true, prototype: true, config: cfg });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      },
    });
    const offPost = ctx.webServer.register({
      kind: 'exact',
      path: '/api/rdsh-context/save',
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'method-not-allowed' }));
          return;
        }
        try {
          const input = await readBody(req);
          const cfg = sanitize(input.config ?? input);
          await mkdir(dshHome(), { recursive: true });
          await savePrivateJson(cfgPath(), cfg);
          const body = JSON.stringify({ ok: true, config: cfg });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
          res.end(body);
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad-request' }));
        }
      },
    });
    const offGetSettings = ctx.webServer.register({
      kind: 'exact',
      path: '/api/rdsh-settings',
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'method-not-allowed' }));
          return;
        }
        let cfg;
        try {
          cfg = await loadSettings();
        } catch (e) {
          json(res, 400, { ok: false, error: 'invalid-settings' });
          return;
        }
        let legacyPresent = false;
        try { await access(cfgPath()); legacyPresent = true; } catch (e) {}
        json(res, 200, { ok: true, config: cfg, legacy_present: legacyPresent });
      },
    });
    const offPostSettings = ctx.webServer.register({
      kind: 'exact',
      path: '/api/rdsh-settings/save',
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'method-not-allowed' }));
          return;
        }
        try {
          // Covers every supported form field at its limit, including JSON escapes.
          const input = await readBody(req, 1024 * 1024);
          const cfg = await mergeSettings(await readSettingsDocument(), input.config ?? input);
          await mkdir(dshHome(), { recursive: true });
          await savePrivateJson(settingsPath(), cfg);
          void presence.refresh();
          json(res, 200, { ok: true, config: await settingsForForm(cfg) });
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad-request' }));
        }
      },
    });
    return () => {
      for (const off of [offDiscordIcon, offDiscord, offGet, offPost, offGetSettings, offPostSettings]) {
        if (typeof off === 'function') off();
      }
    };
  });
}

export function apply(ctx) {
  return ctx.effect(() => {
    const presence = installDiscordPresence(ctx);
    // Cordis injection is a required-service map, so mount HTTP separately.
    const web = ctx.inject(['webServer', 'connection'], webCtx => registerWeb(webCtx, presence));
    const agents = ctx.inject(['agents'], agentCtx => {
      for (const agent of agentCtx.agents.list()) presence.observe(agent);
    });
    return async () => {
      await web.dispose(); await agents.dispose(); await presence.stop();
    };
  });
}
