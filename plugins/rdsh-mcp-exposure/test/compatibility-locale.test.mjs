import test from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { assertDshVersions, DSH_PACKAGES, DSH_VERSION, DSH_VERSIONS } from '../compatibility.js';
import { diagnosticLocale } from '../diagnostics.js';
import { compileConfig, ExposureError } from '../policy.js';
import { apply } from '../index.js';

const versions = (version = DSH_VERSION) => Object.fromEntries(DSH_PACKAGES.map(name => [name, version]));

test('each exact supported release accepts coherent peers and rejects mixed, unknown, future and missing peers', () => {
  assert.deepEqual(DSH_VERSIONS, ['0.2.0-rc.2', '0.2.1-alpha.3']);
  for (const release of DSH_VERSIONS) {
    assert.doesNotThrow(() => assertDshVersions(versions(release)));
    for (const name of DSH_PACKAGES) {
      for (const version of [...DSH_VERSIONS.filter(value => value !== release), '0.2.1-alpha.1', '0.2.1-alpha.4', undefined]) {
        assert.throws(() => assertDshVersions({ ...versions(release), [name]: version }), { code: 'RDSH_MCP_VERSION' });
      }
    }
  }
  for (const version of ['0.2.1-alpha.1', '0.2.1-alpha.4', undefined]) {
    assert.throws(() => assertDshVersions(Object.fromEntries(DSH_PACKAGES.map(name => [name, version]))), { code: 'RDSH_MCP_VERSION' });
  }
});

test('the installed upstream presentation schema retains its released modes', () => {
  for (const mode of ['native', 'ptc']) assert.equal(ToolRuntime.Config({ mode }).mode, mode);
  const release = createRequire(import.meta.url)('@deepseek-ai/dsh-tools/package.json').version;
  assert.ok(DSH_VERSIONS.includes(release));
  if (release === '0.2.0-rc.2') assert.equal(ToolRuntime.Config({ mode: 'both' }).mode, 'both');
  else assert.throws(() => ToolRuntime.Config({ mode: 'both' }));
});

test('saved language localizes owned configuration, runtime and guarded-launcher failures without changing codes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rdsh-mcp-locale-'));
  const previous = process.env.DSH_HOME;
  const symbol = Symbol.for('rdsh.tool-boundary.install');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, symbol);
  process.env.DSH_HOME = home;
  const expected = {
    en: { servers: 'servers must contain between 1 and 64 connections', version: 'rdsh-mcp-exposure requires matching DSH 0.2.0-rc.2 or 0.2.1-alpha.3 packages', ptc: 'PTC-only exposure requires an existing original DSH PTC runtime', guarded: 'The guarded rdsh launcher reserves its audited Native tool set; this bundle requires an existing authorized original DSH composition' },
    ja: { servers: 'serversの接続数は1件以上64件以下にしてください', version: 'rdsh-mcp-exposureには、版を揃えたDSH 0.2.0-rc.2または0.2.1-alpha.3が必要です', ptc: 'PTC専用の公開には、既存のオリジナルDSH PTCランタイムが必要です', guarded: '保護されたrdshランチャーは監査済みのNativeツール群を専用に使用します。このバンドルには、許可された既存のオリジナルDSH構成が必要です' },
    'zh-CN': { servers: 'servers必须包含1到64个连接', version: 'rdsh-mcp-exposure需要版本一致的DSH 0.2.0-rc.2或0.2.1-alpha.3', ptc: '仅PTC公开需要已有的原版DSH PTC运行时', guarded: '受保护的rdsh启动器专用经过审核的Native工具集；此包需要已有且获得授权的原版DSH配置' },
  };
  const config = { servers: [{ connection: { serverName: 'docs' }, exposure: 'ptc-only' }] };
  try {
    for (const [language, copy] of Object.entries(expected)) {
      await writeFile(join(home, 'rdsh.json'), JSON.stringify({ general: { language } }));
      assert.equal(diagnosticLocale(), language);
      assert.throws(() => compileConfig({ servers: [] }), { code: 'RDSH_MCP_CONFIG', message: copy.servers });
      assert.throws(() => assertDshVersions({ ...versions(), 'dsh-tools': '0.2.0-rc.2' }), { code: 'RDSH_MCP_VERSION', message: copy.version });
      await assert.rejects(apply({ get: () => undefined }, config), { code: 'RDSH_MCP_PTC_RUNTIME', message: copy.ptc });
      Object.defineProperty(globalThis, symbol, { value: true, configurable: true });
      try { await assert.rejects(apply({}, config), { code: 'RDSH_MCP_GUARDED_NATIVE', message: copy.guarded }); }
      finally { delete globalThis[symbol]; }
      const raw = new ExposureError('UPSTREAM_CODE', 'upstream raw text');
      assert.equal(raw.code, 'UPSTREAM_CODE');
      assert.equal(raw.message, 'upstream raw text');
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, symbol, descriptor);
    else delete globalThis[symbol];
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
