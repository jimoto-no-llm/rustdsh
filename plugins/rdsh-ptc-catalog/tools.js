import { SEARCH, DESCRIBE } from './catalog.js';

const textResult = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];
const json = {};
const string = { type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const arrayOf = items => ({ type: 'array', items });
const objectOf = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const envelope = properties => ({ schema: { type: 'object', properties, required: ['version', 'status'], additionalProperties: false }, render: textResult });

export function catalogTools(catalog, getLanguage) {
  return [
    {
      name: SEARCH,
      description: 'Search only this calling scope\'s visible tools by relevance, exact namespace prefix or normalized identifier. Results use exact names; collisions never create aliases. Empty query pages the thin catalog. Describe a selected name for complete types; pass revision when paging to detect changes.',
      parameters: objectOf({
        query: { type: 'string', description: 'Words in names/descriptions; empty lists the catalog.' },
        namespace: { type: 'string', description: 'Exact namespace prefix; separators are dot, slash, colon or double underscore.' },
        identifier: { type: 'string', description: 'Exact normalized identifier to inspect a collision group.' },
        offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: catalog.options.maxSearchResults },
        revision: string,
      }, []),
      output: envelope({
        version: integer, status: string, revision: string, total: integer, offset: integer,
        nextOffset: { oneOf: [integer, { type: 'null' }] },
        namespaces: arrayOf(objectOf({ name: string, count: integer })),
        namespaceTotal: integer, namespacesTruncated: boolean,
        tools: arrayOf(objectOf({ name: string, description: string, descriptionTruncated: boolean,
          namespace: string, normalizedIdentifier: string, normalizationCollision: boolean, score: integer, matchedTerms: integer })),
      }),
      isConcurrencySafe: () => true,
      async execute(args, exec) { exec.signal.throwIfAborted(); return catalog.search(exec.agent, args); },
    },
    {
      name: DESCRIBE,
      description: 'Get one currently visible exact tool name\'s complete input/output JSON Schemas and original TypeScript/Python SDK declaration. Missing/restricted names share not_found. Types are advisory; calling still uses the original guards, policy, scheduler and typed-return validation.',
      parameters: objectOf({ name: string, revision: string }, ['name']),
      output: envelope({
        version: integer, status: string, revision: string,
        tool: objectOf({ name: string, description: string, namespace: string, input: json, output: json, schemaDigest: string }),
        declaration: objectOf({ language: string, source: string, tokenUpperBound: integer }),
        normalizedIdentifier: string, normalizationCollision: boolean,
        collisionNames: arrayOf(string), collisionTotal: integer, collisionNamesTruncated: boolean,
      }),
      isConcurrencySafe: () => true,
      async execute(args, exec) { exec.signal.throwIfAborted(); return catalog.describe(exec.agent, args, getLanguage()); },
    },
  ];
}
