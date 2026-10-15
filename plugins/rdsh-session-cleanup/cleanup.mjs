import { cleanupDiagnostic } from './diagnostics.mjs';

export function attachSessionCleanup(ctx, cleanup) {
  if (ctx.get('profileContext')?.name !== 'headless') return;
  const owned = new Set();
  const pending = new Set();
  const failures = [];
  const clean = id => {
    if (typeof id !== 'string' || !owned.delete(id)) return;
    let task;
    try {
      task = Promise.resolve(cleanup(id));
    } catch (error) {
      task = Promise.reject(error);
    }
    const observed = task.catch(error => { failures.push(error); });
    pending.add(observed);
    observed.finally(() => pending.delete(observed));
  };
  const stopCreated = ctx.on('agent/created', ({ agent } = {}) => {
    const id = agent?.session?.id;
    if (typeof id === 'string' && id.trim() && agent.id === id) owned.add(id);
  });
  const stopDisposed = ctx.on('session/disposed', session => clean(session?.id));
  ctx.effect(() => async () => {
    stopCreated();
    stopDisposed();
    for (const id of [...owned]) clean(id);
    while (pending.size) await Promise.all([...pending]);
    if (failures.length) {
      const error = new AggregateError(failures, cleanupDiagnostic('failed'));
      error.code = 'RDSH_SESSION_CLEANUP_FAILED';
      throw error;
    }
  }, 'await owned headless WebSocket cleanup');
}
