import { isAbsolute, join } from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

export const UPDATE_REPOSITORY = Object.freeze({ owner: 'jimoto-no-llm', repo: 'rustdsh', channel: 'rdsh-desktop' });
export const FEED_URL = 'https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/';
const absolute = value => typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && !value.includes('\0');

/** The official SDK owns transport, agent turns and subprocess disposal. */
export function createHarness({ sdkHome, dshBin, cwd, provider, model, env = {}, ...options }) {
  if (![sdkHome, dshBin, cwd].every(absolute)) throw new Error('SDK home, DSH JavaScript entry and workspace must be absolute paths');
  if (!/\.(?:js|mjs|cjs)$/.test(dshBin)) throw new Error('The official SDK requires a DSH JavaScript entry, not the Rust binary');
  if (![provider, model].every(value => typeof value === 'string' && value.trim() && value.length <= 256))
    throw new Error('Choose an explicit provider and model');
  const allowed = new Set(['reasoningEffort', 'maxTokens', 'initializeTimeoutMs', 'requestTimeoutMs', 'shutdownTimeoutMs', 'disposeEofGraceMs', 'disposeGraceMs']);
  if (Object.keys(options).some(key => !allowed.has(key))) throw new Error('Unsupported SDK option');
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)) throw new Error('Invalid output token limit');
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string')) throw new Error('Invalid child environment');
  // Explicit environment only: do not inherit the desktop process's credentials
  // or user Node hooks. Electron's Node mode is confined to this owned child.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH', 'DSH_HOME'].includes(key)));
  return new DeepSeekHarness({ ...options, dshBin, dshHome: sdkHome, processCwd: cwd, cwd, provider, model,
    profile: 'sdk', env: { ...childEnv, DSH_HOME: sdkHome, ELECTRON_RUN_AS_NODE: '1' } });
}

export function desktopPaths({ appData, resources, platform = process.platform }) {
  if (![appData, resources].every(absolute) || !['linux', 'darwin', 'win32'].includes(platform)) throw new Error('Invalid desktop paths');
  return Object.freeze({ home: join(appData, 'rdsh-desktop', 'harness'),
    rdshBin: join(resources, 'rdsh', platform === 'win32' ? 'rdsh.exe' : 'rdsh') });
}

/** Keep download and install as distinct, user-authorized native actions. */
export function configureUpdater(updater) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.setFeedURL({ provider: 'generic', url: FEED_URL });
  updater.channel = UPDATE_REPOSITORY.channel;
  updater.allowPrerelease = false;
  // electron-updater may enable downgrade when the channel is set.
  updater.allowDowngrade = false;
}
