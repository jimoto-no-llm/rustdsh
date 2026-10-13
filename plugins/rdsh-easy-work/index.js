import { createOrganizer } from './organizer.js';

export const name = 'rdsh-easy-work';
export const inject = [];
const codes = new Set(['PLAN_EXPIRED', 'TOO_MANY_PLANS', 'INVALID_FOLDER', 'FOLDER_CHANGED', 'FOLDER_TOO_LARGE',
  'CONFIRMATION_REQUIRED', 'PREVIEW_ONLY_PLATFORM', 'NOT_EXECUTABLE', 'FILES_CHANGED', 'COPY_FAILED', 'OUTPUT_CHANGED',
  'NOT_UNDOABLE', 'WORK_IN_PROGRESS', 'CLOSED']);
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
async function body(req) {
  let bytes = 0; const chunks = [];
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('bad-body');
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8192) throw new Error('bad-body');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bad-body');
  return value;
}

// UI-only endpoints. They are not model tools or MCP routes. Execution accepts
// only an opaque server-held preview id plus an explicit human confirmation.
export function registerWeb(ctx, organizer = createOrganizer()) {
  const off = ['preview', 'execute', 'undo', 'recover', 'status', 'release'].map(action => ctx.webServer.register({
    kind: 'exact', path: `/api/rdsh-easy-work/${action}`,
    async handler(req, res) {
      const rejection = typeof ctx.connection?.requestRejection === 'function' ? ctx.connection.requestRejection(req) : 503;
      if (rejection !== undefined) return json(res, rejection, { ok: false, error: 'GUI_AUTH_REQUIRED' });
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
      try {
        const value = await body(req);
        const result = action === 'preview' ? await organizer.preview(value.path)
          : action === 'execute' || action === 'undo' ? await organizer[action](value.id, value.confirmed)
          : await organizer[action](value.id);
        json(res, 200, { ok: true, result });
      } catch (error) {
        // File-system errors may contain paths. Do not expose their messages.
        json(res, 409, { ok: false, error: codes.has(error.code) ? error.code : 'REQUEST_FAILED' });
      }
    },
  }));
  return async () => { for (const dispose of off) dispose(); await organizer.close(); };
}
export function apply(ctx) {
  return ctx.effect(() => {
    const web = ctx.inject(['webServer', 'connection'], webCtx => webCtx.effect(() => registerWeb(webCtx)));
    return async () => { await web?.dispose(); };
  });
}
