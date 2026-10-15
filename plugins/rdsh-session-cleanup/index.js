import { attachSessionCleanup } from './cleanup.mjs';
import { cleanupDiagnostic } from './diagnostics.mjs';

export const name = 'rdsh-session-cleanup';
export const inject = ['agents', 'sessions', 'profileContext'];
export async function apply(ctx) {
  if (ctx.get('profileContext')?.name !== 'headless') return;
  let sdk;
  try { sdk = await import('@earendil-works/pi-ai'); }
  catch (cause) {
    const error = new Error(cleanupDiagnostic('runtime'), { cause });
    error.code = 'RDSH_SESSION_CLEANUP_RUNTIME';
    throw error;
  }
  if (typeof sdk.cleanupSessionResourcesAsync !== 'function') {
    const error = new Error(cleanupDiagnostic('runtime'));
    error.code = 'RDSH_SESSION_CLEANUP_RUNTIME';
    throw error;
  }
  attachSessionCleanup(ctx, sdk.cleanupSessionResourcesAsync);
  ctx.provide('rdshSessionCleanupReady', true);
}
