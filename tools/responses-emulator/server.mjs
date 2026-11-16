#!/usr/bin/env node
// responses-emulator: a local stand-in that answers in the shape of the OpenAI
// and xAI Responses API (`/responses`, `/responses/compact`) and of the
// Anthropic Messages API (`/messages`, with both compaction forms), on top of
// any OpenAI-compatible Chat Completions endpoint.
//
// It exists to exercise rdsh-llm-native end to end without the real provider.
// It checks the one property the adapter must hold: a compaction item comes
// back exactly as it was issued. It does not prove anything about OpenAI's own
// service. Compaction items here are opaque handles, not encryption.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MAX_BODY = 8 * 1024 * 1024;
const SUMMARY_PROMPT = 'Summarize the conversation above for continuation. Keep goals, constraints, decisions, exact names, numbers and paths. Return only the summary.';

function bad(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

const partsText = content => typeof content === 'string' ? content
  : (content ?? []).map(part => part.text ?? '').join('');

/** Chat messages for a Responses `input`. Compaction items are expanded from `store`. */
export function toChat(input, instructions, store) {
  if (!Array.isArray(input)) throw bad(400, 'invalid_request', 'input must be an array');
  const messages = instructions ? [{ role: 'system', content: instructions }] : [];
  const seen = [];
  for (const item of input) {
    if (item?.type === 'compaction') {
      const summary = store.get(item.encrypted_content);
      // A handle this server did not issue, or one that was altered on the way.
      if (summary === undefined) throw bad(400, 'invalid_encrypted_content', 'unknown compaction item');
      seen.push(item.encrypted_content);
      messages.push({ role: 'system', content: `Summary of the earlier conversation:\n${summary}` });
    } else if (item?.type === 'function_call') {
      const last = messages.at(-1);
      const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '{}' } };
      if (last?.role === 'assistant' && last.tool_calls) last.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item?.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: String(item.output ?? '') });
    } else if (item?.type === 'message' || item?.role) {
      const role = item.role === 'developer' ? 'system' : item.role;
      if (!['system', 'user', 'assistant'].includes(role)) throw bad(400, 'invalid_request', 'unknown message role');
      messages.push({ role, content: partsText(item.content) });
    } else {
      throw bad(400, 'invalid_request', 'unknown input item');
    }
  }
  return { messages, seen };
}

const ON_DEMAND_BETA = 'compact-2026-09-04';
const THRESHOLD_BETA = 'compact-2026-01-12';
const THRESHOLD_EDIT = 'compact_20260112';

/**
 * Chat messages for an Anthropic `messages` array. A compaction block must be
 * the only one, sit in the first message, and match what this server issued.
 */
export function toChatFromMessages(input, system, store) {
  if (!Array.isArray(input) || input.length === 0) throw bad(400, 'invalid_request_error', 'messages must be a non-empty array');
  const messages = system ? [{ role: 'system', content: typeof system === 'string' ? system : partsText(system) }] : [];
  let blocks = 0;
  input.forEach((message, index) => {
    if (!['user', 'assistant'].includes(message?.role)) throw bad(400, 'invalid_request_error', 'unknown message role');
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
    let text = '';
    const calls = [];
    const flush = () => {
      if (text || calls.length) messages.push({ role: message.role, content: text || null, ...(calls.length ? { tool_calls: [...calls] } : {}) });
      text = '';
      calls.length = 0;
    };
    for (const part of parts) {
      if (part.type === 'compaction') {
        blocks += 1;
        if (index !== 0 || message.role !== 'assistant' || blocks > 1) throw bad(400, 'compaction_block_misplaced', 'the compaction block must come first, once');
        if (typeof part.signature !== 'string' || store.get(part.signature) !== part.content) {
          throw bad(400, 'invalid_compaction_block', 'unknown or altered compaction block');
        }
        messages.push({ role: 'system', content: `Summary of the earlier conversation:\n${part.content}` });
      } else if (part.type === 'text') text += part.text ?? '';
      else if (part.type === 'tool_use') calls.push({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } });
      else if (part.type === 'tool_result') {
        flush();
        messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: typeof part.content === 'string' ? part.content : partsText(part.content) });
      } else throw bad(400, 'invalid_request_error', 'unknown content block');
    }
    flush();
  });
  return { messages, blocks };
}

