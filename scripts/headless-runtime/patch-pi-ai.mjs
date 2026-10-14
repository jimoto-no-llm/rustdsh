import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

function count(source, fragment) { return source.split(fragment).length - 1; }
function replaceOnce(source, before, after, label) {
  if (count(source, before) !== 1) throw new Error(`unexpected ${label} source`);
  return source.replace(before, after);
}
function replaceFunction(source, signature, replacement, label) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`unexpected ${label} source: missing ${signature}`);
  const brace = source.indexOf('{', start + signature.length);
  if (brace < 0) throw new Error(`unexpected ${label} source: missing body`);
  let depth = 0;
  for (let index = brace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(0, start) + replacement + source.slice(index + 1);
  }
  throw new Error(`unexpected ${label} source: unclosed body`);
}
function patchSessionResources(source) {
  if (!source.includes('export function cleanupSessionResources(sessionId)')) throw new Error('unexpected session-resources source');
  const marker = '//# sourceMappingURL=';
  const at = source.indexOf(marker);
  if (at < 0) throw new Error('unexpected session-resources source: missing source map');
  const addition = `export async function cleanupSessionResourcesAsync(sessionId, options) {
    const errors = [];
    for (const cleanup of sessionResourceCleanups) {
        try { await cleanup(sessionId, { ...options, __rdshAsyncCleanupBarrier: true }); }
        catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to cleanup session resources");
}
`;
  return source.slice(0, at) + addition + source.slice(at);
}
function patchCodexResponses(source) {
  const cleanupImport = 'import { registerSessionResourceCleanup } from "../session-resources.js";';
  if (!source.includes(cleanupImport)) throw new Error('unexpected openai-codex-responses source: missing cleanup import');
  let patched = source.replace(cleanupImport, `${cleanupImport}\nimport HeadlessWebSocket from "ws";\nimport { closeExactSessionSockets, closeTrackedOrSilent, createExactSessionCloseRegistry, trackNodeWebSocket } from "./rdsh-headless-ws-close.js";`);
  patched = replaceOnce(patched, 'const websocketSseFallbackSessions = new Set();', 'const websocketSseFallbackSessions = new Set();\nconst headlessSessionCloseRegistry = createExactSessionCloseRegistry();\nconst trackedNodeWebSockets = new WeakMap();', 'openai-codex-responses close registry');
  patched = replaceFunction(patched, 'export function closeOpenAICodexWebSocketSessions(sessionId)', `export async function closeOpenAICodexWebSocketSessions(sessionId, options) {
    const entries = [];
    if (sessionId) {
        entries.push(...(websocketSessionCache.get(sessionId)?.values() ?? []));
        websocketSessionCache.delete(sessionId);
    }
    else {
        for (const accountEntries of websocketSessionCache.values()) entries.push(...accountEntries.values());
        websocketSessionCache.clear();
    }
    await closeExactSessionSockets({ sessionId, cachedEntries: entries, registry: headlessSessionCloseRegistry, options });
}`, 'openai-codex-responses');
  patched = replaceOnce(patched, 'registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);', `const headlessSessionCleanupTasks = new Map();
function cleanupOpenAICodexWebSocketSessions(sessionId, options) {
    const cleanupKey = sessionId || "__rdsh_all_sessions__";
    let task = headlessSessionCleanupTasks.get(cleanupKey);
    if (!task) {
        task = closeOpenAICodexWebSocketSessions(sessionId, options);
        headlessSessionCleanupTasks.set(cleanupKey, task);
        task.then(() => headlessSessionCleanupTasks.delete(cleanupKey), () => {});
    }
    task.catch(() => {});
    if (options?.__rdshAsyncCleanupBarrier) return task.finally(() => headlessSessionCleanupTasks.delete(cleanupKey));
    return task;
}
registerSessionResourceCleanup(cleanupOpenAICodexWebSocketSessions);`, 'openai-codex-responses cleanup registration');
  patched = replaceOnce(patched, 'async function getWebSocketConstructor(env) {', `async function getWebSocketConstructor(env, webSocketFactory) {
    if (webSocketFactory === "node-ws") return HeadlessWebSocket;`, 'openai-codex-responses WebSocket factory');
  patched = replaceOnce(patched, 'async function connectWebSocket(url, headers, signal, connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS, env) {', 'async function connectWebSocket(url, headers, signal, connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS, env, webSocketFactory, resourceSessionId) {', 'openai-codex-responses connect signature');
  patched = replaceOnce(patched, 'const WebSocketCtor = await getWebSocketConstructor(env);', 'const WebSocketCtor = await getWebSocketConstructor(env, webSocketFactory);', 'openai-codex-responses constructor call');
  patched = replaceOnce(patched, 'async function acquireWebSocket(url, headers, sessionId, accountId, signal, connectTimeoutMs, env) {', 'async function acquireWebSocket(url, headers, sessionId, accountId, signal, connectTimeoutMs, env, webSocketFactory, resourceSessionId) {', 'openai-codex-responses acquire signature');
  const connectCall = 'connectWebSocket(url, headers, signal, connectTimeoutMs, env)';
  const calls = count(patched, connectCall);
  if (calls !== 3) throw new Error(`unexpected openai-codex-responses source: expected three connect calls, got ${calls}`);
  patched = patched.split(connectCall).join('connectWebSocket(url, headers, signal, connectTimeoutMs, env, webSocketFactory, resourceSessionId)');
  patched = replaceOnce(patched, '        let socket;\n        try {', '        let socket;\n        let trackedClose;\n        try {', 'openai-codex-responses connection tracking declaration');
  patched = replaceOnce(patched, 'socket = new WebSocketCtor(url, { headers: wsHeaders });', 'socket = new WebSocketCtor(url, { headers: wsHeaders });\n            trackedClose = trackNodeWebSocket(headlessSessionCloseRegistry, webSocketFactory, resourceSessionId, socket);\n            if (trackedClose) trackedNodeWebSockets.set(socket, trackedClose);', 'openai-codex-responses connection creation tracking');
  patched = replaceOnce(patched, 'closeWebSocketSilently(socket, 1000, closeReason);', 'closeTrackedOrSilent(headlessSessionCloseRegistry, trackedClose, socket, closeReason);', 'openai-codex-responses connection failure close');
  const noncached = `        const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env, webSocketFactory, resourceSessionId);
        return {
            socket,
            reused: false,
            release: () => closeWebSocketSilently(socket),
        };`;
  const trackedNoncached = `        const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env, webSocketFactory, resourceSessionId);
        const trackedClose = trackedNodeWebSockets.get(socket);
        return {
            socket,
            reused: false,
            release: () => closeTrackedOrSilent(headlessSessionCloseRegistry, trackedClose, socket),
        };`;
  patched = replaceOnce(patched, noncached, trackedNoncached, 'openai-codex-responses noncached release');
  const busy = `            const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env, webSocketFactory, resourceSessionId);
            return {
                socket,
                reused: false,
                release: () => {
                    closeWebSocketSilently(socket);
                },
            };`;
  const trackedBusy = `            const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env, webSocketFactory, resourceSessionId);
            const trackedClose = trackedNodeWebSockets.get(socket);
            return {
                socket,
                reused: false,
                release: () => closeTrackedOrSilent(headlessSessionCloseRegistry, trackedClose, socket),
            };`;
  patched = replaceOnce(patched, busy, trackedBusy, 'openai-codex-responses busy supplementary release');
  patched = replaceOnce(patched, 'closeWebSocketSilently(entry.socket, 1000, "idle_timeout");', 'closeTrackedOrSilent(headlessSessionCloseRegistry, entry.trackedClose, entry.socket, "idle_timeout");', 'openai-codex-responses idle close');
  patched = replaceOnce(patched, 'closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");', 'closeTrackedOrSilent(headlessSessionCloseRegistry, cached.trackedClose, cached.socket, "connection_age_limit");', 'openai-codex-responses age close');
  patched = replaceOnce(patched, 'closeWebSocketSilently(cached.socket);\n            accountEntries?.delete(accountId);', 'closeTrackedOrSilent(headlessSessionCloseRegistry, cached.trackedClose, cached.socket);\n            accountEntries?.delete(accountId);', 'openai-codex-responses cached unusable close');
  patched = replaceOnce(patched, 'closeWebSocketSilently(cached.socket);\n                        const currentEntries', 'closeTrackedOrSilent(headlessSessionCloseRegistry, cached.trackedClose, cached.socket);\n                        const currentEntries', 'openai-codex-responses cached keep false close');
  patched = replaceOnce(patched, '    const entry = { socket, busy: true, createdAt: Date.now() };', '    const entry = { socket, busy: true, createdAt: Date.now(), trackedClose: trackedNodeWebSockets.get(socket) };', 'openai-codex-responses cached entry tracking');
  patched = replaceOnce(patched, 'closeWebSocketSilently(entry.socket);\n                if (entry.idleTimer)', 'closeTrackedOrSilent(headlessSessionCloseRegistry, entry.trackedClose, entry.socket);\n                if (entry.idleTimer)', 'openai-codex-responses new cached keep false close');
  patched = replaceOnce(patched, 'const { socket, entry, reused, release } = await acquireWebSocket(url, headers, cacheSessionId, accountId, options?.signal, websocketConnectTimeoutMs, options?.env);', 'const { socket, entry, reused, release } = await acquireWebSocket(url, headers, cacheSessionId, accountId, options?.signal, websocketConnectTimeoutMs, options?.env, options?.webSocketFactory, options?.sessionId);', 'openai-codex-responses stream acquire call');
  patched = replaceOnce(patched, '        toolChoice: options?.toolChoice,\n    };', '        toolChoice: options?.toolChoice,\n        webSocketFactory: options?.webSocketFactory,\n    };', 'openai-codex-responses streamSimple WebSocket factory');
  return `${patched}\nexport { acquireWebSocket as __rdshAcquireWebSocketForTest };\n`;
}
export function patchPiAiSources({ sessionResources, codexResponses }) { return { sessionResources: patchSessionResources(sessionResources), codexResponses: patchCodexResponses(codexResponses) }; }
function patchDshAdapterSource(source) {
  const transport = `\ttransport: z.union([\n\t\t"sse",\n\t\t"websocket",\n\t\t"websocket-cached",\n\t\t"auto"\n\t]),\n`;
  const factory = `\twebSocketFactory: z.union([\n\t\t"runtime",\n\t\t"node-ws"\n\t]),\n`;
  const patched = replaceOnce(source, transport, transport + factory, 'dsh-llm-pi-ai profile schema');
  return replaceOnce(patched, '\t\t...profile.transport === void 0 ? {} : { transport: profile.transport },\n', '\t\t...profile.transport === void 0 ? {} : { transport: profile.transport },\n\t\t...profile.webSocketFactory === void 0 ? {} : { webSocketFactory: profile.webSocketFactory },\n', 'dsh-llm-pi-ai profile options');
}
function sha256(source) { return createHash('sha256').update(source).digest('hex'); }
export async function patchPiAiDirectory(root, { helper, sourceHashes } = {}) {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== '@earendil-works/pi-ai' || metadata.version !== '0.87.1') throw new Error('headless runtime requires @earendil-works/pi-ai@0.87.1');
  const sessionPath = path.join(root, 'dist/session-resources.js');
  const codexPath = path.join(root, 'dist/api/openai-codex-responses.js');
  const sources = { sessionResources: await readFile(sessionPath, 'utf8'), codexResponses: await readFile(codexPath, 'utf8') };
  if (sourceHashes) for (const [name, expected] of Object.entries(sourceHashes)) if (sha256(sources[name]) !== expected) throw new Error(`pi-ai ${name} source hash mismatch`);
  const patched = patchPiAiSources(sources);
  await Promise.all([writeFile(sessionPath, patched.sessionResources), writeFile(codexPath, patched.codexResponses), copyFile(helper, path.join(root, 'dist/api/rdsh-headless-ws-close.js'))]);
  return { sessionPath, codexPath };
}
export async function patchDshAdapterDirectory(root, { sourceHash } = {}) {
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== '@deepseek-ai/dsh-llm-pi-ai' || metadata.version !== '0.2.0-rc.2') throw new Error('headless runtime requires @deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2');
  const adapterPath = path.join(root, 'lib/index.js');
  const source = await readFile(adapterPath, 'utf8');
  if (sourceHash && sha256(source) !== sourceHash) throw new Error('dsh-llm-pi-ai source hash mismatch');
  await writeFile(adapterPath, patchDshAdapterSource(source));
  return { adapterPath };
}
