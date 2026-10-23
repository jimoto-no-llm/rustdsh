// Host half of the subagent route editor.
//
// Starting a child with a chosen provider, model and reasoning effort is a
// property of the delegation tool's own config: DSH reads `agentOptions` from
// the loader entry that declares `@deepseek-ai/dsh-tool-subagent`. There is no
// runtime API to change it, so this plugin edits the profile layer that
// declares it (`cordis.patch.yml`) and reports what is there now. Sessions
// composed after the write pick the route up; a running child keeps its own.
import { mkdir, readFile, writeFile, rename, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readRoute, writeRoute } from './route.js';

const MAX_BODY = 4096;
const MAX_FIELD = 128;
const EFFORTS = Object.freeze(['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const name = 'rdsh-subagent-route';
export const inject = ['webServer'];

function profileDir(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'profiles', env.RDSH_PROFILE || 'web');
}

const patchPath = (env) => join(profileDir(env), 'cordis.patch.yml');

function clean(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  if (text.length > MAX_FIELD) throw fail('RDSH_SUBAGENT_ROUTE_FIELD_TOO_LONG');
  return text;
}

function fail(code) {
  return Object.assign(new Error(code), { code });
}

async function readPatch(env) {
  try {
    const file = await lstat(patchPath(env));
    if (!file.isFile() || file.isSymbolicLink()) throw fail('RDSH_SUBAGENT_ROUTE_NOT_A_FILE');
    if (file.size > 1024 * 1024) throw fail('RDSH_SUBAGENT_ROUTE_TOO_LARGE');
    return await readFile(patchPath(env), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writePatch(text, env) {
  const path = patchPath(env);
  await mkdir(profileDir(env), { recursive: true });
  const temporary = join(profileDir(env), `.cordis.patch.yml.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Requested route from a JSON body: unknown keys and bad efforts are refused. */
export function routeFromBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('RDSH_SUBAGENT_ROUTE_INVALID_BODY');
  const allowed = new Set(['provider', 'model', 'reasoningEffort', 'clear']);
  if (Object.keys(body).some(key => !allowed.has(key))) throw fail('RDSH_SUBAGENT_ROUTE_UNKNOWN_FIELD');
  const effort = clean(body.reasoningEffort);
  if (!EFFORTS.includes(effort)) throw fail('RDSH_SUBAGENT_ROUTE_UNKNOWN_EFFORT');
  return {
    clear: body.clear === true,
    route: { provider: clean(body.provider), model: clean(body.model), reasoningEffort: effort },
  };
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail('RDSH_SUBAGENT_ROUTE_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw fail('RDSH_SUBAGENT_ROUTE_INVALID_JSON');
  }
}

/** Guard every mutating call with the page's own session token. */
function authorize(ctx, req, res) {
  if (typeof ctx.webServer?.authorize === 'function') return ctx.webServer.authorize(req, res);
  return true;
}

export function apply(ctx, config = {}) {
  const env = { ...process.env, ...(config.env || {}) };
  return ctx.effect(() => {
    if (!ctx.webServer) return;
    const off = ctx.webServer.register({
      kind: 'exact',
      path: '/api/rdsh-subagent-route',
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        try {
          if (req.method === 'GET' || req.method === 'HEAD') {
            const patch = await readPatch(env);
            return json(res, 200, {
              ok: true,
              supported: patch !== null,
              patch: isAbsolute(patchPath(env)) ? patchPath(env) : resolve(patchPath(env)),
              route: patch === null ? null : readRoute(patch),
              efforts: EFFORTS.filter(Boolean),
            });
          }
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
          const { clear, route } = routeFromBody(await readBody(req));
          const patch = await readPatch(env);
          if (patch === null) return json(res, 409, { ok: false, error: 'RDSH_SUBAGENT_ROUTE_NO_PROFILE' });
          const next = writeRoute(patch, clear ? null : route);
          if (next !== patch) await writePatch(next, env);
          return json(res, 200, { ok: true, route: clear ? null : readRoute(next) });
        } catch (error) {
          const code = typeof error?.code === 'string' && error.code.startsWith('RDSH_') ? error.code : 'RDSH_SUBAGENT_ROUTE_FAILED';
          return json(res, 400, { ok: false, error: code });
        }
      },
    });
    return () => {
      try {
        if (typeof off === 'function') off();
      } catch {}
    };
  });
}
