// Explicit public routes audited against the sibling plugins' handlers.
// Presence is deliberately not inferred from private router/loader internals.
const object = (properties = {}, required = [], additionalProperties = false) => ({ type: 'object', properties, required, additionalProperties });
const text = (maxLength = 128) => ({ type: 'string', minLength: 1, maxLength });
const jsonObject = object({}, [], true);
const integer = { type: 'integer', minimum: 0 };
function route(plugin, method, suffix, label, schema = object(), extra = {}) {
  const path = `/api/${plugin}${suffix}`;
  return { id: `${method} ${path}`, label, description: `${plugin} public HTTP endpoint; requires the existing authenticated Host connection`,
    transport: 'http', method, path, mode: 'unary', schema, defaults: {}, availability: 'manifest',
    mutation: method !== 'GET', ...extra };
}
const config = object({ config: jsonObject }, ['config']);
const id = object({ id: text(256) }, ['id']);
const confirmed = object({ id: text(256), confirmed: { const: true, type: 'boolean' } }, ['id', 'confirmed']);
const blocks = { type: 'array', minItems: 1, maxItems: 200, items: object({
  id: text(), kind: { type: 'string', enum: ['text', 'heading', 'caption', 'code', 'callout', 'status-badge',
    'key-value', 'simple-table', 'card', 'row', 'column', 'choice', 'button', 'form',
    'dev.diff-split', 'dev.test-results', 'chart.line', 'chart.bar', 'agent.approval'] }, data: jsonObject,
}, ['id', 'kind', 'data'], true) };

export const httpActions = [
  route('rdsh-settings', 'GET', '', 'RDSH settings', object(), { sensitive: true }),
  route('rdsh-settings', 'POST', '/save', 'Save RDSH settings', config, { sensitive: true }),
  route('rdsh-context', 'GET', '', 'RDSH context settings'),
  route('rdsh-context', 'POST', '/save', 'Save context settings', config),
  route('rdsh-discord', 'GET', '', 'Discord presence status'),
  route('rdsh-discord', 'GET', '/icon', 'Discord presence icon', object(), { responseType: 'binary', mediaType: 'image/png' }),
  route('rdsh-subagent-route', 'GET', '', 'Default child model route'),
  route('rdsh-subagent-route', 'POST', '', 'Set default child model route', object({
    provider: { type: 'string', maxLength: 128 }, model: { type: 'string', maxLength: 128 },
    reasoningEffort: { type: 'string', enum: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }, clear: { type: 'boolean' },
  })),
  route('rdsh-easy-work', 'POST', '/preview', 'Preview folder organization', object({ path: text(4096) }, ['path'])),
  route('rdsh-easy-work', 'POST', '/execute', 'Execute approved folder plan', confirmed),
  route('rdsh-easy-work', 'POST', '/undo', 'Undo approved folder plan', confirmed),
  ...['recover', 'status', 'release'].map(action => route('rdsh-easy-work', 'POST', `/${action}`, `Folder plan ${action}`, id)),
  route('rdsh-agent-ui', 'GET', '/surface', 'Agent UI surface'),
  route('rdsh-agent-ui', 'POST', '/surface', 'Publish agent UI surface', object({
    blocks, surface_id: text(), revision: integer, turn: integer,
  }, ['blocks'], true)),
  route('rdsh-agent-ui', 'GET', '/action', 'Agent UI human actions', object({ after: integer }), { query: ['after'] }),
  route('rdsh-agent-ui', 'POST', '/action', 'Submit agent UI human action', object({
    request_id: text(), action_id: text(), surface_id: text(), surface_revision: integer,
    block_id: text(), action_kind: text(64), label: text(256), value: {},
  }, ['request_id', 'action_id']), { sensitive: true }),
  route('rdsh-agent-ui', 'POST', '/anchor', 'Attach agent UI surface to turn', object({
    surface_id: text(), surface_revision: integer, turn: integer,
  }, ['surface_id', 'turn'])),
  route('rdsh-update', 'GET', '', 'Update state'),
  ...[['/run', 'RDSH'], ['/dsh/run', 'DSH'], ['/rustxng/run', 'RustXNG']].map(([path, label]) =>
    route('rdsh-update', 'POST', path, `Run ${label} update`, object(), { confirmation: 'Updates installed application files' })),
  route('rdsh-update', 'POST', '/dismiss', 'Dismiss current update notice', object({
    kind: text(64), to: text(512), at: { type: 'number' }, cycle: integer,
  }, ['kind', 'to'])),
  route('rdsh-update', 'GET', '/events', 'Update event stream', object(), { mode: 'stream', streamFormat: 'sse' }),
  route('rdsh-translation', 'GET', '/config', 'Translation settings'),
];
