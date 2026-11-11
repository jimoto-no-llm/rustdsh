// The adapter: one HTTP request per model call, plus the provider's own
// compaction when the input reaches the route's trigger. Dependencies come in
// as arguments so the same code runs under DSH and in the tests.
import { createHash } from 'node:crypto';
import * as openai from './responses.mjs';
import * as anthropic from './anthropic.mjs';
import { buildInput, splitForCompaction, estimateTokens, replayState } from './responses.mjs';

export const APIS = Object.freeze(['openai-responses', 'xai-responses', 'anthropic-messages']);
// What the reply says when a turn stops right after compaction.
export const PAUSE_NOTICE = 'The conversation was compacted. Send your next message to continue.';

function failure(error, status) {
  return { message: String(error?.message ?? error).slice(0, 500), code: error?.code ?? (status ? `HTTP_${status}` : 'TRANSPORT'),
    ...(status ? { status } : {}) };
}

export function checkProviders(providers = {}) {
  for (const [name, route] of Object.entries(providers)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new TypeError(`rdsh-llm-native: invalid provider name ${name}`);
    if (typeof route?.baseURL !== 'string' || !/^https?:\/\//.test(route.baseURL)) throw new TypeError(`rdsh-llm-native: ${name}.baseURL must be an http(s) URL`);
    if (route.api !== undefined && !APIS.includes(route.api)) throw new TypeError(`rdsh-llm-native: ${name}.api must be one of ${APIS.join(', ')}`);
    if (route.apiKeyEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(route.apiKeyEnv)) throw new TypeError(`rdsh-llm-native: ${name}.apiKeyEnv must name an environment variable`);
    if (!Array.isArray(route.models) || route.models.length === 0) throw new TypeError(`rdsh-llm-native: ${name}.models is required`);
    const messages = route.api === 'anthropic-messages';
    for (const model of route.models) {
      const where = `${name}/${model?.id}`;
      if (typeof model?.id !== 'string' || !model.id) throw new TypeError(`rdsh-llm-native: ${name} has a model without an id`);
      for (const key of ['contextWindow', 'maxTokens', 'compactAtTokens']) {
        if (model[key] !== undefined && (!Number.isSafeInteger(model[key]) || model[key] <= 0)) {
          throw new TypeError(`rdsh-llm-native: ${where}.${key} must be a positive integer`);
        }
      }
      for (const key of ['compactInBackground', 'pauseAfterCompaction']) {
        if (model[key] !== undefined && typeof model[key] !== 'boolean') throw new TypeError(`rdsh-llm-native: ${where}.${key} must be true or false`);
        if (model[key] && model.compactAtTokens === undefined) throw new TypeError(`rdsh-llm-native: ${where}.${key} needs compactAtTokens`);
      }
      if (model.compaction !== undefined && !(messages && ['on_demand', 'threshold'].includes(model.compaction))) {
        throw new TypeError(`rdsh-llm-native: ${where}.compaction is on_demand or threshold, on anthropic-messages routes only`);
      }
      if (model.compaction === 'threshold' && model.compactInBackground) {
        throw new TypeError(`rdsh-llm-native: ${where}: the server compacts in the threshold form; compactInBackground does not apply`);
      }
      if (model.compactInBackground && model.pauseAfterCompaction) {
        throw new TypeError(`rdsh-llm-native: ${where}: compactInBackground and pauseAfterCompaction cannot both be set`);
      }
      if (model.compactAtTokens !== undefined && model.contextWindow !== undefined && model.compactAtTokens >= model.contextWindow) {
        throw new TypeError(`rdsh-llm-native: ${where}.compactAtTokens must be below contextWindow`);
      }
    }
  }
  return providers;
}

/** How one API family is spoken. The rest of the adapter is the same for all. */
function wireOf(route, model) {
  if (route.api === 'anthropic-messages') {
    const threshold = model?.compaction === 'threshold' && model.compactAtTokens !== undefined
      ? { trigger: model.compactAtTokens, pause: Boolean(model.pauseAfterCompaction) } : undefined;
    return { itemsOf: anthropic.messageItems, path: '/messages', compactPath: '/messages', serverSide: Boolean(threshold),
      auth: secret => ({ ...anthropic.VERSION_HEADER, ...(secret ? { 'x-api-key': secret } : {}) }),
      // The beta header follows the block: a signed block needs it on every later request too.
      beta: hasWindow => (threshold ? { 'anthropic-beta': anthropic.THRESHOLD_BETA }
        : hasWindow ? { 'anthropic-beta': anthropic.ON_DEMAND_BETA } : {}),
      compactBeta: { 'anthropic-beta': anthropic.ON_DEMAND_BETA },
      body: args => anthropic.requestBody({ ...args, threshold }), compactBody: anthropic.compactBody,
      readCompact: anthropic.readCompact, read: anthropic.readResponse };
  }
  return { itemsOf: openai.messageItems, path: '/responses', compactPath: '/responses/compact', serverSide: false,
    auth: secret => (secret ? { authorization: `Bearer ${secret}` } : {}), beta: () => ({}), compactBeta: {},
    body: openai.requestBody, compactBody: openai.compactBody, readCompact: openai.readCompact,
    read: body => ({ ...openai.readResponse(body), window: undefined, paused: false }) };
}

/**
 * @param deps.LlmAdapter base class from `@deepseek-ai/dsh-llm`
 * @param deps.headers    attribution headers every provider request carries
 * @param deps.key        `(envName) => string | undefined`
 * @param deps.fetch      fetch implementation
 * @param deps.warn       diagnostics sink; never receives message bodies or keys
 */
export function createAdapter({ LlmAdapter, providers, headers = () => ({}), key = name => process.env[name],
  fetch: fetchImpl = fetch, warn = () => {} }) {
  checkProviders(providers);
  const modelOf = (provider, id) => providers[provider]?.models.find(model => model.id === id);

  async function post(route, wire, path, extra, body, signal) {
    const secret = route.apiKeyEnv ? key(route.apiKeyEnv) : undefined;
    const response = await fetchImpl(`${route.baseURL.replace(/\/$/, '')}${path}`, { method: 'POST', signal,
      headers: { ...headers(), 'content-type': 'application/json', ...wire.auth(secret), ...extra },
      body: JSON.stringify(body) });
    if (!response.ok) {
      const error = new Error(`the provider answered HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  // Background compaction, one job per session and route. A finished result
  // is used only if the history it was computed from is still exactly there;
  // otherwise it is dropped. It lives in memory: a process that exits loses
  // the job, and the next call simply compacts again.
  const jobs = new Map();
  const MAX_JOBS = 64;
  const BACKGROUND_TIMEOUT_MS = 300000;
  const fingerprint = items => createHash('sha256').update(JSON.stringify(items)).digest('hex');
  const headOf = (built, covered, wire) => [...(built.window?.items ?? []),
    ...built.history.slice(built.covered, covered).flatMap(wire.itemsOf)];
  const compact = (route, wire, options, instructions, head, signal) => post(route, wire, wire.compactPath, wire.compactBeta,
    wire.compactBody({ model: options.model, input: head, instructions, maxTokens: options.maxTokens }), signal)
    .then(wire.readCompact);

  function startJob(jobKey, route, wire, options, instructions, split) {
    if (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BACKGROUND_TIMEOUT_MS);
    const job = { fingerprint: fingerprint(split.head), covered: split.covered, anchor: split.anchor };
    job.promise = compact(route, wire, options, instructions, split.head, controller.signal)
      .then(items => { job.window = { items, covered: split.covered, anchor: split.anchor }; })
      .catch(error => {
        if (jobs.get(jobKey) === job) jobs.delete(jobKey);
        warn(`rdsh-llm-native: background compaction failed (${failure(error, error.status).code})`);
      })
      .finally(() => clearTimeout(timer));
    jobs.set(jobKey, job);
  }

  /** The finished job's window when it still matches the history, else undefined. */
  function takeJob(jobKey, built, wire) {
    const job = jobs.get(jobKey);
    if (!job?.window) return undefined;
    jobs.delete(jobKey);
    const current = job.covered <= built.history.length && job.covered >= built.covered
      && built.history[job.covered]?.id === job.anchor
      && fingerprint(headOf(built, job.covered, wire)) === job.fingerprint;
    if (!current) {
      warn('rdsh-llm-native: background compaction result discarded; the history changed while it ran');
      return undefined;
    }
    return job.window;
  }

  function* emit(blocks) {
    let index = 0;
    for (const block of blocks) {
      yield { type: 'block-start', index, blockType: block.type };
      if (block.type === 'text') yield { type: 'text-delta', index, text: block.text };
      else yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index, block };
      index++;
    }
  }

  return new class RdshNativeAdapter extends LlmAdapter {
    /** Resolves when no background compaction is in flight. */
    backgroundIdle() { return Promise.all([...jobs.values()].map(job => job.promise)); }
    providerInfo(provider) { return { id: provider, name: providers[provider]?.displayName ?? provider }; }
    async listModels(provider) {
      return (providers[provider]?.models ?? []).map(model => ({ provider, id: model.id, name: model.name ?? model.id }));
    }
    async resolveModel(provider, id) {
      const model = modelOf(provider, id);
      return { provider, id, name: model?.name ?? id,
        ...(model?.contextWindow ? { context: { contextWindow: model.contextWindow } } : {}),
        ...(model?.maxTokens ? { defaultMaxTokens: model.maxTokens } : {}) };
    }
    async *stream(options) {
      const route = providers[options.provider];
      const model = modelOf(options.provider, options.model);
      try {
        if (!route) throw new Error('unknown provider route');
        const wire = wireOf(route, options.purpose ? undefined : model);
        const built = buildInput(options.messages, { provider: options.provider, model: options.model }, wire.itemsOf);
        if (built.degraded) warn(`rdsh-llm-native: stored window ignored (${built.degraded}); sending the full history`);
        let { input, window } = built;
        let compactedNow = false;
        const instructions = options.system ?? built.instructions;
        const jobKey = model?.compactInBackground && options.sessionId && !options.purpose
          ? `${options.sessionId}\u0000${options.provider}\u0000${options.model}` : undefined;
        const ready = jobKey ? takeJob(jobKey, built, wire) : undefined;
        if (ready) {
          window = ready;
          input = [...ready.items, ...built.history.slice(ready.covered).flatMap(wire.itemsOf)];
        }
        // Auxiliary calls (titles, DSH's own summaries) are never compacted
        // here, and in the threshold form the server decides, not the adapter.
        const trigger = options.purpose || wire.serverSide ? undefined : model?.compactAtTokens;
        const split = trigger !== undefined && estimateTokens(input, instructions) >= trigger
          ? splitForCompaction(built, wire.itemsOf) : undefined;
        // With a window in force, compact again only once the part added since
        // is half the trigger. A window that is itself near the trigger would
        // otherwise be compacted on every call without getting smaller.
        const due = split && !ready && (!built.window || estimateTokens(split.grown) >= trigger / 2);
        if (due && jobKey) {
          // This call goes out as it is; the result is picked up by a later one.
          if (!jobs.has(jobKey)) startJob(jobKey, route, wire, options, instructions, split);
        } else if (due) {
          try {
            const items = await compact(route, wire, options, instructions, split.head, options.signal);
            window = { items, covered: split.covered, anchor: split.anchor };
            input = [...items, ...split.pending];
            compactedNow = true;
          } catch (error) {
            if (options.signal?.aborted) throw error;
            // The uncompacted input is still valid; nothing is dropped.
            warn(`rdsh-llm-native: provider compaction failed (${failure(error, error.status).code}); sending the input as it is`);
          }
        }
        if (compactedNow && model.pauseAfterCompaction) {
          // Stop here: the window is stored, the pending request stays in the
          // history behind it, and the next message continues from both.
          yield* emit([{ type: 'text', text: PAUSE_NOTICE }]);
          yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
          yield { type: 'finish', reason: { kind: 'stop' }, replayState: replayState(window) };
          return;
        }
        const reply = wire.read(await post(route, wire, wire.path, wire.beta(Boolean(window)),
          wire.body({ model: options.model, input, instructions, tools: options.tools, maxTokens: options.maxTokens }),
          options.signal));
        if (reply.window) {
          // The server compacted everything this request carried.
          window = { items: reply.window, covered: built.history.length };
        }
        yield* emit(reply.paused && reply.blocks.length === 0 ? [{ type: 'text', text: PAUSE_NOTICE }] : reply.blocks);
        yield { type: 'usage', usage: reply.usage };
        yield { type: 'finish', reason: reply.reason, replayState: replayState(window) };
      } catch (error) {
        const aborted = options.signal?.aborted;
        yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure: failure(error, error?.status) } };
      }
    }
  }();
}
