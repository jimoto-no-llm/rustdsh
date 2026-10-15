// Install the global gate at ToolRuntime construction, before a model can
// dispatch anything. Version/source mismatch aborts module loading.
import { registerHooks } from 'node:module';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { installToolBoundary } from './tool-isolation.mjs';

const adapters = Object.freeze({
  'dsh-tools-0.2.0-rc.2': Object.freeze({
    source: '40f47709337c3c205d4e09e647f8588f4977e66f6d52f019b3cc7ef81159d84f',
    patched: 'fa1541f11a32b072dcf6b220e31c4d8005db92fe047a608b245f6400375cfa9a',
  }),
  'dsh-tools-0.2.1-alpha.1': Object.freeze({
    source: '2e9b6a72ba6b917197965c08eb894d4e8d01dc6f81e0e1c9870a5ae8514687a7',
    patched: '5c1bd431273fa6ecd32204a50dc4cc74f56a0599f17c57763e5017e8d94e370e',
  }),
  'dsh-tools-0.2.1-alpha.3': Object.freeze({
    source: '614e4f50fff440f3f80cbe047148f7ad0ef2807ca27379e57f7e4f57925642cf',
    patched: '5679e75706c2b5974d4bbfde2552fb90ead1a5448588ecde8d067956fb5d7a26',
  }),
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
  UNSUPPORTED_MODE_RESOLUTION: Object.freeze({ en: 'unsupported mode resolution', zh: '不支持的模式解析', ja: '対応していないモード解決です' }),
  UNSUPPORTED_SCOPED_PRESENTATION: Object.freeze({ en: 'unsupported scoped presentation', zh: '不支持的作用域呈现', ja: '対応していないスコープ表示です' }),
  UNSUPPORTED_BODY_DISPATCH: Object.freeze({ en: 'unsupported body dispatch', zh: '不支持的工具本体调度', ja: '対応していないツール本体のディスパッチです' }),
  UNSUPPORTED_PRE_POLICY: Object.freeze({ en: 'unsupported pre-policy dispatch', zh: '不支持的策略前调度', ja: '対応していないポリシー前ディスパッチです' }),
  UNSUPPORTED_CONSTRUCTOR: Object.freeze({ en: 'unsupported runtime constructor', zh: '不支持的运行时构造函数', ja: '対応していないランタイムコンストラクターです' }),
  PATCH_MISMATCH: Object.freeze({ en: 'audited runtime patch did not match', zh: '经过审计的运行时补丁不匹配', ja: '監査済みランタイムパッチが一致しません' }),
});
const securityError = code => new Error(`RDSH_SECURITY[${code}]: ${messages[code][language]}`);
const adapter = adapters[process.env.RDSH_TOOL_ADAPTER];
if (adapter === undefined) throw securityError('UNKNOWN_ADAPTER');
const runtime = realpathSync(process.env.RDSH_TOOL_RUNTIME);
const workspace = realpathSync(process.env.RDSH_SECURE_WORKSPACE);
let approvedFiles;
try { approvedFiles = JSON.parse(process.env.RDSH_SHARED_FILES || '[]'); }
catch (cause) { throw new Error(securityError('INVALID_APPROVED_FILES').message, { cause }); }
if (!Array.isArray(approvedFiles)) throw securityError('INVALID_APPROVED_FILES');
const sharedFiles = Object.freeze(approvedFiles);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const selectedDigest = digest(readFileSync(runtime));
if (selectedDigest !== adapter.source) throw securityError('UNSUPPORTED_RUNTIME');
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
    if (digest(source) !== selectedDigest) throw securityError('RUNTIME_CHANGED');
    const marker = '\t\tthis.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls);';
    const modeResolution = '\tmodeFor(scope) {\n';
    if (source.split(modeResolution).length !== 2) throw securityError('UNSUPPORTED_MODE_RESOLUTION');
    const presentation = '\tpresentAs(mode) {\n\t\tconst ctx = this.ctx;';
    if (source.split(presentation).length !== 2) throw securityError('UNSUPPORTED_SCOPED_PRESENTATION');
    const bodyResolution = '\t\texec.signal = signal;\n\t\ttry {\n\t\t\tconst tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);';
    if (source.split(bodyResolution).length !== 2) throw securityError('UNSUPPORTED_BODY_DISPATCH');
    const prePolicy = '\t\ttry {\n\t\t\tconst carrier = scopeTarget(this, exec.agent);\n\t\t\tconst gate = await this.ctx.waterfall(carrier, "tools/pre-execute"';
    if (source.split(prePolicy).length !== 2) throw securityError('UNSUPPORTED_PRE_POLICY');
    if (source.split(marker).length !== 2) throw securityError('UNSUPPORTED_CONSTRUCTOR');
    // Around-dispatch middleware can change the execution or scoped registry
    // after the initial guard. Recheck synchronously next to body resolution.
    const guardedBody = bodyResolution.replace('\t\ttry {\n',
      '\t\ttry {\n\t\t\tconst boundaryDenial = this.guardReason(exec);\n\t\t\tif (boundaryDenial !== undefined) throw new Error(boundaryDenial);\n');
    // Forbidden tools must also stop before extensible policy can ask for
    // approval. Keep the original post-policy guard for policy rewrites.
    const guardedPrePolicy = prePolicy.replace('\t\ttry {\n',
      '\t\ttry {\n\t\t\tconst boundaryDenial = this.guardReason(exec);\n\t\t\tif (boundaryDenial !== undefined) throw new Error(boundaryDenial);\n');
    const patched = source
      .replace(marker, marker + '\n\t\tthis.defaultMode = "native";\n\t\tglobalThis[Symbol.for("rdsh.tool-boundary.install")](this);')
      .replace(modeResolution, modeResolution + '\t\treturn "native";\n')
      .replace(presentation, '\tpresentAs(mode) {\n\t\tmode = "native";\n\t\tconst ctx = this.ctx;')
      .replace(prePolicy, guardedPrePolicy)
      .replace(bodyResolution, guardedBody);
    if (digest(patched) !== adapter.patched) throw securityError('PATCH_MISMATCH');
    return { ...loaded, source: patched };
  },
});

// Embedded launcher files are private and disposable. Keep source-mode probes
// intact; clean only the exact temporary directory created by the launcher.
const ownDirectory = new URL('.', import.meta.url);
if (/^\/tmp\/rdsh-tool-security-[0-9a-f]{48}\/$/.test(ownDirectory.pathname)) {
  process.once('exit', () => { try { rmSync(ownDirectory, { recursive: true, force: true }); } catch {} });
}
