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
import { entries, readRoute, writeRoute } from './route.js';

const MAX_BODY = 4096;
const MAX_FIELD = 128;
const EFFORTS = Object.freeze(['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const name = 'rdsh-subagent-route';
export const inject = ['webServer', 'connection'];

function profileDir(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'profiles', env.RDSH_PROFILE || 'web');
}

function targetDirectory(ctx, config) {
  // Explicit fixture environments retain their isolated target. Normal Host
  // launches use the active profile even when --profile was not mirrored into
  // RDSH_PROFILE. ctx.get is Cordis's public optional-service lookup.
  if (config.env === undefined) {
    const profile = ctx.get?.('profileContext');
    if (profile !== undefined) {
      if (typeof profile?.dir !== 'string' || !isAbsolute(profile.dir)) throw fail('RDSH_SUBAGENT_ROUTE_INVALID_PROFILE');
      return resolve(profile.dir);
    }
  }
  return resolve(profileDir({ ...process.env, ...(config.env || {}) }));
}

const patchPath = directory => join(directory, 'cordis.patch.yml');

function clean(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  if (text.length > MAX_FIELD) throw fail('RDSH_SUBAGENT_ROUTE_FIELD_TOO_LONG');
  return text;
}

function fail(code) {
  return Object.assign(new Error(code), { code });
}

async function readPatch(directory) {
  try {
    const file = await lstat(patchPath(directory));
    if (!file.isFile() || file.isSymbolicLink()) throw fail('RDSH_SUBAGENT_ROUTE_NOT_A_FILE');
    if (file.size > 1024 * 1024) throw fail('RDSH_SUBAGENT_ROUTE_TOO_LARGE');
    return await readFile(patchPath(directory), 'utf8');
  } catch (error) {
    // A profile that never customized its patch layer starts from an empty
    // document; the first save creates it.
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function writePatch(text, directory) {
  const path = patchPath(directory);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.cordis.patch.yml.${randomUUID()}.tmp`);
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

function json(res, status, value, head = false) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
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

/** Use the same Host/Origin fence and signed browser cookie as public RPCs. */
async function authorize(ctx, req, res) {
  let status = 503;
  try {
    if (typeof ctx.connection?.admit === 'function') {
      // Await even though the current Host contract is synchronous. A Promise
      // is never itself evidence of authentication.
      const admission = await ctx.connection.admit(req);
      if (admission && typeof admission === 'object') {
        if (!Object.hasOwn(admission, 'rejection') && admission.peer
          && typeof admission.peer === 'object') return true;
        if (admission.rejection === 401 || admission.rejection === 403) status = admission.rejection;
      }
    }
  } catch {
    // Service failure must not make profile contents or writes public.
  }
  json(res, status, { ok: false, error: status === 401 ? 'unauthorized'
    : status === 403 ? 'forbidden' : 'authentication-unavailable' }, req.method === 'HEAD');
  return false;
}

export function apply(ctx, config = {}) {
  const directory = targetDirectory(ctx, config);
  return ctx.effect(() => {
    if (!ctx.webServer) return;
    const off = ctx.webServer.register({
      kind: 'exact',
      path: '/api/rdsh-subagent-route',
      handler: async (req, res) => {
        if (!await authorize(ctx, req, res)) return;
        try {
          if (req.method === 'GET' || req.method === 'HEAD') {
            const patch = await readPatch(directory);
            return json(res, 200, {
              ok: true,
              supported: true,
              patch: patchPath(directory),
              route: readRoute(patch),
              efforts: EFFORTS.filter(Boolean),
            }, req.method === 'HEAD');
          }
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
          const { clear, route } = routeFromBody(await readBody(req));
          const patch = await readPatch(directory);
          // Only an entry the profile declares itself can be pinned. A tool that
          // comes straight from a bundle layer is out of reach: writing a
          // top-level twin would land on the disabled base entry and change
          // nothing, so the caller is told instead.
          if (entries(patch.split('\n')).length === 0) {
            return json(res, 409, { ok: false, error: 'RDSH_SUBAGENT_ROUTE_NO_ENTRY' });
          }
          const next = writeRoute(patch, clear ? null : route);
          if (next !== patch) await writePatch(next, directory);
          return json(res, 200, { ok: true, route: readRoute(next) });
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
