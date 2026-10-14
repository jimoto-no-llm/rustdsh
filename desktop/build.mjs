// The official packager builds and verifies the complete runtime. This wrapper
// selects a native, unsigned directory build and never publishes artifacts.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { prepare } from './prepare.mjs';
import { redactOutput } from './evidence.mjs';

export function nativeTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'win:x64';
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `mac:${arch}`;
  throw new Error('Native Desktop packaging requires Windows x64 or macOS arm64/x64');
}

export function packagedPaths(checkout, platform = process.platform, arch = process.arch) {
  const target = nativeTarget(platform, arch).replace(':', '-');
  const artifacts = join(resolve(checkout), 'apps/desktop/.desktop-build/targets', target, 'unsigned-artifacts');
  const application = platform === 'win32' ? join(artifacts, 'win-unpacked')
    : join(artifacts, arch === 'arm64' ? 'mac-arm64' : 'mac', 'rdsh Desktop.app');
  const resources = join(application, platform === 'win32' ? 'resources' : 'Contents/Resources');
  const executable = join(application, platform === 'win32' ? 'rdsh Desktop.exe' : 'Contents/MacOS/rdsh Desktop');
  return { target, application, resources, executable };
}

export function build({ checkout }) {
  const root = resolve(checkout), target = nativeTarget();
  const binary = join(root, 'apps/desktop/rdsh-build-assets', process.platform === 'win32' ? 'rdsh.exe' : 'rdsh');
  // Fail before the official build touches an edited or incompatible checkout.
  const state = prepare({ checkout: root, rdshBin: binary });
  const manager = join(root, 'node_modules/pnpm/bin/pnpm.cjs');
  const pnpm = JSON.parse(readFileSync(join(root, 'node_modules/pnpm/package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.packageManager !== `pnpm@${pnpm.version}`) throw new Error('Use the upstream-pinned pnpm version');
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$|^ELECTRON_RUN_AS_NODE$/i.test(name)));
  const environment = { ...cleanEnvironment, CI: 'true', DSH_TELEMETRY_DISABLED: '1',
    DSH_DESKTOP_NPM_REGISTRY: 'https://registry.npmjs.org',
    npm_execpath: manager };
  const script = `package:desktop:${target}:unsigned`;
  for (const extra of [['--check'], []]) {
    const result = spawnSync(process.execPath,
      [manager, 'run', script, '--', '--dir', '--build-version', state.rdshVersion, ...extra],
      { cwd: root, env: environment, encoding: 'utf8', maxBuffer: 67108864, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.stdout) process.stdout.write(redactOutput(result.stdout));
    if (result.stderr) process.stderr.write(redactOutput(result.stderr));
    if (result.error || result.signal || result.status !== 0)
      throw new Error(`Official Desktop packaging failed (${result.error?.code || result.signal || result.status})`);
  }
  console.log(`PASS native unsigned Desktop directory: ${target}, rdsh ${state.rdshVersion}, Harness ${manifest.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { checkout: { type: 'string' } } });
    if (!values.checkout) throw new Error('Usage: node desktop/build.mjs --checkout <prepared official source>');
    build({ checkout: values.checkout });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
