// Reflection only: invocation always stays in the authenticated Host gateway.
const secretName = /(?:password|secret|token|api.?key|credential|authorization)/i;
const own = (value, key) => Object.hasOwn(value, key);

function safeSchema(value, sensitive = false) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => safeSchema(item, sensitive));
  sensitive ||= value.writeOnly === true || value.format === 'password';
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (sensitive && ['default', 'examples', 'const', 'enum'].includes(key)) continue;
    if (['default', 'examples', 'const', 'enum'].includes(key)) { result[key] = safeLiteral(child); continue; }
    if (key === 'properties') result[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) =>
      [name, safeSchema(schema, sensitive || secretName.test(name) || schema?.writeOnly === true)]));
    else result[key] = safeSchema(child, sensitive || value.writeOnly === true || value.format === 'password');
  }
  return result;
}

function safeLiteral(value) {
  if (Array.isArray(value)) return value.map(safeLiteral);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretName.test(key)).map(([key, child]) => [key, safeLiteral(child)]));
}

function defaultsFor(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  if (own(schema, 'default')) return schema.default;
  if (schema.type !== 'object') return undefined;
  const entries = Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
    const value = defaultsFor(child);
    return value === undefined ? [] : [[key, value]];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

// Each codec is an independent JSON Schema document. Its local references must
// point to its new location when embedded under the combined wire-args schema.
function embeddedSchema(schema, wire) {
  const base = `#/properties/${wire.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  const relocate = value => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(relocate);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      key === '$ref' && typeof child === 'string' && (child === '#' || child.startsWith('#/'))
        ? base + child.slice(1) : relocate(child)]));
  };
  return relocate(schema);
}

function codecView(codec, toJSONSchema, warnings, id, wire, sensitive = false) {
  if (codec?.mode === 'src-json') return { mode: 'src-json', schema: {} };
  const result = { mode: codec?.mode ?? 'unknown', ...(codec?.typeSymbol ? { typeSymbol: codec.typeSymbol } : {}) };
  try {
    if (codec?.mode !== 'strict' || typeof codec.create !== 'function') throw new Error('codec unavailable');
    result.schema = safeSchema(toJSONSchema(codec.create(), { unrepresentable: 'any', io: 'input' }), sensitive);
  } catch {
    result.schema = {};
    result.projectionError = true;
    // A codec's error message may contain a value. Export a fixed diagnostic only.
    warnings.push({ id, wire, code: 'SCHEMA_PROJECTION_FAILED' });
  }
  return result;
}

/** Project only public metadata, without resolving lookups or calling methods. */
export function projectAction(descriptor, toJSONSchema, warnings = [], documentation = '') {
  const id = `${descriptor.namespace}/${descriptor.method}`;
  const properties = {}, required = [];
  const parameters = descriptor.parameters.map(parameter => {
    const codec = codecView(parameter.codec, toJSONSchema, warnings, id, parameter.wire, secretName.test(parameter.name));
    // Lookup codecs describe wire identities, never the resolved Host object.
    properties[parameter.wire] = embeddedSchema(codec.schema, parameter.wire);
    if (parameter.acceptsUndefined !== true) required.push(parameter.wire);
    return { name: parameter.name, wire: parameter.wire, source: parameter.source,
      ...(parameter.lookup ? { lookup: parameter.lookup } : {}), codec,
      acceptsUndefined: parameter.acceptsUndefined === true };
  });
  let invocation = { kind: 'direct' };
  if (descriptor.invocation.kind === 'context') {
    const { context, wire, codec } = descriptor.invocation;
    const projected = codecView(codec, toJSONSchema, warnings, id, wire);
    invocation = { kind: 'context', context, wire, codec: projected };
    properties[wire] = embeddedSchema(projected.schema, wire);
    required.push(wire);
  }
  const result = codecView(descriptor.result, toJSONSchema, warnings, id, '$result');
  const uplink = descriptor.uplink ? codecView(descriptor.uplink.codec, toJSONSchema, warnings, id, '$uplink') : undefined;
  const schema = { type: 'object', properties, required, additionalProperties: false };
  const mode = descriptor.mode === 'stream' ? 'stream' : 'unary';
  return { id, label: id, description: documentation || `Public Host method ${id}`, transport: 'rpc', mode,
    schema, defaults: defaultsFor(schema) ?? {}, availability: 'registered',
    sensitive: secretName.test(id) || parameters.some(parameter => secretName.test(parameter.name)) || JSON.stringify(schema).includes('"writeOnly":true'),
    ...(uplink ? { uplink: true, uplinkSchema: uplink.schema } : {}),
    descriptor: { id: descriptor.id, service: descriptor.service, namespace: descriptor.namespace,
      method: descriptor.method, mode, invocation, parameters, result,
      ...(descriptor.scope ? { scope: { ...descriptor.scope } } : {}),
      ...(descriptor.cancellation ? { cancellation: { ...descriptor.cancellation } } : {}),
      ...(uplink ? { uplink: { codec: uplink } } : {}) } };
}

export function createCatalogService(typert, toJSONSchema, httpActions = []) {
  let snapshot;
  let revision = 0;
  const unsubscribe = typert.local.subscribe(() => { snapshot = undefined; revision++; });
  return {
    catalog() {
      if (!snapshot) {
        const warnings = [];
        const docs = new Map();
        for (const record of typert.listPackages?.({ face: 'host' }) ?? [])
          for (const service of record.model?.services ?? [])
            for (const member of service.members ?? [])
              docs.set(`${service.key}/${member.name}`, member.summary ?? '');
        const actions = typert.local.list().map(descriptor => projectAction(descriptor, toJSONSchema, warnings,
          docs.get(`${descriptor.service}/${descriptor.method}`)));
        snapshot = { version: 1, revision, actions: [...actions, ...httpActions].sort((a, b) => a.id.localeCompare(b.id)), warnings,
          httpAvailability: 'manifest-only; disabled or unavailable routes return their normal HTTP error' };
      }
      return structuredClone(snapshot);
    },
    dispose() { unsubscribe(); snapshot = undefined; },
  };
}
