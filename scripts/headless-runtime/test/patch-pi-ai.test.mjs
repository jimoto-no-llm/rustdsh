import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const runtime = await import('../patch-pi-ai.mjs').catch(() => null);

const sessionResources = `const sessionResourceCleanups = new Set();
export function registerSessionResourceCleanup(cleanup) { sessionResourceCleanups.add(cleanup); }
export function cleanupSessionResources(sessionId) { for (const cleanup of sessionResourceCleanups) cleanup(sessionId); }
//# sourceMappingURL=session-resources.js.map
`;
const codexResponses = `import { registerSessionResourceCleanup } from "../session-resources.js";
const websocketSessionCache = new Map();
const websocketSseFallbackSessions = new Set();
export function closeOpenAICodexWebSocketSessions(sessionId) {
    const closeEntry = (entry) => { if (entry.idleTimer) clearTimeout(entry.idleTimer); entry.socket.close(1000, "debug_close"); };
    if (sessionId) { for (const entry of websocketSessionCache.get(sessionId)?.values() ?? []) closeEntry(entry); websocketSessionCache.delete(sessionId); return; }
    for (const accountEntries of websocketSessionCache.values()) for (const entry of accountEntries.values()) closeEntry(entry);
    websocketSessionCache.clear();
}
registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);
async function getWebSocketConstructor(env) { return globalThis.WebSocket; }
async function connectWebSocket(url, headers, signal, connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS, env) {
    const WebSocketCtor = await getWebSocketConstructor(env);
    const wsHeaders = {};
    return new Promise((resolve, reject) => {
        let socket;
        try {
            socket = new WebSocketCtor(url, { headers: wsHeaders });
        }
        catch (error) { reject(error); return; }
        const fail = (error, closeReason) => {
            if (closeReason) closeWebSocketSilently(socket, 1000, closeReason);
            reject(error);
        };
        resolve(socket);
    });
}
async function acquireWebSocket(url, headers, sessionId, accountId, signal, connectTimeoutMs, env) {
        if (!sessionId) {
        const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
        return {
            socket,
            reused: false,
            release: () => closeWebSocketSilently(socket),
        };
    }
  if (accountId === "a") {
            const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
            return {
                socket,
                reused: false,
                release: () => {
                    closeWebSocketSilently(socket);
                },
            };
        }
  const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
    const entry = { socket, busy: true, createdAt: Date.now() };
  return socket;
}
function scheduleSessionWebSocketExpiry(entry) { closeWebSocketSilently(entry.socket, 1000, "idle_timeout"); }
function cacheBranches(cached, entry) {
  closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
  closeWebSocketSilently(cached.socket);
            accountEntries?.delete(accountId);
  closeWebSocketSilently(cached.socket);
                        const currentEntries = 1;
  closeWebSocketSilently(entry.socket);
                if (entry.idleTimer) clearTimeout(entry.idleTimer);
}
async function processWebSocketStream(url, body, headers, output, stream, model, onStart, idleTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, accountId, grammarToolInputProperties, options) {
  const { socket, entry, reused, release } = await acquireWebSocket(url, headers, cacheSessionId, accountId, options?.signal, websocketConnectTimeoutMs, options?.env);
  return socket;
}
export const streamSimple = (model, context, options) => {
    const base = {
        ...buildBaseOptions(model, context, options),
        toolChoice: options?.toolChoice,
    };
  return stream(model, context, base);
};
`;
const adapter = `const profile = z.object({
\ttransport: z.union([
\t\t"sse",
\t\t"websocket",
\t\t"websocket-cached",
\t\t"auto"
\t]),
\ttimeoutMs: z.natural(),
});
function profileOptions(profile) {
\treturn {
\t\t...profile.transport === void 0 ? {} : { transport: profile.transport },
\t};
}
`;

