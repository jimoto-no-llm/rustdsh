// Prepare an owned, pinned fork checkout. No reset/clean, force checkout or
// credential reads. A later pin gets a fresh directory, preserving old builds.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planOverlay, contentHash, PATCH_PATHS } from './overlay.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
export function prepare({ checkout, rdshBin, lockPath = join(repo, 'desktop/upstream.lock.json') }) {
  const root = resolve(checkout), binary = resolve(rdshBin);
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (lock.schemaVersion !== 1 || lock.repository !== 'https://github.com/deepseek-ai/deepseek-harness.git'
    || !/^[a-f0-9]{40}$/.test(lock.revision)) throw new Error('Invalid upstream lock');
  const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(repo, 'Cargo.toml'), 'utf8'))?.[1];
  if (!version) throw new Error('Rust package version missing');
  const stat = lstatSync(binary);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 268435456 || !['rdsh', 'rdsh.exe'].includes(basename(binary))) throw new Error('Provide a compiled Rust launcher');
  const bytes = readFileSync(binary);
  if (!['7f454c46', 'cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(bytes.subarray(0, 4).toString('hex'))
    && bytes.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error('Rust launcher must be a native executable');
  const nativeHash = contentHash(bytes);
  const marker = join(root, '.rdsh-fork.json');
  if (!existsSync(root)) {
    mkdirSync(dirname(root), { recursive: true });
    execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', lock.repository, root], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'fetch', '--depth', '1', 'origin', lock.revision], { stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'checkout', '--detach', lock.revision], { stdio: 'pipe' });
  }
  if (lstatSync(root).isSymbolicLink() || git(root, ['rev-parse', '--show-toplevel']) !== root
    || git(root, ['config', '--get', 'remote.origin.url']) !== lock.repository
    || git(root, ['rev-parse', 'HEAD']) !== lock.revision) throw new Error('Checkout does not match the pinned official source');
  const generatorHash = contentHash(readFileSync(new URL('./overlay.mjs', import.meta.url)));
  const noLinks = path => {
    let current = root;
    for (const part of path.split('/')) { current = join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Unexpected prepared-source symlink'); }
  };
  if (existsSync(marker)) {
    if (lstatSync(marker).isSymbolicLink() || lstatSync(marker).size > 65536) throw new Error('Invalid prepared-source marker');
    const state = JSON.parse(readFileSync(marker, 'utf8'));
    if (state.revision !== lock.revision || state.rdshVersion !== version || state.nativeHash !== nativeHash || state.generatorHash !== generatorHash)
      throw new Error('Use a fresh checkout for a changed SDK, Rust binary or upstream pin');
    const expectedPaths = [...PATCH_PATHS, 'apps/desktop/rdsh-bootstrap.cjs', 'apps/desktop/rdsh-build.json', `apps/desktop/rdsh-build-assets/${basename(binary)}`].sort();
    if (JSON.stringify(Object.keys(state.outputs).sort()) !== JSON.stringify(expectedPaths)) throw new Error('Invalid prepared-source inventory');
    for (const [path, hash] of Object.entries(state.outputs)) {
      noLinks(path);
      if (contentHash(readFileSync(join(root, path))) !== hash) throw new Error('Prepared source has local changes; preserve them and use a fresh checkout');
    }
    const changed = git(root, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).map(line => line.slice(3).replace(/^"|"$/g, ''));
    if (changed.some(path => path !== '.rdsh-fork.json' && !Object.hasOwn(state.outputs, path))) throw new Error('Prepared source has unrelated local changes');
    return { checkout: root, revision: lock.revision, rdshVersion: version, harnessVersion: lock.harnessVersion, unchanged: true };
  }
  if (git(root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Use a clean official checkout; local files will not be overwritten');
  for (const path of ['package.json', 'apps/desktop/package.json', 'packages/sdk/client/package.json']) {
    const expected = path.includes('/sdk/') ? lock.sdkVersion : lock.harnessVersion;
    if (JSON.parse(readFileSync(join(root, path), 'utf8')).version !== expected) throw new Error('Upstream package versions do not match the lock');
  }
  const outputs = planOverlay(root, lock, version, basename(binary));
  const nativePath = `apps/desktop/rdsh-build-assets/${basename(binary)}`;
  const manifestPath = 'apps/desktop/rdsh-build.json';
  outputs[manifestPath] = JSON.stringify({ schemaVersion: 1, rdshVersion: version, harnessVersion: lock.harnessVersion,
    revision: lock.revision, nativeSha256: nativeHash }, null, 2) + '\n';
  for (const path of [...Object.keys(outputs), nativePath]) {
    noLinks(path);
    if (!PATCH_PATHS.includes(path) && existsSync(join(root, path))) throw new Error('Generated destination already exists; it will not be overwritten');
  }
  // All source anchors and file identities were checked before the first write.
  for (const [path, contents] of Object.entries(outputs)) {
    if (existsSync(join(root, path)) && lstatSync(join(root, path)).isSymbolicLink()) throw new Error('Unexpected source symlink');
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  mkdirSync(dirname(join(root, nativePath)), { recursive: true }); copyFileSync(binary, join(root, nativePath));
  const hashes = Object.fromEntries(Object.entries(outputs).map(([path, contents]) => [path, contentHash(contents)]));
  hashes[nativePath] = nativeHash;
  writeFileSync(marker, JSON.stringify({ revision: lock.revision, rdshVersion: version, nativeHash, generatorHash, outputs: hashes }, null, 2) + '\n');
  return { checkout: root, revision: lock.revision, rdshVersion: version, harnessVersion: lock.harnessVersion, unchanged: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    const checkout = option('--checkout'), rdshBin = option('--rdsh-bin');
    if (!checkout || !rdshBin || args.length !== 4) throw new Error('Usage: node desktop/prepare.mjs --checkout <fresh directory> --rdsh-bin <compiled rdsh>');
    console.log(JSON.stringify(prepare({ checkout, rdshBin })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
