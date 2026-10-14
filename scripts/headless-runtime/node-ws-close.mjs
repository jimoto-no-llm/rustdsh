function closed(socket) {
  return new Promise(resolve => {
    const readyState = socket?.readyState;
    if (typeof readyState === 'number' && (readyState === 3 || readyState === socket?.CLOSED)) return resolve();
    const onError = () => {};
    const listener = () => {
      socket.removeEventListener?.('close', listener);
      socket.removeEventListener?.('error', onError);
      resolve();
    };
    socket.addEventListener('error', onError);
    socket.addEventListener('close', listener);
  });
}
async function within(promise, ms) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); });
  const result = await Promise.race([promise.then(() => true), timeout]);
  clearTimeout(timer);
  return result;
}
export async function closeOwnedWebSocket(socket, { graceMs = 250, reason = 'headless_dispose' } = {}) {
  if (!socket || typeof socket.close !== 'function') throw new TypeError('owned WebSocket must implement close()');
  const closeEvent = closed(socket);
  try { socket.close(1000, reason); } catch {}
  if (await within(closeEvent, graceMs)) return { closed: true, forced: false };
  if (typeof socket.terminate !== 'function') throw new Error('headless WebSocket does not support terminate()');
  try { socket.terminate(); } catch {}
  if (!(await within(closeEvent, graceMs))) throw new Error('headless WebSocket did not close after terminate()');
  return { closed: true, forced: true };
}
export function createExactSessionCloseRegistry(close = closeOwnedWebSocket) {
  const bySession = new Map();
  const remove = (sessionId, entry) => {
    const entries = bySession.get(sessionId);
    entries?.delete(entry);
    if (entries?.size === 0) bySession.delete(sessionId);
  };
  const begin = (entry, options) => {
    if (entry.task) return entry.task;
    try { entry.task = Promise.resolve(close(entry.socket, options)); }
    catch (error) { entry.task = Promise.reject(error); }
    entry.task.catch(() => {});
    entry.task.finally(() => remove(entry.sessionId, entry)).catch(() => {});
    return entry.task;
  };
  return {
    track(sessionId, socket) {
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('owned session id is required');
      const entry = { sessionId, socket, task: undefined };
      let entries = bySession.get(sessionId);
      if (!entries) bySession.set(sessionId, entries = new Set());
      entries.add(entry);
      return entry;
    },
    close(entry, options) { return begin(entry, options); },
    async closeSession(sessionId, options) {
      if (typeof sessionId !== 'string' || !sessionId.trim()) return;
      await Promise.all([...(bySession.get(sessionId) ?? [])].map(entry => begin(entry, options)));
    },
    async closeAll(options) {
      await Promise.all([...bySession.values()].flatMap(entries => [...entries]).map(entry => begin(entry, options)));
    },
  };
}
export function trackNodeWebSocket(registry, webSocketFactory, resourceSessionId, socket) {
  return webSocketFactory === 'node-ws' && typeof resourceSessionId === 'string' && resourceSessionId.trim()
    ? registry.track(resourceSessionId, socket)
    : undefined;
}
export function closeTrackedOrSilent(registry, tracked, socket, reason = 'done') {
  if (tracked) {
    void registry.close(tracked, { reason });
    return;
  }
  try { socket.close(1000, reason); } catch {}
}
export async function closeExactSessionSockets({ sessionId, cachedEntries = [], registry, options }) {
  const cached = cachedEntries.map(entry => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.trackedClose) return registry.close(entry.trackedClose, options);
    try { entry.socket.close(1000, options?.reason ?? 'done'); } catch {}
    return undefined;
  });
  const tracked = sessionId ? registry.closeSession(sessionId, options) : registry.closeAll(options);
  await Promise.all([...cached, tracked]);
}
