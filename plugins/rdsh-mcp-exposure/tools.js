import { LOAD, SEARCH, STATUS } from './discovery.js';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
const output = { type: 'object', additionalProperties: true };
const string = { type: 'string' }, integer = { type: 'integer' };

export function discoveryTools(discovery) {
  const make = (name, description, parameters, execute) => ({ name, description, parameters,
    output: { schema: output, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      ...(name === LOAD ? { presentationMeta: (_args, value) => value.receipt ? { rdshMcpLoad: value.receipt } : {} } : {}) },
    classifyExecution: () => ({ concurrencySafe: name !== LOAD }),
    async execute(args, exec) { return execute(exec.agent, args, exec.signal); },
  });
  return [
    make(SEARCH, 'Search visible MCP tool metadata. Results use original DSH public names and show effective exposure and configuration source. Use rdsh_mcp_load for complete schemas before a deferred direct call.',
      object({ query: string, server: string, offset: integer, limit: integer, revision: string }),
      (scope, args, signal) => discovery.search(scope, args, signal)),
    make(LOAD, 'Load complete input/output schemas and TypeScript/Python declarations for selected visible MCP tools into this session branch. This does not grant permission or enable PTC; ordinary guards still apply.',
      { ...object({ names: { type: 'array', items: string, minItems: 1, maxItems: 64, uniqueItems: true }, revision: string }), required: ['names'] },
      (scope, args, signal) => discovery.load(scope, args, signal)),
    make(STATUS, 'Inspect configured MCP exposure sources and visible loaded names on this session branch. Connection credentials and hidden tool metadata are omitted.',
      object({}), scope => discovery.status(scope)),
  ];
}
