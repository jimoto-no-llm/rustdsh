import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeTarget, packagedPaths } from '../build.mjs';

test('native packaging chooses only a supported host with the same Rust/Electron architecture', () => {
  assert.equal(nativeTarget('win32', 'x64'), 'win:x64');
  assert.equal(nativeTarget('darwin', 'arm64'), 'mac:arm64');
  assert.equal(nativeTarget('darwin', 'x64'), 'mac:x64');
  for (const pair of [['linux', 'x64'], ['win32', 'arm64'], ['darwin', 'ia32']]) assert.throws(() => nativeTarget(...pair));
});

test('unsigned application paths follow the real renamed builder output for every supported architecture', () => {
  const root = join(tmpdir(), 'rdsh-build-fixture');
  for (const [platform, arch, target] of [['win32', 'x64', 'win-x64'], ['darwin', 'arm64', 'mac-arm64'], ['darwin', 'x64', 'mac-x64']]) {
    const paths = packagedPaths(root, platform, arch);
    assert.equal(paths.target, target); assert.ok(paths.application.includes('unsigned-artifacts'));
    assert.ok(paths.executable.endsWith(platform === 'win32' ? 'rdsh Desktop.exe' : 'rdsh Desktop'));
    assert.ok(paths.resources.endsWith('Resources') || paths.resources.endsWith('resources'));
  }
});