/** A chat function backed by an OpenAI-compatible Chat Completions endpoint. */
export function upstreamChat({ baseUrl, apiKeyEnv, model, fetchImpl = fetch }) {
  return async ({ messages, tools, maxTokens }) => {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env[apiKeyEnv] ?? ''}` },
      body: JSON.stringify({ model, messages, ...(tools?.length ? { tools } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}) }) });
    if (!response.ok) throw bad(502, 'upstream_error', `upstream answered HTTP ${response.status}`);
    const body = await response.json();
    const message = body.choices?.[0]?.message ?? {};
    return { content: message.content ?? '', toolCalls: message.tool_calls ?? [],
      finish: body.choices?.[0]?.finish_reason, usage: body.usage ?? {} };
  };
}

/**
 * @param chat `({messages, tools, maxTokens}) => {content, toolCalls, finish, usage}`
 * @returns `{ server, log, store }`; `log` lists each request without bodies.
 */
export function createEmulator({ chat, onRequest = () => {}, minTrigger = 50000 }) {
  const store = new Map();
  const log = { push(entry) { Array.prototype.push.call(this.entries, entry); onRequest(entry); }, entries: [],
    map(fn) { return this.entries.map(fn); }, at(index) { return this.entries.at(index); } };
  const usage = u => ({ input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0,
    total_tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) });

  async function respond(body) {
    const { messages, seen } = toChat(body.input, body.instructions, store);
    const tools = (body.tools ?? []).map(tool => ({ type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    const reply = await chat({ messages, tools, maxTokens: body.max_output_tokens });
    log.push({ path: '/responses', items: body.input.length, compactionItems: seen.length, messages: messages.length });
    const output = [];
    if (reply.content) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply.content }] });
    for (const call of reply.toolCalls) {
      output.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    const cut = reply.finish === 'length';
    return { id: `resp_${randomBytes(8).toString('hex')}`, object: 'response', status: cut ? 'incomplete' : 'completed',
      ...(cut ? { incomplete_details: { reason: 'max_output_tokens' } } : {}), model: body.model, output, usage: usage(reply.usage) };
  }

  async function compact(body) {
    const { messages, seen } = toChat(body.input, body.instructions, store);
    const reply = await chat({ messages: [...messages, { role: 'user', content: SUMMARY_PROMPT }], tools: [], maxTokens: 4096 });
    if (!reply.content?.trim()) throw bad(502, 'upstream_error', 'the summary came back empty');
    const handle = randomBytes(48).toString('base64');
    store.set(handle, reply.content.trim());
    log.push({ path: '/responses/compact', items: body.input.length, compactionItems: seen.length, messages: messages.length });
    return { id: `resp_${randomBytes(8).toString('hex')}`, object: 'response.compaction',
      output: [{ type: 'compaction', id: `cmp_${randomBytes(8).toString('hex')}`, encrypted_content: handle }],
      usage: usage(reply.usage) };
  }

  const blockFor = summary => {
    const signature = randomBytes(48).toString('base64');
    store.set(signature, summary);
    return { type: 'compaction', content: summary, signature };
  };
  const summarize = async messages => {
    const reply = await chat({ messages: [...messages, { role: 'user', content: SUMMARY_PROMPT }], tools: [], maxTokens: 4096 });
    if (!reply.content?.trim()) throw bad(502, 'upstream_error', 'the summary came back empty');
    return { summary: reply.content.trim(), usage: reply.usage };
  };
  const messagesUsage = u => ({ input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 });

  async function messagesApi(body, beta) {
    const betas = String(beta ?? '').split(',').map(value => value.trim());
    const { messages, blocks } = toChatFromMessages(body.messages, body.system, store);
    if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0) throw bad(400, 'invalid_request_error', 'max_tokens is required');
    const id = `msg_${randomBytes(8).toString('hex')}`;
    const base = { id, type: 'message', role: 'assistant', model: body.model };
    if (body.compaction) {
      // On demand: only a summary comes back, as a signed block.
      if (body.compaction.type !== 'summarize') throw bad(400, 'invalid_request_error', 'unknown compaction type');
      if (!betas.includes(ON_DEMAND_BETA)) throw bad(400, 'invalid_request_error', 'the on-demand beta header is required');
      for (const field of ['context_management', 'stop_sequences', 'tool_choice']) {
        if (body[field] !== undefined) throw bad(400, 'invalid_request_error', `${field} cannot be sent with compaction`);
      }
      const { summary, usage: used } = await summarize(messages);
      log.push({ path: '/messages', form: 'on_demand', items: body.messages.length, compactionItems: blocks, messages: messages.length });
      return { ...base, content: [blockFor(summary)], stop_reason: 'compaction',
        usage: { ...messagesUsage(used), iterations: [{ type: 'compaction', ...messagesUsage(used) }] } };
    }
    const edit = (body.context_management?.edits ?? []).find(entry => entry?.type === THRESHOLD_EDIT);
    if (edit && !betas.includes(THRESHOLD_BETA)) throw bad(400, 'invalid_request_error', 'the threshold beta header is required');
    if (blocks && !edit && !betas.includes(ON_DEMAND_BETA)) throw bad(400, 'invalid_request_error', 'a signed block needs the on-demand beta header');
    const tools = (body.tools ?? []).map(tool => ({ type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
    let prefix = [];
    let chatMessages = messages;
    if (edit) {
      const value = edit.trigger?.value;
      if (edit.trigger?.type !== 'input_tokens' || !Number.isSafeInteger(value) || value < minTrigger) {
        throw bad(400, 'invalid_request_error', `the trigger must be at least ${minTrigger} input tokens`);
      }
      if (Math.ceil(JSON.stringify(messages).length / 4) >= value) {
        // The server compacts everything it was sent, then answers from the summary.
        const { summary } = await summarize(messages);
        prefix = [blockFor(summary)];
        const system = messages.filter(m => m.role === 'system' && !m.content.startsWith('Summary of the earlier conversation:'));
        const asked = messages.filter(m => m.role === 'user').at(-1);
        chatMessages = [...system, { role: 'system', content: `Summary of the earlier conversation:\n${summary}` },
          ...(asked ? [asked] : [])];
        if (edit.pause_after_compaction) {
          log.push({ path: '/messages', form: 'threshold_paused', items: body.messages.length, compactionItems: blocks, messages: messages.length });
          return { ...base, content: prefix, stop_reason: 'compaction', usage: { input_tokens: 0, output_tokens: 0 } };
        }
      }
    }
    const reply = await chat({ messages: chatMessages, tools, maxTokens: body.max_tokens });
    log.push({ path: '/messages', form: prefix.length ? 'threshold_compacted' : 'plain', items: body.messages.length,
      compactionItems: blocks, messages: chatMessages.length });
    const content = [...prefix];
    if (reply.content) content.push({ type: 'text', text: reply.content });
    for (const call of reply.toolCalls) {
      let input;
      try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = {}; }
      content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
    }
    const stop = reply.finish === 'length' ? 'max_tokens' : reply.toolCalls.length ? 'tool_use' : 'end_turn';
    return { ...base, content, stop_reason: stop, usage: messagesUsage(reply.usage) };
  }

  const server = http.createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk); });
    request.on('end', async () => {
      const send = (status, value) => {
        const text = JSON.stringify(value);
        response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        response.end(text);
      };
      try {
        if (size > MAX_BODY) throw bad(413, 'too_large', 'request body too large');
        const path = (request.url ?? '').replace(/^\/v1/, '').split('?')[0];
        if (request.method !== 'POST' || !['/responses', '/responses/compact', '/messages'].includes(path)) {
          throw bad(404, 'not_found', 'only POST /v1/responses, /v1/responses/compact and /v1/messages exist');
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw bad(400, 'invalid_request', 'the body is not JSON'); }
        if (typeof body.model !== 'string' || !body.model) throw bad(400, 'invalid_request', 'model is required');
        send(200, path === '/messages' ? await messagesApi(body, request.headers['anthropic-beta'])
          : path === '/responses' ? await respond(body) : await compact(body));
      } catch (error) {
        send(error.status ?? 500, { error: { code: error.code ?? 'server_error', message: error.status ? error.message : 'internal error' } });
      }
    });
  });
  return { server, log, store };
}

export function listen(server, port = 0) {
  return new Promise(done => server.listen(port, '127.0.0.1', () => done(server.address().port)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = name => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
  const baseUrl = flag('--upstream');
  const model = flag('--model');
  if (!baseUrl || !model) {
    console.error('usage: node server.mjs --upstream <chat-completions base URL> --model <name> [--api-key-env NAME] [--port N] [--min-trigger N]');
    process.exitCode = 2;
  } else {
    // One line per request: path and counts only, never bodies.
    const { server } = createEmulator({ chat: upstreamChat({ baseUrl, model, apiKeyEnv: flag('--api-key-env') ?? 'EMULATOR_UPSTREAM_KEY' }),
      onRequest: entry => console.log(JSON.stringify(entry)),
      ...(flag('--min-trigger') ? { minTrigger: Number(flag('--min-trigger')) } : {}) });
    listen(server, Number(flag('--port') ?? 0)).then(port => console.log(`responses-emulator listening on http://127.0.0.1:${port}/v1`));
  }
}
