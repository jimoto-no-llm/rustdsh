import { ExposureError } from './policy.js';
import { diagnostic } from './diagnostics.js';

export const DSH_VERSION = '0.2.1-alpha.3';
export const DSH_VERSIONS = Object.freeze(['0.2.0-rc.2', DSH_VERSION]);
export const DSH_PACKAGES = Object.freeze(['dsh-tools', 'dsh-mcp-client', 'dsh-session', 'dsh-system-prompt']);

/** Require one coherent original Harness release from the verified release matrix. */
export function assertDshVersions(versions) {
  const release = versions[DSH_PACKAGES[0]];
  for (const name of DSH_PACKAGES) {
    if (!DSH_VERSIONS.includes(release) || versions[name] !== release) throw new ExposureError('RDSH_MCP_VERSION', diagnostic('version'));
  }
}
