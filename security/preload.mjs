// Register rdsh_inspect at ToolRuntime construction before it is exposed.
// Version/source mismatch aborts module loading.
import { registerHooks } from 'node:module';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { installToolBoundary } from './tool-isolation.mjs';

const adapters = Object.freeze({
  'dsh-tools-0.2.0-rc.2': '40f47709337c3c205d4e09e647f8588f4977e66f6d52f019b3cc7ef81159d84f',
  'dsh-tools-0.2.1-alpha.1': '2e9b6a72ba6b917197965c08eb894d4e8d01dc6f81e0e1c9870a5ae8514687a7',
  'dsh-tools-0.2.1-alpha.3': '614e4f50fff440f3f80cbe047148f7ad0ef2807ca27379e57f7e4f57925642cf',
});
const language = (() => {
  const value = (process.env.RDSH_SECURITY_LANG || process.env.RDSH_LANG || 'en').toLowerCase();
  if (value === 'zh' || value.startsWith('zh-') || value.startsWith('zh_')) return 'zh';
  if (value === 'ja' || value.startsWith('ja-') || value.startsWith('ja_')) return 'ja';
  return 'en';
})();
const messages = Object.freeze({
  INVALID_APPROVED_FILES: Object.freeze({ en: 'invalid approved file list', zh: '批准的文件列表无效', ja: '承認済みファイル一覧が無効です' }),
  UNKNOWN_ADAPTER: Object.freeze({ en: 'unsupported execution adapter', zh: '不支持的执行适配器', ja: '対応していない実行アダプターです' }),
  UNSUPPORTED_RUNTIME: Object.freeze({ en: 'unsupported tool runtime; refusing unguarded execution', zh: '不支持的工具运行时；拒绝不受保护的执行', ja: '対応していないツールランタイムです。保護されない実行を拒否します' }),
  RUNTIME_CHANGED: Object.freeze({ en: 'tool runtime changed during loading', zh: '工具运行时在加载期间发生变化', ja: '読み込み中にツールランタイムが変更されました' }),
  RUNTIME_RESOLUTION_MISMATCH: Object.freeze({ en: 'a dependency resolved a different tool runtime', zh: '依赖项解析到了不同的工具运行时', ja: '依存パッケージが別のツールランタイムを解決しました' }),
  UNSUPPORTED_CONSTRUCTOR: Object.freeze({ en: 'unsupported runtime constructor', zh: '不支持的运行时构造函数', ja: '対応していないランタイムコンストラクターです' }),
});
const securityError = code => new Error(`RDSH_SECURITY[${code}]: ${messages[code][language]}`);
// Keep legacy direct rc2 probes compatible; launchers select an explicit adapter.
const expected = adapters[process.env.RDSH_TOOL_ADAPTER ?? 'dsh-tools-0.2.0-rc.2'];
if (expected === undefined) throw securityError('UNKNOWN_ADAPTER');
const runtime = realpathSync(process.env.RDSH_TOOL_RUNTIME);
const workspace = realpathSync(process.env.RDSH_SECURE_WORKSPACE);
let approvedFiles;
try { approvedFiles = JSON.parse(process.env.RDSH_SHARED_FILES || '[]'); }
catch (cause) { throw new Error(securityError('INVALID_APPROVED_FILES').message, { cause }); }
if (!Array.isArray(approvedFiles)) throw securityError('INVALID_APPROVED_FILES');
const sharedFiles = Object.freeze(approvedFiles);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (digest(readFileSync(runtime)) !== expected) throw securityError('UNSUPPORTED_RUNTIME');
const target = pathToFileURL(runtime).href;
const key = Symbol.for('rdsh.tool-boundary.install');
Object.defineProperty(globalThis, key, { value: tools => installToolBoundary(tools, { workspace, sharedFiles }), writable: false, configurable: false });
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (specifier === '@deepseek-ai/dsh-tools' && resolved.url !== target)
      throw securityError('RUNTIME_RESOLUTION_MISMATCH');
    return resolved;
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== target) return loaded;
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
    if (digest(source) !== expected) throw securityError('RUNTIME_CHANGED');
    const marker = '\t\tthis.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls);';
    if (source.split(marker).length !== 2) throw securityError('UNSUPPORTED_CONSTRUCTOR');
    const patched = source
      .replace(marker, marker + '\n\t\tglobalThis[Symbol.for("rdsh.tool-boundary.install")](this);');
    return { ...loaded, source: patched };
  },
});

// Embedded launcher files are private and disposable. Keep source-mode probes
// intact; clean only the exact temporary directory created by the launcher.
const ownDirectory = new URL('.', import.meta.url);
if (/^\/tmp\/rdsh-tool-security-[0-9a-f]{48}\/$/.test(ownDirectory.pathname)) {
  process.once('exit', () => { try { rmSync(ownDirectory, { recursive: true, force: true }); } catch {} });
}
