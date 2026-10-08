import { createHash } from 'node:crypto';
import { ExposureError } from './policy.js';

export const SEARCH = 'rdsh_mcp_search';
export const LOAD = 'rdsh_mcp_load';
export const STATUS = 'rdsh_mcp_status';
const RECEIPT = 'rdsh-mcp-load-v1';
const HELPER_NAMES = new Set([SEARCH, LOAD, STATUS]);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const clone = value => structuredClone(value);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b))
    .map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const schemaOf = definition => ({ name: definition.name, description: definition.description,
  parameters: clone(definition.parameters), output: clone(definition.output.schema) });

function project(session) {
  if (!session || typeof session.header?.cwd !== 'string' || typeof session.snapshotEvents !== 'function') return undefined;
  return digest({ cwd: session.header.cwd });
}

function receipt(value, projectId, max) {
  const r = value?.receipt ?? value;
  if (r?.format !== RECEIPT || r.project !== projectId || !Array.isArray(r.tools) || r.tools.length > Math.min(max, 64)) return undefined;
  if (!r.tools.every(tool => typeof tool?.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(tool.name)
    && typeof tool.digest === 'string' && /^[a-f0-9]{64}$/.test(tool.digest))) return undefined;
  return r;
}

function contentReceipt(content, projectId, max) {
  if (!Array.isArray(content)) return undefined;
  const text = content.find(block => block?.type === 'text' && typeof block.text === 'string')?.text;
  if (!text || Buffer.byteLength(text) > 4 * 1024 * 1024) return undefined;
  try { return receipt(JSON.parse(text), projectId, max); } catch { return undefined; }
}

/** Load receipts live in original tool/result and tool/ptc-dispatch records. */
class BranchLoads {
  constructor(max) { this.max = max; this.sessions = new WeakMap(); }
  state(session) {
    const projectId = project(session);
    if (!projectId) return { projectId: undefined, loaded: new Map(), pending: new Map() };
    let state = this.sessions.get(session);
    if (!state) {
      state = { projectId, seq: 0, calls: new Set(), loaded: new Map(), pending: new Map() };
      this.sessions.set(session, state);
    }
    for (const event of session.snapshotEvents(state.seq)) {
      let r;
      if (event.type === 'tool/call' && event.data.name === LOAD) state.calls.add(event.data.callId);
      if (event.type === 'tool/result' && state.calls.delete(event.data.message?.toolCallId)
        && event.data.message?.isError !== true) r = receipt(event.data.meta?.rdshMcpLoad, projectId, this.max);
      if (event.type === 'tool/ptc-dispatch' && event.data.name === LOAD && event.data.isError === false)
        r = contentReceipt(event.data.content, projectId, this.max);
      if (r) for (const tool of r.tools) {
        state.loaded.set(tool.name, tool.digest);
        if (state.pending.get(tool.name) === tool.digest) state.pending.delete(tool.name);
      }
      // A bounded receipt index; evicted historical names require discovery again.
      while (state.loaded.size > this.max) state.loaded.delete(state.loaded.keys().next().value);
      state.seq = event.seq + 1;
    }
    return state;
  }
  loaded(session) {
    const state = this.state(session);
    return new Map([...state.loaded, ...state.pending]);
  }
  settle(exec, result) {
    if (exec.name !== LOAD || result.isError) return;
    const state = this.state(exec.agent?.session);
    const r = receipt(result.value, state.projectId, this.max);
    if (!r || !state.projectId) return;
    for (const tool of r.tools) state.pending.set(tool.name, tool.digest);
  }
}

