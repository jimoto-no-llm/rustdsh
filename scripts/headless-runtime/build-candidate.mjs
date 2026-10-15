#!/usr/bin/env node
import { chmod, copyFile, cp, lstat, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { patchDshAdapterDirectory, patchPiAiDirectory } from './patch-pi-ai.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pinned = {
  '@deepseek-ai/dsh': '0.2.0-rc.2',
  '@deepseek-ai/dsh-llm-pi-ai': '0.2.0-rc.2',
  '@earendil-works/pi-ai': '0.87.1',
  ws: '8.22.0',
};
const sourceHashes = {
  dshLlmPiAi: 'd46dbc30aeb3414190000e6f8aeaaf994246b5e5c651de07639f4a7e92de37ef',
  sessionResources: '9228618eeaebc6b5a1746d28d1859b1e23f0f65e978dc9f6e20eb29d65b17e2a',
  codexResponses: '6e69310d77278231cfc87d7f03ee815d4a0f2ff273e6c43fcee6835e7df2b0c7',
};
const pluginFiles = ['cleanup.mjs', 'cordis.patch.yml', 'diagnostics.mjs', 'index.js', 'package.json'];
const nativeSetupHooks = [
  {
    packageName: 'node-pty', version: '1.2.0-beta.15', script: 'scripts/prebuild.js',
    packageScript: 'node scripts/prebuild.js || node-gyp rebuild',
    sha256: '7e604b10f7769d7dc95947d3481c00513b9e3bb6c561d5264506350a16a0381a',
  },
  {
    packageName: '@deepseek-ai/dsh-subprocess-local', version: '0.2.0-rc.2', script: 'scripts/ensure-spawn-helper.mjs',
    packageScript: 'node scripts/ensure-spawn-helper.mjs',
    sha256: 'ca5509febf1e6ec1356df121835ebe5ed2f9cace4bdc2ba6d83d41c7e45e0f1b',
  },
];

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--out') throw new Error('usage: node build-candidate.mjs --out /absolute/private/candidate');
  const out = path.resolve(argv[1]);
  if (!path.isAbsolute(argv[1])) throw new Error('--out must be absolute');
  return out;
}
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
async function makeReadOnly(root) {
  const entry = await lstat(root);
  if (entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    for (const name of await readdir(root)) await makeReadOnly(path.join(root, name));
    await chmod(root, 0o500);
    return;
  }
  await chmod(root, (entry.mode & 0o111) ? 0o500 : 0o400);
}
async function makeWritable(root) {
  let entry;
  try { entry = await lstat(root); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    for (const name of await readdir(root)) await makeWritable(path.join(root, name));
    await chmod(root, 0o700);
    return;
  }
  await chmod(root, 0o600);
}
async function exists(target) {
  try { await stat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function assertPluginSnapshot() {
  const canonical = path.resolve(here, '../../plugins/rdsh-session-cleanup');
  const snapshot = path.join(here, 'runtime/plugins/rdsh-session-cleanup');
  for (const name of pluginFiles) {
    const [source, copied] = await Promise.all([readFile(path.join(canonical, name)), readFile(path.join(snapshot, name))]);
    if (!source.equals(copied)) throw new Error(`runtime plugin snapshot differs from plugins/rdsh-session-cleanup/${name}`);
  }
}
async function runPinnedNativeHooks(root, runCommand) {
  for (const hook of nativeSetupHooks) {
    const packageRoot = path.join(root, 'node_modules', hook.packageName);
    const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (metadata.name !== hook.packageName || metadata.version !== hook.version || (metadata.scripts?.install ?? metadata.scripts?.postinstall) !== hook.packageScript) {
      throw new Error(`unexpected native setup package: ${hook.packageName}`);
    }
    const script = path.join(packageRoot, hook.script);
    const actualHash = createHash('sha256').update(await readFile(script)).digest('hex');
    if (actualHash !== hook.sha256) throw new Error(`native setup hook hash mismatch: ${hook.packageName}`);
    if (hook.packageName === 'node-pty' && process.env.npm_config_build_from_source === 'true') {
      throw new Error('node-pty source builds are unsupported by the offline candidate builder; unset npm_config_build_from_source and provide the pinned prebuild');
    }
    await runCommand(process.execPath, [hook.script], packageRoot);
  }
}
async function discardFailedStage(stage, cause) {
  try {
    await makeWritable(stage);
    await rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (cleanupError) {
    throw new AggregateError([cause, cleanupError], `failed to clean candidate staging directory: ${stage}`);
  }
  throw cause;
}
export async function buildCandidate(out, { runCommand = run } = {}) {
  if (await exists(out)) throw new Error(`candidate already exists: ${out}`);
  const parent = path.dirname(out);
  if (!(await exists(parent))) throw new Error(`candidate parent does not exist: ${parent}`);
  const stage = await mkdtemp(path.join(parent, '.rdsh-headless-runtime-'));
  await chmod(stage, 0o700);
  const input = path.join(here, 'runtime');
  try {
    await assertPluginSnapshot();
    await Promise.all([
      copyFile(path.join(input, 'package.json'), path.join(stage, 'package.json')),
      copyFile(path.join(input, 'package-lock.json'), path.join(stage, 'package-lock.json')),
      cp(path.join(input, 'plugins'), path.join(stage, 'plugins'), { recursive: true, dereference: true }),
    ]);
    const inputLockSha256 = createHash('sha256').update(await readFile(path.join(input, 'package-lock.json'))).digest('hex');
    await runCommand('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
    await runPinnedNativeHooks(stage, runCommand);
    await patchDshAdapterDirectory(path.join(stage, 'node_modules/@deepseek-ai/dsh-llm-pi-ai'), { sourceHash: sourceHashes.dshLlmPiAi });
    await patchPiAiDirectory(path.join(stage, 'node_modules/@earendil-works/pi-ai'), {
      helper: path.join(here, 'node-ws-close.mjs'),
      sourceHashes: { sessionResources: sourceHashes.sessionResources, codexResponses: sourceHashes.codexResponses },
    });
    await writeFile(path.join(stage, 'runtime-manifest.json'), JSON.stringify({
      format: 1,
      purpose: 'headless-only real WebSocket disposal candidate',
      packages: pinned,
      sourceHashes,
      nativeSetupHooks: nativeSetupHooks.map(({ packageName, version, script, sha256 }) => ({ packageName, version, script, sha256 })),
      inputLockSha256,
      providerOptIn: { field: 'webSocketFactory', value: 'node-ws' },
      plugin: 'node_modules/rdsh-session-cleanup',
      entrypoint: 'node_modules/.bin/dsh',
    }, null, 2) + '\n', { mode: 0o600 });
    await makeReadOnly(stage);
    await rename(stage, out);
  } catch (error) {
    await discardFailedStage(stage, error);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = parseArgs(process.argv.slice(2));
  await buildCandidate(out);
  console.log(JSON.stringify({ candidate: out, packages: pinned, immutable: true }));
}
