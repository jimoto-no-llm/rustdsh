import { createHash } from 'node:crypto';

const fail = (code) => Object.assign(new Error(code), { code });
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

/**
 * Shipped admission policy for fresh-context exploration. The code default
 * (`policy({})`) and the bundled `cordis.patch.yml` entry use these numbers, so
 * an installed profile and a code-only load admit the same work.
 *
 * `maxConcurrent` is the planner's own default wave size (`max_parallel: 3` in
 * `src/subagent_plan.rs`), so one default `rdsh subagents plan` wave is admitted
 * without queueing. `waitTimeoutMs` must outlast at least one concurrency batch
 * of real runs: the previous 10 s expired before a single scout run could
 * finish, which made the 8-deep queue unreachable and turned queued work into
 * `RDSH_SUBAGENT_WAIT_TIMEOUT` instead of waiting.
 */
export const DEFAULT_POLICY = Object.freeze({ maxConcurrent: 3, maxQueued: 8, waitTimeoutMs: 120000, maxPromptBytes: 65536, maxTokens: 4096, maxDepth: 1 });

export function policy(input = {}) {
  const value = { ...DEFAULT_POLICY, ...input };
  // The wait ceiling has to exceed one run, not one admission: a queue of 8
  // cannot drain inside 60 s when its predecessors are whole scout runs.
  const ranges = { maxConcurrent: [1, 32], maxQueued: [0, 64], waitTimeoutMs: [1, 600000], maxPromptBytes: [1, 1048576], maxTokens: [1, 131072], maxDepth: [0, 32] };
  if (Object.keys(value).some(key => !Object.hasOwn(ranges, key)) || Object.entries(ranges).some(([key, range]) => !integer(value[key], ...range)))
    throw fail('RDSH_SUBAGENT_INVALID_POLICY');
  return Object.freeze(value);
}

