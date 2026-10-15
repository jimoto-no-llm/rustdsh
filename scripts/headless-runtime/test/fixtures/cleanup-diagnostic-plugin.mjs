import { writeFileSync } from 'node:fs';

const evidence = process.env.RDSH_CLEANUP_DIAGNOSTIC;
if (!evidence) throw new Error('cleanup diagnostic fixture requires RDSH_CLEANUP_DIAGNOSTIC');

export const inject = ['agents', 'sessions', 'profileContext'];

export function apply(ctx) {
  const owned = new Set();
  const record = { adopted: 0, disposedSessions: [], disposerOwned: -1, naturalExitObserved: false, profile: ctx.get('profileContext')?.name };
  const save = () => writeFileSync(evidence, JSON.stringify(record), { mode: 0o600 });
  ctx.on('agent/created', ({ agent } = {}) => {
    const id = agent?.session?.id;
    if (typeof id === 'string' && id && agent.id === id) {
      owned.add(id);
      record.adopted++;
      record.agentSessionEqual = true;
    }
  });
  ctx.on('session/disposed', session => {
    if (owned.delete(session?.id)) record.disposedSessions.push(session.id);
  });
  process.once('beforeExit', () => {
    record.naturalExitObserved = true;
    save();
  });
  ctx.effect(() => () => {
    record.disposerOwned = owned.size;
    save();
  }, 'observe exact-session disposal without performing cleanup');
}
