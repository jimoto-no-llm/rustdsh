import { DeepSeekHarness, type DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client';
export const UPDATE_REPOSITORY: Readonly<{ owner: 'jimoto-no-llm'; repo: 'rustdsh'; channel: 'rdsh-desktop' }>;
export const FEED_URL: 'https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/';
export type RdshHarnessOptions = Pick<DeepSeekHarnessOptions, 'reasoningEffort' | 'maxTokens' | 'initializeTimeoutMs' | 'requestTimeoutMs' | 'shutdownTimeoutMs' | 'disposeEofGraceMs' | 'disposeGraceMs'> & {
  sdkHome: string; dshBin: string; cwd: string; provider: string; model: string; env?: Record<string, string>;
};
export function createHarness(options: RdshHarnessOptions): DeepSeekHarness;
export function desktopPaths(options: { appData: string; resources: string; platform?: 'linux' | 'darwin' | 'win32' }): Readonly<{ home: string; rdshBin: string }>;
export function configureUpdater(updater: { autoDownload: boolean; autoInstallOnAppQuit: boolean; channel: string | null; allowPrerelease: boolean; allowDowngrade: boolean; setFeedURL(options: { provider: 'generic'; url: string }): void }): void;
