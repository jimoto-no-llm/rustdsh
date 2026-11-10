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
