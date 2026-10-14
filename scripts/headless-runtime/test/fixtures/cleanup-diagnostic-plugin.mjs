import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const candidate = process.env.RDSH_CANDIDATE;
const evidence = process.env.RDSH_CLEANUP_DIAGNOSTIC;
if (!candidate || !evidence) throw new Error('cleanup diagnostic fixture requires RDSH_CANDIDATE and RDSH_CLEANUP_DIAGNOSTIC');

const { cleanupSessionResourcesAsync } = await import(pathToFileURL(path.join(candidate, 'node_modules/@earendil-works/pi-ai/dist/index.js')).href);

export const inject = ['agents', 'sessions', 'profileContext'];

export function apply(ctx) {
  const owned = new Set();
  const pending = new Set();
  const record = { adopted: 0, cleanCalls: [], disposerOwned: -1, pendingSettled: -1, profile: ctx.get('profileContext')?.name };
  const clean = id => {
    if (typeof id !== 'string' || !owned.delete(id)) return;
    record.cleanCalls.push(id);
    const task = Promise.resolve(cleanupSessionResourcesAsync(id)).catch(() => {});
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  ctx.on('agent/created', ({ agent } = {}) => {
    const id = agent?.session?.id;
    if (typeof id === 'string' && id && agent.id === id) {
      owned.add(id);
      record.adopted++;
      record.agentSessionEqual = true;
    }
  });
  ctx.on('session/disposed', session => clean(session?.id));
  ctx.effect(() => async () => {
    record.disposerOwned = owned.size;
    for (const id of [...owned]) clean(id);
    await Promise.all([...pending]);
    record.pendingSettled = pending.size;
    await writeFile(evidence, JSON.stringify(record));
  }, 'safe exact-session cleanup diagnostic');
}
