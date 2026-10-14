import { cleanupSessionResourcesAsync } from '@earendil-works/pi-ai';
import { attachSessionCleanup } from './cleanup.mjs';

export const name = 'rdsh-session-cleanup';
export const inject = ['agents', 'sessions', 'profileContext'];
export function apply(ctx) {
  attachSessionCleanup(ctx, cleanupSessionResourcesAsync);
}