function abort(signal) { if (signal?.aborted) throw signal.reason ?? new Error('MCP discovery aborted'); }
function wait(promise, signal) {
  abort(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancelled = () => { cleanup(); reject(signal.reason ?? new Error('MCP discovery aborted')); };
    const cleanup = () => signal.removeEventListener('abort', cancelled);
    signal.addEventListener('abort', cancelled, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** A public-registration adapter; executions remain owned by the original registry. */
export class Discovery {
  constructor(registry, config, renderers) {
    this.registry = registry; this.config = config; this.renderers = renderers;
    this.records = new Map(); this.servers = new Map(); this.active = true;
    this.loads = new BranchLoads(config.maxLoadedTools);
    this.helpers = new Map();
    for (const policy of config.servers) this.servers.set(policy.serverName, { policy, startup: policy.mayConnect ? 'starting' : 'hidden', ready: Promise.resolve() });
  }
  bindHelpers(definitions) { for (const definition of definitions) this.helpers.set(definition.name, definition); }
  bridge(policy, routeIdentity) {
    return { register: definition => {
      if (!this.active) return () => {};
      const effective = policy.resolve(definition.name);
      // No schema or callback for a hidden tool enters the parent registry.
      if (effective.exposure === 'hidden') return () => {};
      if (this.records.has(definition.name)) throw new ExposureError('RDSH_MCP_NAMESPACE', 'A live MCP generation already owns this tool name');
      const schema = schemaOf(definition);
      const record = Object.freeze({ name: definition.name, server: policy.serverName, definition, schema,
        digest: digest({ route: routeIdentity, schema }), ...effective });
      const unregister = this.registry.register(definition);
      this.records.set(record.name, record);
      let removed = false;
      return () => {
        if (removed) return; removed = true;
        if (this.records.get(record.name) === record) this.records.delete(record.name);
        unregister();
      };
    } };
  }
  setReady(server, promise) {
    const item = this.servers.get(server);
    item.ready = promise.then(() => { if (this.active) item.startup = 'settled'; }, () => { if (this.active) item.startup = 'failed'; });
  }
  async ready(signal) { await wait(Promise.all([...this.servers.values()].map(server => server.ready)), signal); abort(signal); }
  current(name, scope) {
    const record = this.records.get(name);
    return record && this.registry.get(name, scope) === record.definition ? record : undefined;
  }
  visible(scope) {
    const names = new Set(this.registry.schemas(scope).map(tool => tool.name));
    return [...this.records.values()].filter(record => names.has(record.name) && this.current(record.name, scope))
      .sort((a, b) => compare(a.name, b.name));
  }
  loaded(scope) {
    const loaded = this.loads.loaded(scope?.session);
    return new Set([...loaded].filter(([name, version]) => this.current(name, scope)?.digest === version).map(([name]) => name));
  }
  guard(exec) {
    if (HELPER_NAMES.has(exec.name)) {
      return;
    }
    const server = [...this.servers.values()].find(item => exec.name.startsWith(item.policy.prefix));
    if (!server) return;
    const record = this.current(exec.name, exec.agent);
    // Scoped shadows belong to their own registration owner. Missing/withdrawn
    // names are already rejected by the original registry's resolver.
    if (!record) return;
    if (!this.active || server.policy.resolve(exec.name).exposure === 'hidden') return 'MCP tool is unavailable';
    if (exec.parent !== undefined || record.exposure === 'direct') return;
    if (record.exposure === 'ptc-only') return 'MCP tool is available only through the existing PTC runtime';
    if (this.loads.loaded(exec.agent?.session).get(record.name) !== record.digest)
      return 'Discover and load the MCP tool before a direct call';
  }
  settle(exec, result) {
    if (this.registry.get(LOAD, exec.agent) === this.helpers.get(LOAD)) this.loads.settle(exec, result);
  }
  revision(records) { return digest(records.map(record => [record.name, record.digest])); }
  async search(scope, args, signal) {
    const query = args.query ?? '';
    const offset = args.offset ?? 0, limit = args.limit ?? this.config.maxSearchResults;
    if (typeof query !== 'string' || Buffer.byteLength(query) > 1024 || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > this.config.maxSearchResults
      || (args.server !== undefined && typeof args.server !== 'string')
      || (args.revision !== undefined && typeof args.revision !== 'string'))
      throw new ExposureError('RDSH_MCP_SEARCH_INPUT', 'MCP search arguments are outside their supported range');
    await this.ready(signal);
    const visible = this.visible(scope), revision = this.revision(visible);
    if ((offset > 0 && !args.revision) || (args.revision && args.revision !== revision)) return { status: 'stale', revision, results: [], nextOffset: null };
    const terms = (query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(0, 32);
    const scored = visible.filter(record => !args.server || record.server === args.server).map(record => {
      const name = record.name.toLowerCase(), description = record.schema.description.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (name.includes(term) ? 4 : 0) + (description.includes(term) ? 1 : 0), 0);
      return { record, score };
    }).filter(item => !terms.length || item.score > 0).sort((a, b) => b.score - a.score || compare(a.record.name, b.record.name));
    const loaded = this.loaded(scope), page = scored.slice(offset, offset + limit);
    return { status: 'ok', revision, total: scored.length, results: page.map(({ record, score }) => ({
      name: record.name, server: record.server, description: record.schema.description.slice(0, 384),
      descriptionTruncated: record.schema.description.length > 384,
      exposure: record.exposure, source: clone(record.source), digest: record.digest, loaded: loaded.has(record.name), score,
    })), nextOffset: offset + page.length < scored.length ? offset + page.length : null };
  }
  async load(scope, args, signal) {
    if (!Array.isArray(args.names) || args.names.length < 1 || args.names.length > 64 || new Set(args.names).size !== args.names.length
      || !args.names.every(name => typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name))
      || (args.revision !== undefined && typeof args.revision !== 'string'))
      throw new ExposureError('RDSH_MCP_LOAD_INPUT', 'MCP load requires up to 64 unique public names');
    const projectId = project(scope?.session);
    if (!projectId) return { status: 'session_required' };
    await this.ready(signal);
    const visible = this.visible(scope), revision = this.revision(visible);
    if (args.revision && args.revision !== revision) return { status: 'stale', revision };
    const records = args.names.map(name => this.current(name, scope));
    if (records.some(record => !record)) return { status: 'not_found' };
    const loaded = this.loaded(scope);
    if (new Set([...loaded, ...args.names]).size > this.config.maxLoadedTools) return { status: 'limit', maxLoadedTools: this.config.maxLoadedTools };
    abort(signal);
    return { status: 'loaded', revision, receipt: { format: RECEIPT, project: projectId,
      tools: records.map(record => ({ name: record.name, digest: record.digest })) },
    tools: records.map(record => ({ name: record.name, server: record.server, exposure: record.exposure, source: clone(record.source),
      schema: clone(record.schema), types: Object.fromEntries(Object.entries(this.renderers).map(([language, render]) => [language, render([record.schema])])) })) };
  }
  status(scope) {
    const visible = this.visible(scope), loaded = this.loaded(scope);
    return { servers: [...this.servers.values()].map(({ policy, startup }) => ({ server: policy.serverName,
      source: policy.source, exposure: policy.fallback, startup,
      visibleTools: visible.filter(record => record.server === policy.serverName).length })),
    loadedTools: [...loaded].sort(compare), maxLoadedTools: this.config.maxLoadedTools };
  }
  present(assembly, context, language) {
    const loaded = this.loaded(context.scope);
    const declared = tool => {
      const record = this.current(tool.name, context.scope);
      if (!record) return true;
      return !!record && (record.exposure === 'direct' || (record.exposure === 'deferred' && loaded.has(tool.name)));
    };
    // SystemPrompt already owns canonical ordering, including explicit
    // toolOrder. Filtering in place retains every surviving position.
    const tools = assembly.tools.filter(declared);
    const render = this.renderers[language];
    let sections = assembly.sections;
    if (render && sections.some(section => section.name === 'tools:sdk' && section.text)) {
      const sdk = this.registry.schemas(context.scope).filter(tool => tool.name !== 'run_code')
        .map(tool => ({ ...tool, output: clone(this.registry.get(tool.name, context.scope).output.schema) }));
      const full = render(sdk);
      // Respect a catalog/budget extension that already replaced this section.
      sections = sections.map(section => section.name === 'tools:sdk' && section.text === full
        ? { ...section, text: render(sdk.filter(tool => {
          const record = this.current(tool.name, context.scope);
          return !record || record.exposure === 'direct' || record.exposure === 'ptc-only' || loaded.has(tool.name);
        })), interpolate: false } : section);
    }
    return { ...assembly, tools, sections };
  }
  dispose() { this.active = false; }
}
