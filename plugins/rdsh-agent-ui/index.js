// Host half of the in-conversation agent UI.
//
// It only stores and returns what the Web chat asks for: the surface the agent
// published and the actions a human took on it. Every route needs the DSH GUI
// session, so a page in another origin cannot read or post either file.
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  readSurface, writeSurface, appendAction, readActions, actionsSince, anchorSurface,
} from './store.js';

export const inject = [];

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

async function readBody(req, maximum = 32768) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

// Same guard as the settings prototype: no GUI session and matching Host means
// no answer, so an unrelated page cannot drive the panel.
function authorize(ctx, req, res) {
  const status = typeof ctx.connection?.requestRejection === 'function'
    ? ctx.connection.requestRejection(req) : 503;
  if (status === undefined) return true;
  json(res, status, {
    ok: false,
    error: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'authentication-unavailable',
  });
  return false;
}

export function registerWeb(ctx) {
  return ctx.effect(() => {
    const offSurface = ctx.webServer.register({
      kind: 'exact',
      path: '/api/rdsh-agent-ui/surface',
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method === 'GET' || req.method === 'HEAD') {
          const result = await readSurface(dshHome());
          if (result.error) return json(res, 200, { ok: true, surface: null, error: result.error });
          return json(res, 200, { ok: true, surface: result.surface, error: null });
        }
        if (req.method === 'POST') {
          try {
            const written = await writeSurface(dshHome(), await readBody(req));
            if (!written.ok) return json(res, 400, { ok: false, error: written.error });
            return json(res, 200, { ok: true, published_at: written.surface.published_at });
          } catch (error) {
            return json(res, 400, { ok: false, error: error.message === 'body-too-large' ? 'body-too-large' : 'bad-request' });
          }
        }
        return json(res, 405, { ok: false, error: 'method-not-allowed' });
      },
    });
    const offAction = ctx.webServer.register({
      kind: 'exact',
      path: '/api/rdsh-agent-ui/action',
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method === 'GET' || req.method === 'HEAD') {
          const after = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('after') || 0);
          const actions = await readActions(dshHome());
          return json(res, 200, { ok: true, ...actionsSince(actions, after) });
        }
        if (req.method === 'POST') {
          try {
            const appended = await appendAction(dshHome(), await readBody(req, 16384));
            return json(res, appended.ok ? 200 : 400, appended);
          } catch (error) {
            return json(res, 400, { ok: false, error: error.message === 'body-too-large' ? 'body-too-large' : 'bad-request' });
          }
        }
        return json(res, 405, { ok: false, error: 'method-not-allowed' });
      },
    });
    const offAnchor = ctx.webServer.register({
      kind: 'exact',
      path: '/api/rdsh-agent-ui/anchor',
      handler: async (req, res) => {
        if (!authorize(ctx, req, res)) return;
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' });
        try {
          const anchored = await anchorSurface(dshHome(), await readBody(req, 4096));
          return json(res, anchored.ok ? 200 : 409, anchored);
        } catch {
          return json(res, 400, { ok: false, error: 'bad-request' });
        }
      },
    });
    return () => {
      for (const off of [offSurface, offAction, offAnchor]) if (typeof off === 'function') off();
    };
  });
}

export function apply(ctx) {
  return ctx.effect(() => {
    // Cordis injection is a required-service map, so mount HTTP separately.
    const web = ctx.inject(['webServer', 'connection'], (webCtx) => registerWeb(webCtx));
    return async () => {
      await web?.dispose();
    };
  });
}
