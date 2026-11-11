// Anthropic Messages wire shapes for the adapter. Pure functions: no I/O.
//
// Two compaction forms exist. On demand: one request asks only for a summary
// and returns a signed compaction block; later requests put that block first.
// Threshold: every request carries the edit, the server compacts when the
// input reaches the trigger and answers in the same response. In both forms
// the block is sent back exactly as it was returned.

export const VERSION_HEADER = { 'anthropic-version': '2023-06-01' };
export const ON_DEMAND_BETA = 'compact-2026-09-04';
export const THRESHOLD_BETA = 'compact-2026-01-12';
const THRESHOLD_EDIT = 'compact_20260112';

const text = blocks => blocks.filter(block => block.type === 'text').map(block => block.text).join('');

function unsupported(block) {
  const error = new Error(`rdsh-llm-native: a ${block.type} block cannot be sent on this route`);
  error.code = 'UNSUPPORTED_CONTENT';
  return error;
}

/** Messages for one DSH message. Mid-history system text travels as user text. */
export function messageItems(message) {
  const blocks = message.content ?? [];
  for (const block of blocks) {
    if (['image', 'file', 'tool-addition', 'tool-removal'].includes(block.type)) throw unsupported(block);
  }
  switch (message.role) {
    case 'system':
    case 'developer':
    case 'user':
      return [{ role: 'user', content: [{ type: 'text', text: text(blocks) }] }];
    case 'tool':
      return [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.source.callId, content: text(blocks) }] }];
    case 'assistant': {
      const content = [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
        else if (block.type === 'tool-call') {
          let input;
          try { input = JSON.parse(block.arguments || '{}'); } catch { input = {}; }
          content.push({ type: 'tool_use', id: block.id, name: block.name, input });
        }
      }
      return content.length ? [{ role: 'assistant', content }] : [];
    }
    default:
      throw new Error(`rdsh-llm-native: unknown message role ${message.role}`);
  }
}

/** Join neighbours of the same role; the API takes alternating turns. */
export function merge(messages) {
  const merged = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last?.role === message.role) last.content = [...last.content, ...message.content];
    else merged.push({ role: message.role, content: [...message.content] });
  }
  return merged;
}

const toolsOf = tools => tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));

/** A normal request. `threshold` adds the server-side compaction edit. */
export function requestBody({ model, input, instructions, tools, maxTokens, threshold }) {
  const body = { model, max_tokens: maxTokens ?? 4096, messages: merge(input) };
  if (instructions) body.system = instructions;
  if (tools?.length) body.tools = toolsOf(tools);
  if (threshold) {
    const edit = { type: THRESHOLD_EDIT, trigger: { type: 'input_tokens', value: threshold.trigger } };
    if (threshold.pause) edit.pause_after_compaction = true;
    body.context_management = { edits: [edit] };
  }
  return body;
}

/** The request that only asks for a summary of `input`. */
export function compactBody({ model, input, instructions, maxTokens }) {
  const body = { model, max_tokens: maxTokens ?? 4096, messages: merge(input), compaction: { type: 'summarize' } };
  if (instructions) body.system = instructions;
  return body;
}

function blockOf(content) {
  const blocks = (content ?? []).filter(block => block?.type === 'compaction');
  if (blocks.length === 0) return undefined;
  if (blocks.length !== 1 || typeof blocks[0].content !== 'string' || !blocks[0].content) {
    throw new Error('rdsh-llm-native: the reply must hold exactly one usable compaction block');
  }
  return blocks[0];
}

/** The window from an on-demand reply: one assistant message holding the block. */
export function readCompact(body) {
  if (body?.stop_reason !== 'compaction') {
    throw new Error(`rdsh-llm-native: the summary request stopped with ${body?.stop_reason ?? 'no reason'}`);
  }
  const block = blockOf(body.content);
  if (!block) throw new Error('rdsh-llm-native: the summary reply has no compaction block');
  return [{ role: 'assistant', content: [block] }];
}

function usageOf(usage) {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  const result = { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 };
  if (usage.cache_read_input_tokens) result.cacheReadTokens = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens) result.cacheWriteTokens = usage.cache_creation_input_tokens;
  return result;
}

/**
 * Blocks, usage and finish reason from a normal reply. `window` is set when
 * the server compacted in this response (threshold form); `paused` when it
 * stopped right after doing so.
 */
export function readResponse(body) {
  if (!body || !Array.isArray(body.content)) throw new Error('rdsh-llm-native: the reply has no content');
  const block = blockOf(body.content);
  const blocks = [];
  for (const part of body.content) {
    if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
    else if (part.type === 'tool_use') {
      blocks.push({ type: 'tool-call', id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}) });
    }
  }
  const reasons = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool-calls', max_tokens: 'max-tokens', compaction: 'stop' };
  const kind = reasons[body.stop_reason];
  if (!kind) throw new Error(`rdsh-llm-native: the reply stopped with ${body.stop_reason ?? 'no reason'}`);
  return { blocks, usage: usageOf(body.usage), reason: { kind },
    window: block ? [{ role: 'assistant', content: [block] }] : undefined,
    paused: body.stop_reason === 'compaction' };
}