async function writePiFixture(root) {
  const pi = path.join(root, 'pi-ai');
  await mkdir(path.join(pi, 'dist/api'), { recursive: true });
  await writeFile(path.join(pi, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.87.1', type: 'module' }));
  await writeFile(path.join(pi, 'dist/session-resources.js'), sessionResources);
  await writeFile(path.join(pi, 'dist/api/openai-codex-responses.js'), codexResponses);
  return pi;
}

test('fork selects node ws only when the provider opts in and preserves the runtime constructor path', () => {
  assert.ok(runtime?.patchPiAiSources, 'must provide patchPiAiSources');
  const patched = runtime.patchPiAiSources({ sessionResources, codexResponses });
  assert.match(patched.sessionResources, /export async function cleanupSessionResourcesAsync/);
  assert.match(patched.codexResponses, /if \(webSocketFactory === "node-ws"\)/);
  assert.match(patched.codexResponses, /return HeadlessWebSocket/);
  assert.match(patched.codexResponses, /return globalThis\.WebSocket/);
  assert.match(patched.codexResponses, /getWebSocketConstructor\(env, webSocketFactory\)/);
  assert.equal((patched.codexResponses.match(/connectWebSocket\(url, headers, signal, connectTimeoutMs, env, webSocketFactory, resourceSessionId\)/g) || []).length, 3);
  assert.match(patched.codexResponses, /options\?\.env, options\?\.webSocketFactory, options\?\.sessionId/);
  assert.match(patched.codexResponses, /webSocketFactory: options\?\.webSocketFactory/);
  assert.match(patched.codexResponses, /closeExactSessionSockets/);
  assert.match(patched.codexResponses, /registerSessionResourceCleanup\(cleanupOpenAICodexWebSocketSessions\)/);
});

test('fork patch refuses an unexpected pi-ai source shape', () => {
  assert.ok(runtime?.patchPiAiSources, 'must provide patchPiAiSources');
  assert.throws(() => runtime.patchPiAiSources({ sessionResources: 'export {}', codexResponses }), /session-resources/);
  assert.throws(() => runtime.patchPiAiSources({ sessionResources, codexResponses: 'export {}' }), /openai-codex-responses/);
});

test('offline fork writes the awaitable public SDK module and the owned-close helper', async () => {
  assert.ok(runtime?.patchPiAiDirectory, 'must provide patchPiAiDirectory');
  const root = await mkdtemp(path.join(os.tmpdir(), 'rdsh-pi-ai-fixture-'));
  const pi = await writePiFixture(root);
  const helper = path.resolve('scripts/headless-runtime/node-ws-close.mjs');
  await runtime.patchPiAiDirectory(pi, { helper });
  const sdk = await import(`${pathToFileURL(path.join(pi, 'dist/session-resources.js')).href}?fixture=${Date.now()}`);
  let cleaned = 0;
  sdk.registerSessionResourceCleanup(async id => { if (id === 'owned') cleaned++; });
  await sdk.cleanupSessionResourcesAsync('owned');
  assert.equal(cleaned, 1);
  assert.match(await readFile(path.join(pi, 'dist/api/openai-codex-responses.js'), 'utf8'), /closeExactSessionSockets/);
  assert.match(await readFile(path.join(pi, 'dist/api/rdsh-headless-ws-close.js'), 'utf8'), /terminate/);
});

test('offline fork rejects a source hash mismatch before it writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rdsh-pi-ai-hash-'));
  const pi = await writePiFixture(root);
  const helper = path.resolve('scripts/headless-runtime/node-ws-close.mjs');
  const sourceHashes = { sessionResources: createHash('sha256').update(sessionResources).digest('hex'), codexResponses: '0'.repeat(64) };
  await assert.rejects(runtime.patchPiAiDirectory(pi, { helper, sourceHashes }), /source hash/);
  assert.equal(await readFile(path.join(pi, 'dist/session-resources.js'), 'utf8'), sessionResources);
});

test('adapter fork accepts node-ws only as an explicit provider field', async () => {
  assert.ok(runtime?.patchDshAdapterDirectory, 'must provide patchDshAdapterDirectory');
  const root = await mkdtemp(path.join(os.tmpdir(), 'rdsh-dsh-adapter-fixture-'));
  const adapterDir = path.join(root, 'dsh-llm-pi-ai');
  await mkdir(path.join(adapterDir, 'lib'), { recursive: true });
  await writeFile(path.join(adapterDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', version: '0.2.0-rc.2' }));
  await writeFile(path.join(adapterDir, 'lib/index.js'), adapter);
  await runtime.patchDshAdapterDirectory(adapterDir);
  const patched = await readFile(path.join(adapterDir, 'lib/index.js'), 'utf8');
  assert.match(patched, /webSocketFactory: z\.union/);
  assert.match(patched, /"runtime"/);
  assert.match(patched, /"node-ws"/);
  assert.match(patched, /webSocketFactory: profile\.webSocketFactory/);
});
