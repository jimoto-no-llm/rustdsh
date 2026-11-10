// Swaps the summarization instruction of DSH's basic compaction backend
// without re-implementing its summarizer. Everything else (trigger, retained
// tail, cut edges, overflow recovery, the summarization request itself) stays
// upstream code.
import { policyOptions, earlyConfig } from './policy.mjs';

/**
 * Split this plugin's own option from the options the upstream backend
 * accepts. The upstream constructor rejects unknown keys, so `instructions`
 * must not reach it.
 */
export function splitConfig(config) {
  const { instructions, ...base } = config ?? {};
  if (instructions === undefined || instructions === null) {
    return { instructions: undefined, base };
  }
  if (typeof instructions !== 'string' || instructions.trim().length === 0) {
    throw new TypeError('rdsh-compaction: instructions must be a non-blank string');
  }
  return { instructions, base };
}

/**
 * Return request options whose final message carries `text` instead of the
 * upstream instruction. The upstream summarizer replays the conversation
 * prefix and appends exactly one user text message; keeping that shape keeps
 * the provider's prefix cache warm.
 *
 * `history` is the message list handed to the summarizer. The request must be
 * that list, untouched, plus one message. Otherwise the final message may be
 * part of the conversation rather than the instruction, so refuse instead of
 * overwriting it.
 */
export function replaceInstruction(options, text, history) {
  const messages = options?.messages;
  const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
  const content = last?.content;
  const expected =
    options?.purpose === 'compaction' &&
    Array.isArray(messages) &&
    Array.isArray(history) &&
    messages.length === history.length + 1 &&
    history.every((message, index) => messages[index] === message) &&
    last?.role === 'user' &&
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === 'text' &&
    typeof content[0].text === 'string';
  if (!expected) {
    const error = new Error(
      'rdsh-compaction: unexpected summarizer request shape; instruction not replaced',
    );
    error.code = 'RDSH_COMPACTION_SHAPE';
    throw error;
  }
  const replaced = Object.freeze({
    ...last,
    content: Object.freeze([Object.freeze({ ...content[0], text })]),
  });
  return { ...options, messages: [...messages.slice(0, -1), replaced] };
}

// A read-through view of `target` that answers `name` with `value`.
function overlay(target, name, value) {
  return new Proxy(target, {
    get(inner, prop) {
      if (prop === name) return value;
      const found = inner[prop];
      return typeof found === 'function' ? found.bind(inner) : found;
    },
  });
}

// A context whose `llm.stream` rewrites the instruction. The shared `ctx.llm`
// service is never mutated, so concurrent sessions are unaffected.
function instructionContext(ctx, text, history) {
  const llm = ctx.llm;
  const stream = (options) => llm.stream(replaceInstruction(options, text, history));
  return overlay(ctx, 'llm', overlay(llm, 'stream', stream));
}

/**
 * Build the engine class on top of the upstream backend class.
 * Without `instructions` the upstream path runs untouched.
 */
export function withInstructions(Base, services = {}) {
  return class RdshCompactionEngine extends Base {
    constructor(ctx, config) {
      const policy = policyOptions(config);
      const { instructions, base } = splitConfig(policy.base);
      super(ctx, base);
      this.rdshInstructions = instructions;
      this.rdshPolicy = policy;
    }

    async compactIfNeeded(agent, trigger, signal) {
      const target = agent.session.requestHeader()?.config;
      const route = this.rdshPolicy?.routes.find(r => r.provider === target?.provider && r.model === target?.model);
      if (route?.method === 'off') return null;
      if (trigger === 'pressure' && this.rdshPolicy?.early) {
        let config;
        try { config = await earlyConfig(this, agent, signal, services); }
        catch { signal?.throwIfAborted(); } // Cost failure must not suppress pressure relief.
        if (config) {
          const view = Object.create(this, { config: { value: config } });
          return super.compactIfNeeded.call(view, agent, trigger, signal);
        }
      }
      return super.compactIfNeeded(agent, trigger, signal);
    }

    async summarize(input, agent, signal) {
      if (this.rdshInstructions === undefined) {
        return super.summarize(input, agent, signal);
      }
      const view = Object.create(this, {
        ctx: { value: instructionContext(this.ctx, this.rdshInstructions, input.messages) },
      });
      return super.summarize.call(view, input, agent, signal);
    }
  };
}
