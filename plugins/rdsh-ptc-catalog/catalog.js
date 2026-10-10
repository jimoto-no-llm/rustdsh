import { createHash } from 'node:crypto';

export const SEARCH = 'rdsh_catalog_search';
export const DESCRIBE = 'rdsh_catalog_describe';
export const CATALOG_VERSION = 1;

export class CatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new CatalogError('RDSH_CATALOG_INPUT', message);
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail(`${label} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function object(value, allowed) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key)))
    fail('Expected an object with only the documented fields');
  return value;
}

function string(value, maximum, label) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum)
    fail(`${label} must be a string of at most ${maximum} UTF-8 bytes`);
  return value;
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fold = text => text.normalize('NFKC').toLowerCase();

// This is a collision diagnostic, NEVER an execution alias.
export function normalizedIdentifier(name) {
  const identifier = name.normalize('NFKC').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(identifier) ? identifier : `_${identifier}`;
}

function namespaceOf(name) {
  const matches = [...name.matchAll(/\.|\/|:|__/g)];
  return matches.length === 0 ? '' : name.slice(0, matches.at(-1).index);
}

function inNamespace(name, namespace) {
  return !namespace || name === namespace ||
    ['.', '/', ':', '__'].some(separator => name.startsWith(namespace + separator));
}

function words(text) {
  return fold(text.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort(compare)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function brief(text) {
  const characters = [...text];
  return { description: characters.slice(0, 320).join(''), descriptionTruncated: characters.length > 320 };
}

export function validateConfig(config = {}) {
  object(config, ['inlineTokenBudget', 'inlineTools', 'maxSearchResults']);
  const inlineTokenBudget = integer(config.inlineTokenBudget ?? 16384, 1, 1048576, 'inlineTokenBudget');
  const inlineTools = config.inlineTools ?? [];
  if (!Array.isArray(inlineTools) || inlineTools.length > 128) fail('inlineTools must contain at most 128 exact names');
  for (const name of inlineTools) {
    string(name, 2048, 'inline tool name');
    if (!name || name === 'run_code' || name === SEARCH || name === DESCRIBE) fail('inlineTools must contain end-capability tool names');
  }
  if (new Set(inlineTools).size !== inlineTools.length) fail('inlineTools must not contain duplicate names');
  return Object.freeze({
    inlineTokenBudget,
    inlineTools: Object.freeze([...inlineTools]),
    maxSearchResults: integer(config.maxSearchResults ?? 20, 1, 100, 'maxSearchResults'),
  });
}

const DISCOVERY = `PTC tool discovery: only the catalog helpers and selected tools have inline declarations. Other callable tools, including declarations omitted to meet the budget, remain available through the original tools bindings. Use rdsh_catalog_search for names, relevance, namespaces and normalization collisions, then rdsh_catalog_describe for complete input/output schemas and the original SDK declaration. Use exact returned names; normalized identifiers are diagnostics, never aliases. These results do not grant permission: the original scope, guards, approval and typed-return checks still apply. The inline token budget uses UTF-8 bytes as a conservative upper bound for byte-based tokenizers; it is not a measured provider token count.`;

/** No global registry, cross-scope cache, model calls, or execution adapter. */
export function createCatalog(registry, renderers, config = {}) {
  if (typeof registry?.schemas !== 'function' || typeof registry?.get !== 'function')
    throw new CatalogError('RDSH_CATALOG_RUNTIME', 'The original DSH tools registry is required');
  const options = validateConfig(config);

  function render(schemas, language) {
    if (!Object.hasOwn(renderers, language) || typeof renderers[language] !== 'function')
      throw new CatalogError('RDSH_CATALOG_LANGUAGE', 'No original SDK renderer is available for this runtime language');
    return renderers[language](schemas);
  }

  function snapshot(scope) {
    // schemas(scope) is the public, already restricted view. Never read view(),
    // knownNames, plugins, MCP servers, or a sibling scope's registry.
    const entries = registry.schemas(scope).filter(schema => schema.name !== 'run_code')
      .map(schema => ({
        name: schema.name,
        description: typeof schema.description === 'string' ? schema.description : '',
        namespace: namespaceOf(schema.name),
        normalizedIdentifier: normalizedIdentifier(schema.name),
      })).sort((a, b) => compare(a.name, b.name));
    const collisions = new Map();
    for (const entry of entries) {
      const names = collisions.get(entry.normalizedIdentifier) ?? [];
      names.push(entry.name);
      collisions.set(entry.normalizedIdentifier, names);
    }
    return { entries, collisions, revision: digest(entries) };
  }

  function sdkSchema(scope, name, visibleSchemas = registry.schemas(scope)) {
    // Recheck this exact scope at describe/assembly time. The callback itself,
    // timeout metadata, internal guard reasons and server config never leave.
    const schema = visibleSchemas.find(candidate => candidate.name === name && name !== 'run_code');
    const definition = schema && registry.get(name, scope);
    if (!definition) return undefined;
    return {
      name: schema.name,
      description: schema.description,
      parameters: structuredClone(schema.parameters),
      output: structuredClone(definition.output.schema),
    };
  }

  function search(scope, input = {}) {
    object(input, ['query', 'namespace', 'identifier', 'offset', 'limit', 'revision']);
    const query = string(input.query ?? '', 1024, 'query').trim();
    const namespace = string(input.namespace ?? '', 2048, 'namespace');
    const identifier = input.identifier === undefined ? undefined : string(input.identifier, 4096, 'identifier');
    const offset = integer(input.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const limit = integer(input.limit ?? options.maxSearchResults, 1, options.maxSearchResults, 'limit');
    if (input.revision !== undefined) string(input.revision, 64, 'revision');
    const view = snapshot(scope);
    if (input.revision !== undefined && input.revision !== view.revision)
      return { version: CATALOG_VERSION, status: 'stale', revision: view.revision, tools: [], namespaces: [], total: 0, nextOffset: null };
    const terms = [...new Set(words(query))];
    const ranked = [];
    for (const entry of view.entries) {
      if (!inNamespace(entry.name, namespace) || (identifier !== undefined && entry.normalizedIdentifier !== identifier)) continue;
      const name = fold(entry.name), description = fold(entry.description);
      const nameWords = new Set(words(entry.name)), descriptionWords = new Set(words(entry.description));
      let score = query && name === fold(query) ? 10000 : query && name.startsWith(fold(query)) ? 1000 : 0;
      let matchedTerms = 0;
      for (const term of terms) {
        if (nameWords.has(term)) { score += 100; matchedTerms++; }
        else if (name.includes(term)) { score += 40; matchedTerms++; }
        else if (descriptionWords.has(term)) { score += 10; matchedTerms++; }
        else if (description.includes(term)) { score += 3; matchedTerms++; }
      }
      if (query && score === 0) continue;
      ranked.push({ entry, score, matchedTerms });
    }
    ranked.sort((a, b) => b.matchedTerms - a.matchedTerms || b.score - a.score || compare(a.entry.name, b.entry.name));
    const namespaces = new Map();
    for (const { entry } of ranked) namespaces.set(entry.namespace, (namespaces.get(entry.namespace) ?? 0) + 1);
    const namespaceList = [...namespaces].sort(([a], [b]) => compare(a, b));
    const page = ranked.slice(offset, offset + limit);
    return {
      version: CATALOG_VERSION, status: 'ok', revision: view.revision, total: ranked.length, offset,
      nextOffset: offset + page.length < ranked.length ? offset + page.length : null,
      namespaces: namespaceList.slice(0, options.maxSearchResults).map(([name, count]) => ({ name, count })),
      namespaceTotal: namespaceList.length, namespacesTruncated: namespaceList.length > options.maxSearchResults,
      tools: page.map(({ entry, score, matchedTerms }) => ({
        name: entry.name, ...brief(entry.description), namespace: entry.namespace,
        normalizedIdentifier: entry.normalizedIdentifier,
        normalizationCollision: view.collisions.get(entry.normalizedIdentifier).length > 1,
        score, matchedTerms,
      })),
    };
  }

  function describe(scope, input, language) {
    object(input, ['name', 'revision']);
    const name = string(input.name, 2048, 'name');
    if (input.revision !== undefined) string(input.revision, 64, 'revision');
    const view = snapshot(scope);
    // Missing and restricted tools have the exact same response. Even their
    // existence, namespace, collision group or schema is not acknowledged.
    if (!view.entries.some(entry => entry.name === name)) return { version: CATALOG_VERSION, status: 'not_found' };
    if (input.revision !== undefined && input.revision !== view.revision)
      return { version: CATALOG_VERSION, status: 'stale', revision: view.revision };
    const schema = sdkSchema(scope, name);
    if (!schema) return { version: CATALOG_VERSION, status: 'not_found' };
    const declaration = render([schema], language);
    const identifier = normalizedIdentifier(name), names = view.collisions.get(identifier);
    return {
      version: CATALOG_VERSION, status: 'ok', revision: view.revision,
      tool: { name: schema.name, description: schema.description, namespace: namespaceOf(name),
        input: schema.parameters, output: schema.output,
        schemaDigest: digest({ input: schema.parameters, output: schema.output }) },
      declaration: { language, source: declaration, tokenUpperBound: Buffer.byteLength(declaration, 'utf8') },
      normalizedIdentifier: identifier, normalizationCollision: names.length > 1,
      collisionNames: names.slice(0, options.maxSearchResults), collisionTotal: names.length,
      collisionNamesTruncated: names.length > options.maxSearchResults,
    };
  }

  function inline(scope, language, definitions) {
    for (const definition of definitions) {
      if (registry.get(definition.name, scope) !== definition)
        throw new CatalogError('RDSH_CATALOG_SCOPE_UNAVAILABLE', 'This PTC scope does not expose the catalog helpers; no declarations were silently omitted');
    }
    const visibleSchemas = registry.schemas(scope);
    const selected = definitions.map(definition => sdkSchema(scope, definition.name, visibleSchemas));
    const textOf = schemas => `${render(schemas, language)}\n\n${DISCOVERY}`;
    let text = textOf(selected);
    if (Buffer.byteLength(text, 'utf8') > options.inlineTokenBudget)
      throw new CatalogError('RDSH_CATALOG_BUDGET', `The inline budget cannot fit the mandatory discovery declarations (${Buffer.byteLength(text, 'utf8')} byte-based token upper bound); increase inlineTokenBudget`);
    const omitted = [];
    for (const name of options.inlineTools) {
      const schema = sdkSchema(scope, name, visibleSchemas);
      if (!schema) continue; // Do not echo a configured but unauthorized name.
      const candidate = textOf([...selected, schema]);
      if (Buffer.byteLength(candidate, 'utf8') <= options.inlineTokenBudget) {
        selected.push(schema);
        text = candidate;
      } else omitted.push(name);
    }
    return { text, tokenUpperBound: Buffer.byteLength(text, 'utf8'), budget: options.inlineTokenBudget,
      inlineNames: selected.map(schema => schema.name), omittedNames: omitted };
  }

  return Object.freeze({ search, describe, inline, options });
}
