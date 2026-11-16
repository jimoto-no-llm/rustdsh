// OpenAI Responses wire shapes for the adapter. Pure functions: no I/O.
//
// A compacted window is opaque. It is stored exactly as the provider returned
// it and sent back exactly as stored; nothing here reads, reorders or edits
// the items inside it.

export const REPLAY_KIND = 'rdsh-llm-native';
export const REPLAY_VERSION = 1;

const text = blocks => blocks.filter(block => block.type === 'text').map(block => block.text).join('');

function unsupported(block) {
  const error = new Error(`rdsh-llm-native: a ${block.type} block cannot be sent on this route`);
  error.code = 'UNSUPPORTED_CONTENT';
  return error;
}

/** Input items for one DSH message. Reasoning is not replayed. */
export function messageItems(message) {
  const blocks = message.content ?? [];
  for (const block of blocks) {
    if (['image', 'file', 'tool-addition', 'tool-removal'].includes(block.type)) throw unsupported(block);
  }
  switch (message.role) {
    case 'system':
    case 'developer':
      return [{ role: 'developer', content: [{ type: 'input_text', text: text(blocks) }] }];
    case 'user':
      return [{ role: 'user', content: [{ type: 'input_text', text: text(blocks) }] }];
    case 'tool':
      return [{ type: 'function_call_output', call_id: message.source.callId, output: text(blocks) }];
    case 'assistant': {
      const items = [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text }] });
        } else if (block.type === 'tool-call') {
          items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments });
        }
      }
      return items;
    }
    default:
      throw new Error(`rdsh-llm-native: unknown message role ${message.role}`);
  }
}

/** The window an assistant message carries, when this adapter stored one. */
export function storedWindow(message, route) {
  const state = message?.source?.replayState?.response;
  if (!state || state.kind !== REPLAY_KIND || state.version !== REPLAY_VERSION) return undefined;
  if (message.source.provider !== route.provider || message.source.model !== route.model) return undefined;
  const window = state.window;
  if (!window || !Array.isArray(window.items) || !Number.isSafeInteger(window.covered) || window.covered < 1) return undefined;
  return window;
}

/**
 * Build the request input from DSH history.
 *
 * The leading system message becomes `instructions`. A compacted window
 * stands for `history[0, covered)`: when an earlier response of the same route
 * carries one, those messages are dropped and the window goes first,
 * unchanged. Later replies carry the same window forward until the provider
 * compacts again. A window that no longer lines up with the history (its
 * count is past the carrying message, or the first kept message is not the one
 * it was stored with) is not used: the full history is sent and `degraded`
 * says why.
 */
export function buildInput(messages, route, itemsOf = messageItems) {
  const leading = messages[0]?.role === 'system' ? messages[0] : undefined;
  const history = leading ? messages.slice(1) : messages;
  const instructions = leading ? text(leading.content) : undefined;
  let degraded;
  for (let index = history.length - 1; index >= 0; index--) {
    const window = history[index].role === 'assistant' ? storedWindow(history[index], route) : undefined;
    if (!window) continue;
    if (window.covered > index || (window.anchor !== undefined && history[window.covered]?.id !== window.anchor)) {
      degraded = 'window_does_not_match_history';
      break;
    }
    return { instructions, history, window, covered: window.covered,
      input: [...window.items, ...history.slice(window.covered).flatMap(itemsOf)] };
  }
  return { instructions, history, covered: 0, input: history.flatMap(itemsOf), degraded };
}

/**
 * What to hand to the provider's compaction and what to keep out of it.
 *
 * Only messages before the active turn are compacted. The turn itself stays
 * verbatim behind the new window, so the call that follows always carries the
 * question being asked, whatever the provider chooses to keep inside the
 * window.
 * @returns undefined when nothing lies before the active turn.
 */
export function splitForCompaction(built, itemsOf = messageItems) {
  const { history, window, covered } = built;
  // The active turn starts at the first of the user/developer messages that
  // opened it (DSH adds a runtime-context message beside the prompt) and runs
  // to the end, tool calls and results included.
  const opens = message => message.role === 'user' || message.role === 'developer';
  let pendingAt = -1;
  for (let index = history.length - 1; index >= covered; index--) {
    if (history[index].role === 'user') { pendingAt = index; break; }
  }
  if (pendingAt < 0) return undefined;
  while (pendingAt > covered && opens(history[pendingAt - 1])) pendingAt--;
  const older = history.slice(covered, pendingAt).flatMap(itemsOf);
  if (older.length === 0) return undefined;
  return { head: [...(window?.items ?? []), ...older], pending: history.slice(pendingAt).flatMap(itemsOf),
    covered: pendingAt, anchor: history[pendingAt].id, grown: older };
}

/** A rough size for the trigger. It only has to be stable, not exact. */
export function estimateTokens(input, instructions = '') {
  return Math.ceil((JSON.stringify(input).length + instructions.length) / 4);
}

export function requestBody({ model, input, instructions, tools, maxTokens }) {
  const body = { model, input, store: false };
  if (instructions) body.instructions = instructions;
  if (tools?.length) {
    body.tools = tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description,
      parameters: tool.parameters }));
  }
  if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
  return body;
}

export function compactBody({ model, input, instructions }) {
  return instructions ? { model, input, instructions } : { model, input };
}

/** The compacted window from a `/responses/compact` reply, as returned. */
export function readCompact(body) {
  const output = body?.output;
  if (!Array.isArray(output) || output.length === 0) throw new Error('rdsh-llm-native: the compaction reply has no output');
  const compaction = output.filter(item => item?.type === 'compaction');
  if (compaction.length !== 1 || typeof compaction[0].encrypted_content !== 'string' || !compaction[0].encrypted_content) {
    throw new Error('rdsh-llm-native: the compaction reply must hold exactly one compaction item');
  }
  return output;
}

function usageOf(usage) {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const result = { inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached), outputTokens: usage.output_tokens ?? 0 };
  if (cached) result.cacheReadTokens = cached;
  if (Number.isSafeInteger(usage.total_tokens)) result.totalTokens = usage.total_tokens;
  return result;
}

/** Content blocks, usage and finish reason from a `/responses` reply. */
export function readResponse(body) {
  if (!body || !Array.isArray(body.output)) throw new Error('rdsh-llm-native: the reply has no output');
  const blocks = [];
  for (const item of body.output) {
    if (item.type === 'message') {
      const value = (item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('');
      if (value) blocks.push({ type: 'text', text: value });
    } else if (item.type === 'function_call') {
      blocks.push({ type: 'tool-call', id: item.call_id, name: item.name, arguments: item.arguments ?? '{}' });
    }
  }
  let reason = { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' };
  if (body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens') reason = { kind: 'max-tokens' };
  return { blocks, usage: usageOf(body.usage), reason };
}

/** Replay state for a response; `window` is present when one is in force. */
export function replayState(window) {
  const response = { kind: REPLAY_KIND, version: REPLAY_VERSION };
  if (window) {
    response.window = { items: window.items, covered: window.covered,
      ...(window.anchor === undefined ? {} : { anchor: window.anchor }) };
  }
  return { response };
}
