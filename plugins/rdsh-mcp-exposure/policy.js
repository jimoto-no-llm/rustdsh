export const EXPOSURES = Object.freeze(['direct', 'deferred', 'ptc-only', 'hidden']);
const SERVER = /^[A-Za-z0-9_-]{1,32}$/;
const PUBLIC_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PATTERN = /^[A-Za-z0-9_*-]{1,128}$/;

export class ExposureError extends Error {
  constructor(code, message) { super(message); this.name = 'ExposureError'; this.code = code; }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new ExposureError('RDSH_MCP_CONFIG', `${label} must be an object`);
}

function keys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key))
    throw new ExposureError('RDSH_MCP_CONFIG', `${label} contains an unsupported field`);
}

export function exposure(value, label) {
  if (!EXPOSURES.includes(value)) throw new ExposureError('RDSH_MCP_CONFIG', `${label} must be direct, deferred, ptc-only, or hidden`);
  return value;
}

/** Rules address the original DSH public name, including its collision hash. */
export function compileServer(input, index = 0) {
  object(input, 'server');
  keys(input, ['connection', 'exposure', 'toolExposure', 'source'], 'server');
  object(input.connection, 'connection');
  const serverName = input.connection.serverName;
  if (!SERVER.test(serverName ?? '')) throw new ExposureError('RDSH_MCP_CONFIG', 'connection.serverName is invalid');
  const source = input.source ?? `cordis.servers[${index}]`;
  if (typeof source !== 'string' || Buffer.byteLength(source) > 128 || /[\r\n\0]/.test(source))
    throw new ExposureError('RDSH_MCP_CONFIG', 'source must be a short single-line configuration label');
  const fallback = exposure(input.exposure ?? 'deferred', 'server.exposure');
  const raw = input.toolExposure ?? [];
  if (!Array.isArray(raw) || raw.length > 256) throw new ExposureError('RDSH_MCP_CONFIG', 'toolExposure must contain at most 256 ordered rules');
  const exact = new Map(), patterns = [];
  const prefix = `mcp__${serverName}__`;
  const rules = raw.map((rule, order) => {
    object(rule, 'toolExposure rule');
    keys(rule, ['match', 'exposure'], 'toolExposure rule');
    if (typeof rule.match !== 'string' || !PATTERN.test(rule.match) || !rule.match.startsWith(prefix))
      throw new ExposureError('RDSH_MCP_CONFIG', 'toolExposure must name this server using the original DSH public namespace');
    const mode = exposure(rule.exposure, 'toolExposure.exposure');
    const entry = Object.freeze({ match: rule.match, exposure: mode, order });
    if (rule.match.includes('*')) {
      // Only the explicitly allowed wildcard has a regex meaning.
      const regex = new RegExp(`^${rule.match.replaceAll('*', '.*')}$`);
      patterns.push({ ...entry, regex });
    } else {
      if (!PUBLIC_NAME.test(rule.match) || exact.has(rule.match))
        throw new ExposureError('RDSH_MCP_CONFIG', 'exact toolExposure names must be unique valid public names');
      exact.set(rule.match, entry);
    }
    return entry;
  });
  return Object.freeze({
    serverName, source, prefix, fallback, rules,
    hasDirect: fallback === 'direct' || rules.some(rule => rule.exposure === 'direct'),
    mayConnect: fallback !== 'hidden' || rules.some(rule => rule.exposure !== 'hidden'),
    needsPtc: fallback === 'ptc-only' || rules.some(rule => rule.exposure === 'ptc-only'),
    resolve(name) {
      if (!PUBLIC_NAME.test(name) || !name.startsWith(prefix))
        throw new ExposureError('RDSH_MCP_NAMESPACE', 'The MCP client supplied a name outside its reserved namespace');
      const match = exact.get(name) ?? patterns.find(rule => rule.regex.test(name));
      return Object.freeze({
        exposure: match?.exposure ?? fallback,
        source: Object.freeze({ configuration: source,
          path: match ? `toolExposure[${match.order}]` : 'exposure',
          kind: match ? (exact.has(name) ? 'exact' : 'pattern') : 'server',
          ...(match ? { match: match.match, order: match.order } : {}) }),
      });
    },
  });
}

export function compileConfig(input = {}) {
  object(input, 'config');
  keys(input, ['servers', 'maxSearchResults', 'maxLoadedTools'], 'config');
  if (!Array.isArray(input.servers) || input.servers.length < 1 || input.servers.length > 64)
    throw new ExposureError('RDSH_MCP_CONFIG', 'servers must contain between 1 and 64 connections');
  const maxSearchResults = input.maxSearchResults ?? 20;
  const maxLoadedTools = input.maxLoadedTools ?? 512;
  for (const [name, value, max] of [['maxSearchResults', maxSearchResults, 100], ['maxLoadedTools', maxLoadedTools, 4096]])
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new ExposureError('RDSH_MCP_CONFIG', `${name} is outside its supported range`);
  const servers = input.servers.map(compileServer);
  const names = new Set();
  for (const server of servers) {
    if (names.has(server.serverName)) throw new ExposureError('RDSH_MCP_CONFIG', 'Each serverName must be unique in this bundle');
    names.add(server.serverName);
  }
  return Object.freeze({ servers, maxSearchResults, maxLoadedTools });
}
