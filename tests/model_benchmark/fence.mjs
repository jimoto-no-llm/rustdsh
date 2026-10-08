import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// The official fs sandbox fences mutations, but allows reads outside cwd.
// This test-only monotonic guard fences all model file capabilities as well.
export function makeGuard(config) {
  const readable = new Set(config.readable.map(path => realpathSync(path)));
  const writable = new Set(config.writable.map(path => realpathSync(path)));
  return exec => {
    if (!['read', 'edit', 'write'].includes(exec.name)) return 'benchmark fence: tool denied';
    const path = exec.arguments?.file_path;
    if (typeof path !== 'string') return 'benchmark fence: path required';
    try {
      const canonical = realpathSync(resolve(config.cwd, path));
      const allowed = exec.name === 'read' ? readable : writable;
      if (allowed.has(canonical)) return undefined;
    } catch { /* Absent files cannot be created by this benchmark. */ }
    return 'benchmark fence: path denied';
  };
}

export const inject = ['tools'];
export function apply(ctx, config) {
  if (!Number.isSafeInteger(config.maxRequests) || config.maxRequests < 1) throw new Error('benchmark request limit required');
  ctx.tools.guard(makeGuard(config));
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: config.readable.length ? ['read', 'edit', 'write'] : [] });
  });
  let requests = 0;
  ctx.on('agent/request', async (_payload, next) => {
    if (++requests > config.maxRequests) throw new Error('benchmark request limit exceeded');
    return next();
  });
}