// The native runtime still owns Agent creation, model selection and disposal.
// Only one-shot, fresh-context delegation is admitted here; no result cache.
export function createOptimizer({ getBackend, snapshotContext, config, name = 'rdsh-scout' }) {
  const limits = policy(config);
  const parents = new WeakMap();
  const queue = [];
  const runs = new Set();
  const starting = new Set();
  const shutdown = new AbortController();
  let active = 0, closed = false, starts = 0, duplicates = 0;

  function drain() {
    while (!closed && active < limits.maxConcurrent && queue.length) {
      const entry = queue.shift();
      if (entry.signal.aborted) entry.cancel();
      else { active++; entry.cleanup(); entry.resolve(releaseSlot); }
    }
  }
  function releaseSlot() { active--; drain(); }
  function admit(signal) {
    if (closed) return Promise.reject(fail('RDSH_SUBAGENT_CLOSED'));
    if (signal.aborted) return Promise.reject(fail('RDSH_SUBAGENT_CANCELLED'));
    if (active < limits.maxConcurrent) { active++; return Promise.resolve(releaseSlot); }
    if (queue.length >= limits.maxQueued) return Promise.reject(fail('RDSH_SUBAGENT_QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, cleanup, cancel };
      const timer = setTimeout(() => cancel('RDSH_SUBAGENT_WAIT_TIMEOUT'), limits.waitTimeoutMs);
      function cleanup() { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
      function cancel(code) {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        cleanup();
        reject(fail(typeof code === 'string' ? code : 'RDSH_SUBAGENT_CANCELLED'));
      }
      signal.addEventListener('abort', cancel, { once: true });
      queue.push(entry);
    });
  }
  const provider = {
    name,
    inheritsParentContext: false,
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    get agentRouteDefaults() { return getBackend()?.agentRouteDefaults; },
    async start(request) {
      const backend = getBackend();
      if (!backend || backend === provider || backend.inheritsParentContext !== false || Object.keys(provider.capabilities).some(key => backend.capabilities?.[key] !== true))
        throw fail('RDSH_SUBAGENT_FRESH_BACKEND_REQUIRED');
      if (!request.parent || !request.signal || !Array.isArray(request.prompt)) throw fail('RDSH_SUBAGENT_INVALID_REQUEST');
      if (Buffer.byteLength(JSON.stringify(request.prompt), 'utf8') > limits.maxPromptBytes) throw fail('RDSH_SUBAGENT_PROMPT_TOO_LARGE');
      const context = snapshotContext(request.parent);
      const contextKey = JSON.stringify(context);
      const tokenLimits = [limits.maxTokens, context.agentOptions?.maxTokens, request.agentOptions?.maxTokens].filter(value => value !== undefined);
      if (tokenLimits.some(value => !integer(value, 1, Number.MAX_SAFE_INTEGER)) || (request.maxDepth !== undefined && !integer(request.maxDepth, 0, Number.MAX_SAFE_INTEGER)))
        throw fail('RDSH_SUBAGENT_INVALID_REQUEST');
      const signal = AbortSignal.any([request.signal, shutdown.signal]);
      const prepared = { ...request, signal, agentOptions: { ...request.agentOptions, maxTokens: Math.min(...tokenLimits) }, maxDepth: Math.min(limits.maxDepth, request.maxDepth ?? limits.maxDepth) };
      const key = createHash('sha256').update(JSON.stringify([contextKey, prepared.prompt, prepared.agentOptions, prepared.maxDepth, prepared.toolFilter, prepared.persona, prepared.outputSchema])).digest('hex');
      let keys = parents.get(request.parent);
      if (!keys) { keys = new Set(); parents.set(request.parent, keys); }
      if (keys.has(key)) { duplicates++; throw fail('RDSH_SUBAGENT_DUPLICATE_ACTIVE'); }
      keys.add(key);
      let release, owned;
      try {
        const releaseAdmission = await admit(signal);
        let returned = false;
        release = () => { if (!returned) { returned = true; releaseAdmission(); } };
        if (closed || signal.aborted) throw fail('RDSH_SUBAGENT_CANCELLED');
        // Queuing cannot silently adopt a new parent route, permission scope or
        // replacement backend. No await separates this check from native start.
        if (getBackend() !== backend || JSON.stringify(snapshotContext(request.parent)) !== contextKey)
          throw fail('RDSH_SUBAGENT_CONTEXT_CHANGED');
        const pending = Promise.resolve(backend.start(prepared));
        starting.add(pending);
        let run;
        try { run = await pending; } finally { starting.delete(pending); }
        starts++;
        let disposing, released = false;
        owned = {
          id: run.id,
          localAgent: run.localAgent,
          result: run.result,
          dispose() {
            if (released) return Promise.resolve();
            if (disposing) return disposing;
            disposing = Promise.resolve().then(() => run.dispose()).then(() => {
              released = true;
              runs.delete(owned);
              keys.delete(key);
              release();
            }, error => { disposing = null; throw error; });
            return disposing;
          },
        };
        runs.add(owned);
        if (closed) { await owned.dispose(); throw fail('RDSH_SUBAGENT_CLOSED'); }
        return owned;
      } catch (error) {
        if (!owned) { keys.delete(key); release?.(); }
        throw error;
      }
    },
  };
  return {
    provider,
    // Effective admission policy after config overrides, for operators and tests.
    limits,
    stats: () => ({ active, queued: queue.length, starts, duplicates }),
    async close() {
      closed = true;
      shutdown.abort(fail('RDSH_SUBAGENT_CLOSED'));
      for (const entry of [...queue]) entry.cancel('RDSH_SUBAGENT_CLOSED');
      await Promise.allSettled([...starting]);
      const results = await Promise.allSettled([...runs].map(run => run.dispose()));
      if (results.some(result => result.status === 'rejected')) throw fail('RDSH_SUBAGENT_CLEANUP_UNCONFIRMED');
    },
  };
}
