// Typert's public TypertSchema interface requires parse(), not a Zod instance.
// Using each live codec's own public projector also avoids importing a second
// Zod realm or relying on how a local-path plugin was linked into a profile.
export function schemaToJSON(schema, options) {
  if (typeof schema?.toJSONSchema !== 'function') throw new TypeError('Schema has no public JSON Schema projector');
  return schema.toJSONSchema(options);
}

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    version: { type: 'integer', const: 1 }, revision: { type: 'integer', minimum: 0 },
    actions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    warnings: { type: 'array', items: { type: 'object', additionalProperties: true } },
    httpAvailability: { type: 'string' },
  },
  required: ['version', 'revision', 'actions', 'warnings', 'httpAvailability'],
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function json(value, active = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || active.has(value) || (!Array.isArray(value) && !record(value))) return false;
  active.add(value);
  const valid = (Array.isArray(value) ? [...value] : Object.values(value)).every(child => json(child, active));
  active.delete(value);
  return valid;
}

export function createCatalogCodec() {
  return {
    parse(value) {
      if (!record(value) || Object.keys(value).length !== RESULT_SCHEMA.required.length
        || RESULT_SCHEMA.required.some(key => !Object.hasOwn(value, key))
        || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
        || typeof value.httpAvailability !== 'string'
        || !Array.isArray(value.actions) || !value.actions.every(record)
        || !Array.isArray(value.warnings) || !value.warnings.every(record) || !json(value))
        throw new TypeError('Invalid rdshTuiAdmin catalog result');
      return value;
    },
    toJSONSchema() { return structuredClone(RESULT_SCHEMA); },
  };
}

const documentText = { type: 'string', maxLength: 512 * 1024, writeOnly: true };
const revision = { type: 'string', pattern: '^[a-f0-9]{64}$' };
function simpleCodec(schema, check) {
  return { parse(value) { if (!check(value)) throw new TypeError('Invalid settings document value'); return value; },
    toJSONSchema() { return structuredClone(schema); } };
}
export const createDocumentContentCodec = () => simpleCodec(documentText,
  value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 512 * 1024);
export const createDocumentRevisionCodec = () => simpleCodec(revision,
  value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
export const createDocumentCodec = () => simpleCodec({ type: 'object', additionalProperties: false,
  required: ['path', 'content', 'revision', 'writable'], properties: {
    path: { type: 'string' }, content: documentText, revision, writable: { type: 'boolean' },
  } }, value => record(value) && Object.keys(value).length === 4 && typeof value.path === 'string'
    && typeof value.writable === 'boolean' && typeof value.content === 'string'
    && Buffer.byteLength(value.content, 'utf8') <= 512 * 1024 && /^[a-f0-9]{64}$/.test(value.revision));
export const createDocumentSavedCodec = () => simpleCodec({ type: 'object', additionalProperties: false,
  required: ['revision', 'applied', 'backupPath'], properties: {
    revision, applied: { const: true }, backupPath: { type: 'string' },
  } }, value => record(value) && Object.keys(value).length === 3 && value.applied === true
    && typeof value.backupPath === 'string' && /^[a-f0-9]{64}$/.test(value.revision));
