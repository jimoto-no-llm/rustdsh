// Checking never modifies a prepared fork or its local patches. Updating the
// lock is an explicit operation and still requires the normal CI/review path.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PATCH_PATHS, planOverlay, contentHash } from './overlay.mjs';

const repository = 'https://github.com/deepseek-ai/deepseek-harness.git';
const lockPath = new URL('./upstream.lock.json', import.meta.url);
const current = JSON.parse(readFileSync(lockPath, 'utf8'));
const latest = execFileSync('git', ['ls-remote', repository, 'refs/heads/master'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split(/\s/)[0];
if (!/^[a-f0-9]{40}$/.test(latest)) throw new Error('Upstream did not provide a valid revision');
console.log(JSON.stringify({ current: current.revision, latest, updateAvailable: latest !== current.revision }));
if (process.argv.includes('--update-lock') && latest !== current.revision) {
  const directory = mkdtempSync(join(tmpdir(), 'rdsh-upstream-check-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', '--no-checkout', repository, directory], { stdio: 'pipe' });
    execFileSync('git', ['-C', directory, 'fetch', '--depth', '1', 'origin', latest], { stdio: 'pipe' });
    execFileSync('git', ['-C', directory, 'checkout', '--detach', latest], { stdio: 'pipe' });
    const manifest = path => JSON.parse(readFileSync(join(directory, path), 'utf8'));
    const next = { schemaVersion: 1, repository, revision: latest,
      harnessVersion: manifest('package.json').version, sdkVersion: manifest('packages/sdk/client/package.json').version,
      patchInputs: Object.fromEntries(PATCH_PATHS.map(path => [path, contentHash(readFileSync(join(directory, path), 'utf8').replace(/\r\n/g, '\n'))])) };
    if (manifest('apps/desktop/package.json').version !== next.harnessVersion) throw new Error('Upstream Desktop and Harness versions differ');
    const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8'))?.[1];
    planOverlay(directory, next, version, 'rdsh');
    // No source directory is reset. Only repository-owned pins are updated.
    const sdkPath = new URL('./sdk/package.json', import.meta.url);
    const sdk = JSON.parse(readFileSync(sdkPath, 'utf8'));
    sdk.dependencies['@deepseek-ai/dsh-sdk-client'] = next.sdkVersion;
    writeFileSync(lockPath, JSON.stringify(next, null, 2) + '\n');
    writeFileSync(sdkPath, JSON.stringify(sdk, null, 2) + '\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
