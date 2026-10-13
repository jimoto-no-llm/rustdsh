import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export const FEED_URL = 'https://github.com/jimoto-no-llm/rustdsh/releases/latest/download/';
export const APP_ID = 'io.github.jimoto-no-llm.rdsh';
export const PATCH_PATHS = Object.freeze(['apps/desktop/scripts/electron-builder-config.mjs',
  'apps/desktop/src/update-coordinator.ts', 'apps/desktop/src/main.ts', 'apps/desktop/scripts/macos-app-update-config.mjs',
  'apps/desktop/scripts/desktop-build-version.mjs', 'apps/desktop/cli/dsh', 'apps/desktop/cli/dsh.cmd']);
const sha = value => createHash('sha256').update(value).digest('hex');
const replace = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error('Upstream patch anchor changed; review the new source before preparing it');
  return source.replace(before, after);
};

// Do not change upstream's package versions or release/runtime verification.
// Electron's installed version is rdsh's; the bundled Harness remains pinned.
export function planOverlay(root, lock, rdshVersion, nativeName) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(rdshVersion)
    || !['rdsh', 'rdsh.exe'].includes(nativeName)) throw new Error('Invalid fork identity');
  const outputs = {};
  if (JSON.stringify(Object.keys(lock.patchInputs).sort()) !== JSON.stringify([...PATCH_PATHS].sort())) throw new Error('Unexpected patch paths');
  for (const [path, expected] of Object.entries(lock.patchInputs)) {
    let current = root;
    for (const part of path.split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error('Unexpected source symlink'); }
    const original = readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
    if (sha(original) !== expected) throw new Error('Upstream patch input does not match the reviewed lock');
    outputs[path] = original;
  }
  const builder = 'apps/desktop/scripts/electron-builder-config.mjs';
  let b = outputs[builder];
  b = replace(b, 'const appId = resolveDesktopAppId(env)', `const appId = '${APP_ID}'`);
  b = replace(b, 'const policy = packagesMacOS && unsigned ? undefined : resolveDesktopPolicyEnvironment(env)', 'const policy = undefined // rdsh uses user-authorized release updates; no official mandatory-policy service');
  b = replace(b, 'const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)', `const update = unsigned ? undefined : { publicUrl: '${FEED_URL}' }`);
  b = replace(b, 'const buildVersion = resolveDesktopBuildVersion(env, productVersion)', `const buildVersion = '${rdshVersion}'`);
  b = replace(b, "protocols: [{ name: 'DeepSeek Harness', schemes: ['dsh'] }]", "protocols: [{ name: 'rdsh Desktop', schemes: ['rdsh'] }]");
  b = replace(b, 'dshDesktopAppId: appId,', `dshDesktopAppId: appId,\n      rdshHarnessVersion: '${lock.harnessVersion}',\n      rdshUpstreamRevision: '${lock.revision}',\n      main: 'rdsh-bootstrap.cjs',`);
  b = replace(b, "productName: 'DeepSeek Harness'", "productName: 'rdsh Desktop'");
  b = replace(b, 'artifactName: `deepseek-harness-', 'artifactName: `rdsh-desktop-');
  b = replace(b, "'lib/main.js',", "'lib/main.js',\n      'rdsh-bootstrap.cjs',\n      'rdsh-build.json',");
  b = replace(b, 'extraResources: [', "extraResources: [\n      { from: fileURLToPath(new URL('../rdsh-build-assets', import.meta.url)), to: 'rdsh' },");
  b = replace(b, "channel: 'nightly'", "channel: 'rdsh-desktop'");
  outputs[builder] = b;
  const updater = 'apps/desktop/src/update-coordinator.ts';
  let u = outputs[updater];
  u = replace(u, "this.updater.channel = 'nightly'", "this.updater.channel = 'rdsh-desktop'");
  u = replace(u, 'this.updater.allowPrerelease = true', 'this.updater.allowPrerelease = false');
  u = replace(u, 'if (updater === autoUpdater) {', `if (updater === autoUpdater) {\n      updater.setFeedURL({ provider: 'generic', url: '${FEED_URL}' });`);
  outputs[updater] = u;
  const main = 'apps/desktop/src/main.ts';
  let m = outputs[main];
  m = replace(m, "app.setAsDefaultProtocolClient('dsh')", "app.setAsDefaultProtocolClient('rdsh')");
  m = replace(m, "url === 'dsh://open' || url === 'dsh://open/'", "url === 'rdsh://open' || url === 'rdsh://open/'");
  m = replace(m, "applicationName: 'DeepSeek Harness'", "applicationName: 'rdsh Desktop'");
  outputs[main] = m;
  const mac = 'apps/desktop/scripts/macos-app-update-config.mjs';
  outputs[mac] = replace(outputs[mac], "const CHANNEL = 'nightly'", "const CHANNEL = 'rdsh-desktop'");
  const versions = 'apps/desktop/scripts/desktop-build-version.mjs';
  let v = outputs[versions];
  for (const name of ['validateDesktopBuildVersion(buildVersion, productVersion)', 'resolveDesktopBuildVersion(env, productVersion)', 'desktopBuildVersionPrefix(productVersion)']) {
    v = replace(v, `export function ${name} {`, `export function ${name} {\n  productVersion = '${rdshVersion}' // Desktop artifact identity is independent of the pinned Harness cohort`);
  }
  outputs[versions] = v;
  const cli = 'apps/desktop/cli/dsh';
  outputs[cli] = replace(outputs[cli], 'MacOS/DeepSeek Harness', 'MacOS/rdsh Desktop');
  outputs[cli] = replace(outputs[cli], 'set -e', 'set -e\nDSH_HOME="${RDSH_DESKTOP_HOME:-$HOME/Library/Application Support/rdsh-desktop/harness}"\nexport DSH_HOME');
  const win = 'apps/desktop/cli/dsh.cmd';
  outputs[win] = replace(outputs[win], 'DeepSeek Harness.exe', 'rdsh Desktop.exe');
  outputs[win] = replace(outputs[win], 'setlocal DisableDelayedExpansion', 'setlocal EnableDelayedExpansion\r\nif defined RDSH_DESKTOP_HOME (set "DSH_HOME=!RDSH_DESKTOP_HOME!") else (set "DSH_HOME=!APPDATA!\\rdsh-desktop\\harness")\r\nsetlocal DisableDelayedExpansion');
  outputs['apps/desktop/rdsh-bootstrap.cjs'] = `// Generated rdsh carrier; official main remains the application engine.\nconst { app } = require('electron');\nconst { join, isAbsolute } = require('node:path');\nconst { existsSync } = require('node:fs');\napp.setName('rdsh Desktop');\nconst home = process.env.RDSH_DESKTOP_HOME || join(app.getPath('appData'), 'rdsh-desktop', 'harness');\nif (!isAbsolute(home)) throw new Error('RDSH_DESKTOP_HOME must be absolute');\nprocess.env.DSH_HOME = home;\nconst binary = join(process.resourcesPath, 'rdsh', '${nativeName}');\nif (!existsSync(binary)) throw new Error('Bundled Rust launcher is missing');\nprocess.env.RDSH_BIN = binary;\nprocess.env.RDSH_ORIG_BIN = join(process.resourcesPath, 'runtime', 'cli', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh');\nimport('./lib/main.js');\n`;
  return outputs;
}

export { sha as contentHash };
