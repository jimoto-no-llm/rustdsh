import { randomUUID } from 'node:crypto';
import {loadAgyCredentials} from './agy-auth.mjs';

const HOSTS = new Set(['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com', 'aicode.googleapis.com']);
const DEFAULT_BASE = 'https://aicode.googleapis.com';
const LIMIT = 16 * 1024 * 1024;
async function defaultCredentials(options) {
  return loadAgyCredentials(options);
}
function safeBase(value = DEFAULT_BASE) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Antigravity: unsupported service URL');
  return url.origin;
}
async function boundedText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) { await reader.cancel(); throw new Error('Antigravity: response exceeds limit'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
function projectFrom(value) {
  const project = value.cloudaicompanionProject ?? value.cloudAiCompanionProject ?? value.project;
  return typeof project === 'string' ? project : project?.id ?? project?.projectId;
}
function textFrom(content) {
  return typeof content === 'string' ? content : (content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
}
function contentsFrom(messages = []) {
  const names = new Map();
  return messages.filter(m => m.role !== 'system').map(m => {
    const blocks = Array.isArray(m.content) ? m.content : [];
    const calls = [...(m.tool_calls ?? m.toolCalls ?? []), ...blocks.filter(x => x.type === 'tool-call')];
    for (const call of calls) names.set(call.id, (call.function ?? call).name);
    // Provider replay parts preserve Google's opaque thought signatures verbatim.
    if (m.providerMetadata?.agy?.parts) {
      for (const part of m.providerMetadata.agy.parts) if (part.functionCall?.id) names.set(part.functionCall.id, part.functionCall.name);
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: m.providerMetadata.agy.parts };
    }
    if (m.role === 'tool') {
      const name = m.name ?? names.get(m.toolCallId ?? m.tool_call_id ?? m.source?.callId);
      if (!name) throw new Error('Antigravity: tool result has no matching function name');
      return { role: 'user', parts: [{ functionResponse: { name, response: { result: textFrom(m.content) } } }] };
    }
    const parts = [];
    const content = textFrom(m.content);
    if (content) parts.push({ text: content });
    for (const call of calls) {
      const fn = call.function ?? call;
      parts.push({ functionCall: { name: fn.name, args: typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments ?? {} } });
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: parts.length ? parts : [{ text: '' }] };
  });
}
export function createAgyBackend({ fetchImpl = fetch, credentials = defaultCredentials } = {}) {
  async function context(signal) {
    const creds = await credentials({signal});
    const token = creds.token?.access_token ?? creds.access_token;
    if (!token) throw new Error('Antigravity: missing OAuth access token');
    const legacy = creds.api === 'legacy';
    const base = safeBase(creds.baseURL ?? (legacy ? 'https://daily-cloudcode-pa.googleapis.com' : DEFAULT_BASE));
    async function post(method, data, verb = 'POST') {
      const response = await fetchImpl(`${base}/${legacy ? 'v1internal' : 'v1alpha'}:${method}`, {
        method: verb, redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'rdsh/0.3.3' },
        ...(verb === 'POST' ? { body: JSON.stringify(data) } : {}),
      });
      if (!response.ok) {
        let category='';
        try {
          const error=JSON.parse(await boundedText(response)).error;
          const detail=error?.details?.find(d=>d['@type']==='type.googleapis.com/google.rpc.ErrorInfo');
          if (typeof detail?.reason==='string' && /^[A-Z_]{1,64}$/.test(detail.reason)) category=` (${detail.reason})`;
          if (typeof error?.message==='string') {
            let message=error.message;
            for (const secret of [token,creds.token?.refresh_token,creds.refresh_token]) if(secret) message=message.split(secret).join('[REDACTED]');
            category+=': '+message.replace(/[A-Za-z0-9_-]{48,}/g,'[REDACTED]').replace(/[\r\n]/g,' ').slice(0,300);
          }
          const field=detail?.metadata?.field_name;
          if (typeof field==='string' && /^[a-zA-Z_.]{1,64}$/.test(field)) category+=` field=${field}`;
        } catch {}
        throw new Error(`Antigravity: ${method.split('?')[0]} HTTP ${response.status}${category}`);
      }
      return response;
    }
    let project = creds.project;
    if (legacy && !project) {
      const raw = await boundedText(await post('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }));
      let value; try { value = JSON.parse(raw); } catch { throw new Error('Antigravity: invalid project discovery JSON'); }
      project = projectFrom(value);
    }
    if (legacy && (!project || typeof project !== 'string')) throw new Error('Antigravity: account has no discovered project');
    async function catalog() {
      let value;
      try { value = JSON.parse(await boundedText(await post('fetchConfig', undefined, 'GET'))); }
      catch (error) { if (error instanceof SyntaxError) throw new Error('Antigravity: invalid models JSON'); throw error; }
      if (!Array.isArray(value.availableExperiences) || !value.availableExperiences.length) throw new Error('Antigravity: model discovery returned no valid catalog');
      for (const experience of value.availableExperiences) if (!experience || typeof experience.name !== 'string' || !experience.name || typeof experience.model?.modelId !== 'string') throw new Error('Antigravity: invalid model catalog entry');
      return value.availableExperiences;
    }
    return { project, post, legacy, experience: creds.experience, catalog };
  }
  return {
    async discover({ signal } = {}) {
      const { project, post, legacy, catalog } = await context(signal);
      if (!legacy) return (await catalog()).map(experience => ({ id: experience.name, name: experience.model.displayName ?? experience.name }));
      const raw = await boundedText(await post('fetchAvailableModels', { project }));
      let value; try { value = JSON.parse(raw); } catch { throw new Error('Antigravity: invalid models JSON'); }
      if (!value.models || typeof value.models !== 'object' || Array.isArray(value.models) || !Object.keys(value.models).length) throw new Error('Antigravity: model discovery returned no valid catalog');
      return Object.entries(value.models).map(([id, model]) => ({ id, name: model.displayName ?? id }));
    },
    async generate({ model, messages = [], system, tools = [], maxTokens, signal, sessionId } = {}) {
      const { project, post, legacy, experience, catalog } = await context(signal);
      const request = { contents: contentsFrom(messages) };
      const instruction = textFrom(system) || messages.filter(m => m.role === 'system').map(m => textFrom(m.content)).join('\n');
      if (instruction) request.systemInstruction = { parts: [{ text: instruction }] };
      if (maxTokens) request.generationConfig = { maxOutputTokens: maxTokens };
      if (tools.length) request.tools = [{ functionDeclarations: tools.map(t => { const f = t.function ?? t; return { name: f.name, description: f.description, [legacy ? 'parameters' : 'parametersJsonSchema']: f.parameters ?? f.input_schema ?? { type: 'object', properties: {} } }; }) }];
      let payload;
      if (legacy) payload = { project, model, request, requestType: 'agent', userAgent: 'rdsh', requestId: randomUUID() };
      else {
        const experiences = await catalog();
        const selected = experiences.find(e => e.name === (experience ?? model));
        if (!selected) throw new Error('Antigravity: requested experience is absent from live catalog');
        let licenses;
        try { licenses = JSON.parse(await boundedText(await post('fetchLicenses', undefined, 'GET'))); }
        catch (error) { if (error instanceof SyntaxError) throw new Error('Antigravity: invalid licenses JSON'); throw error; }
        const entitlement = licenses.licenses?.[0]?.userTier;
        if (!entitlement) throw new Error('Antigravity: account has no active license entitlement');
        payload = { aicode: { experience: selected.name }, entitlement: { userTier: entitlement }, ...request, ...(sessionId ? { sessionId } : {}) };
      }
      const raw = await boundedText(await post('streamGenerateContent?alt=sse', payload));
      const chunks = [];
      try {
        if (raw.trimStart().startsWith('data:') || raw.includes('\ndata:')) {
          for (const event of raw.split(/\r?\n\r?\n/)) {
            const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            if (data && data !== '[DONE]') chunks.push(JSON.parse(data));
          }
        } else { const value = JSON.parse(raw); chunks.push(...(Array.isArray(value) ? value : [value])); }
      } catch { throw new Error('Antigravity: invalid generation response'); }
      let text = '', usage;
      const toolCalls = [], parts = [];
      const allowedNames = new Set(tools.map(t => (t.function ?? t).name));
      for (const chunk of chunks) {
        const value = chunk.response ?? chunk;
        if (value.error) throw new Error(`Antigravity: generation service error (${Number(value.error.code) || 'unknown'})`);
        if (value.usageMetadata) {
          const u = value.usageMetadata;
          usage = { inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0, cacheReadTokens: u.cachedContentTokenCount ?? 0, cacheWriteTokens: 0 };
        }
        const responseParts = value.candidates?.[0]?.content?.parts ?? [];
        if (!Array.isArray(responseParts)) throw new Error('Antigravity: invalid response parts');
        for (const part of responseParts) {
          if (!part || typeof part !== 'object' || Array.isArray(part) || (part.text !== undefined && typeof part.text !== 'string') || (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string')) throw new Error('Antigravity: invalid response part');
          if (part.functionCall) {
            const call = part.functionCall;
            if (!allowedNames.has(call.name)) throw new Error('Antigravity: response requested an undeclared tool');
            if (call.args !== undefined && (!call.args || typeof call.args !== 'object' || Array.isArray(call.args))) throw new Error('Antigravity: invalid tool arguments');
          }
          parts.push(part);
          if (part.text && !part.thought) text += part.text;
          if (part.functionCall) toolCalls.push({ id: part.functionCall.id ?? randomUUID(), name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) });
        }
      }
      if (!parts.length) throw new Error('Antigravity: generation returned no content');
      return { text, toolCalls, usage, replayState: { parts } };
    },
  };
}
