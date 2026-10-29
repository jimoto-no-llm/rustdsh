import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unaryConnect, streamConnect } from './protocol.mjs';

const SERVER = 'https://server.codeium.com';

/** Read only the API-key field; never surface credential text in diagnostics. */
export function parseDevinCredentials(toml) {
  let section = '';
  const result = {};
  for (const line of toml.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (heading) { section = heading[1]; continue; }
    const pair = line.match(/^\s*(windsurf_api_key|api_key|apiKey|api_server_url)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (!pair || (section && section !== 'metadata' && section !== 'auth')) continue;
    try {
      const apiKey = pair[2][0] === '"' ? JSON.parse(pair[2]) : pair[2].slice(1, -1);
      if (typeof apiKey === 'string' && apiKey && !/[\r\n]/.test(apiKey)) {
        if (pair[1] === 'api_server_url') result.baseURL = apiKey.replace(/\/$/, '');
        else if (!result.apiKey || pair[1] === 'windsurf_api_key') result.apiKey = apiKey;
      }
    } catch { /* Malformed TOML credentials receive a generic error. */ }
  }
  if (result.apiKey) return validateCredentials(result);
  throw new Error('Devin credentials contain no usable API key');
}

async function defaultLoadCredentials() {
  let value;
  try { value = await readFile(join(homedir(), '.local/share/devin/credentials.toml'), 'utf8'); }
  catch { throw new Error('Devin credentials could not be read; sign in to Devin first'); }
  return parseDevinCredentials(value);
}

function validateCredentials(value) {
  if (!value || typeof value.apiKey !== 'string' || !value.apiKey || /[\r\n]/.test(value.apiKey)) throw new Error('Devin API key is missing or invalid');
  if ((value.baseURL && value.baseURL !== SERVER) || (value.apiServer && value.apiServer !== SERVER)) throw new Error('Unsupported Devin API server');
  return value;
}

export function toDevinPrompts(messages = [], system) {
  const prompts = [];
  if (system) prompts.push({ messageId: randomUUID(), source: 5, prompt: system });
  for (const message of messages) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
    const source = { user: 1, assistant: 2, tool: 4, system: 5, developer: 5 }[message.role];
    if (!source) throw new Error('Unsupported Devin message role');
    const prompt = { messageId: message.id ?? randomUUID(), source, prompt: '' };
    const texts = [];
    const calls = [];
    for (const block of blocks) {
      if (block.type === 'text') texts.push(block.text);
      else if (block.type === 'tool-call') calls.push({ id: block.id, name: block.name, argumentsJson: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments) });
      else if (block.type === 'tool-result') {
        prompt.toolCallId = block.toolCallId;
        texts.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? block.result));
      } else if (block.type !== 'reasoning') throw new Error('Unsupported Devin content block');
    }
    prompt.prompt = texts.join('\n');
    if (calls.length) prompt.toolCalls = calls;
    if (message.role === 'tool') {
      prompt.toolCallId ??= message.toolCallId ?? message.source?.callId;
      if (!prompt.toolCallId) throw new Error('Devin tool result lacks a call ID');
    }
    prompts.push(prompt);
  }
  return prompts;
}

function wireTools(tools) {
  return tools.map(tool => {
    if (typeof tool.name !== 'string' || !tool.name) throw new Error('Invalid Devin tool definition');
    const schema = tool.parameters ?? tool.inputSchema ?? tool.jsonSchema ?? { type: 'object', properties: {} };
    return { name: tool.name, description: tool.description ?? '', jsonSchemaString: typeof schema === 'string' ? schema : JSON.stringify(schema) };
  });
}

export function createDevinBackend({ fetchImpl = fetch, credentials = defaultLoadCredentials } = {}) {
  const endpoint = method => `${SERVER}/exa.api_server_pb.ApiServerService/${method}`;
  async function auth(signal) {
    signal?.throwIfAborted();
    const credential = validateCredentials(await credentials());
    return { metadata: { apiKey: credential.apiKey, ideName: 'rdsh', extensionName: 'rdsh-direct-models', disableTelemetry: true }, transport: { fetchImpl, signal, secrets: [credential.apiKey] } };
  }
  return {
    async discover({ signal } = {}) {
      const { metadata, transport } = await auth(signal);
      const response = await unaryConnect(endpoint('GetCliModelConfigs'), { metadata }, transport);
      if (!Array.isArray(response.clientModelConfigs)) throw new Error('Invalid Devin model discovery response');
      return response.clientModelConfigs.filter(config => !config.disabled && typeof config.modelUid === 'string' && config.modelUid).map(config => ({ id: config.modelUid, name: config.label || config.modelUid }));
    },
    async generate({ model, messages = [], system, tools = [], sessionId, maxTokens, signal }) {
      if (typeof model !== 'string' || !model) throw new Error('Devin model ID is required');
      const { metadata, transport } = await auth(signal);
      const definitions = wireTools(tools);
      const allowed = new Set(definitions.map(tool => tool.name));
      const body = { metadata: { ...metadata, sessionId: sessionId ?? randomUUID() }, chatMessagePrompts: toDevinPrompts(messages, system), chatModelUid: model, requestType: 1, tools: definitions };
      if (maxTokens != null) {
        if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error('Invalid Devin token limit');
        body.configuration = { maxTokens };
      }
      let text = '';
      let usage;
      const calls = new Map();
      for await (const delta of streamConnect(endpoint('GetChatMessage'), body, transport)) {
        if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new Error('Invalid Devin generation response');
        if (delta.deltaText != null) {
          if (typeof delta.deltaText !== 'string') throw new Error('Invalid Devin text delta');
          text += delta.deltaText;
        }
        if (delta.stopReason === 13 || delta.stopReason === 'STOP_REASON_ERROR') throw new Error('Devin generation failed');
        if (delta.deltaToolCalls != null) {
          if (!Array.isArray(delta.deltaToolCalls)) throw new Error('Invalid Devin tool-call response');
          for (const call of delta.deltaToolCalls) {
            if (typeof call.id !== 'string' || !call.id) throw new Error('Devin tool-call delta lacks an ID');
            const current = calls.get(call.id) ?? { id: call.id, name: '', arguments: '' };
            if (call.name != null && call.name !== '') {
              if (typeof call.name !== 'string' || !allowed.has(call.name) || (current.name && current.name !== call.name)) throw new Error('Devin returned an unknown or inconsistent tool name');
              current.name = call.name;
            }
            if (call.argumentsJson != null) {
              if (typeof call.argumentsJson !== 'string') throw new Error('Invalid Devin tool arguments delta');
              current.arguments += call.argumentsJson;
            }
            calls.set(call.id, current);
          }
        }
        if (delta.usage != null) {
          const mapped = {};
          for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
            const value = Number(delta.usage[key] ?? 0);
            if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Devin token usage');
            mapped[key] = value;
          }
          usage = mapped;
        }
      }
      for (const call of calls.values()) {
        if (!allowed.has(call.name)) throw new Error('Devin returned an incomplete tool call');
        try { const args = JSON.parse(call.arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(); }
        catch { throw new Error('Devin returned invalid tool arguments'); }
      }
      if (!text && !calls.size) throw new Error('Devin returned no text or tool calls');
      return { text, toolCalls: [...calls.values()], ...(usage ? { usage } : {}) };
    },
  };
}
