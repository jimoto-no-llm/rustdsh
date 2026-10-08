// Install the global gate at ToolRuntime construction, before a model can
// dispatch anything. Version/source mismatch aborts module loading.
import { registerHooks } from 'node:module';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { installToolBoundary } from './tool-isolation.mjs';

const expected = '40f47709337c3c205d4e09e647f8588f4977e66f6d52f019b3cc7ef81159d84f';
const runtime = realpathSync(process.env.RDSH_TOOL_RUNTIME);
const workspace = realpathSync(process.env.RDSH_SECURE_WORKSPACE);
const sharedFiles = Object.freeze(JSON.parse(process.env.RDSH_SHARED_FILES || '[]'));
if (!Array.isArray(sharedFiles)) throw new Error('RDSH_SECURITY: invalid approved file list');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (digest(readFileSync(runtime)) !== expected) throw new Error('RDSH_SECURITY: unsupported tool runtime; refusing unguarded execution');
const target = pathToFileURL(runtime).href;
const key = Symbol.for('rdsh.tool-boundary.install');
Object.defineProperty(globalThis, key, { value: tools => installToolBoundary(tools, { workspace, sharedFiles }), writable: false, configurable: false });
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== target) return loaded;
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
    if (digest(source) !== expected) throw new Error('RDSH_SECURITY: tool runtime changed during loading');
    const marker = '\t\tthis.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls);';
    const modeResolution = '\tmodeFor(scope) {\n';
    if (source.split(modeResolution).length !== 2) throw new Error('RDSH_SECURITY: unsupported mode resolution');
    const presentation = '\tpresentAs(mode) {\n\t\tconst ctx = this.ctx;';
    if (source.split(presentation).length !== 2) throw new Error('RDSH_SECURITY: unsupported scoped presentation');
    const bodyResolution = '\t\texec.signal = signal;\n\t\ttry {\n\t\t\tconst tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);';
    if (source.split(bodyResolution).length !== 2) throw new Error('RDSH_SECURITY: unsupported body dispatch');
    const prePolicy = '\t\ttry {\n\t\t\tconst carrier = scopeTarget(this, exec.agent);\n\t\t\tconst gate = await this.ctx.waterfall(carrier, "tools/pre-execute"';
    if (source.split(prePolicy).length !== 2) throw new Error('RDSH_SECURITY: unsupported pre-policy dispatch');
    if (source.split(marker).length !== 2) throw new Error('RDSH_SECURITY: unsupported runtime constructor');
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
    return { ...loaded, source: patched };
  },
});

// Embedded launcher files are private and disposable. Keep source-mode probes
// intact; clean only the exact temporary directory created by the launcher.
const ownDirectory = new URL('.', import.meta.url);
if (/^\/tmp\/rdsh-tool-security-[0-9a-f]{48}\/$/.test(ownDirectory.pathname)) {
  process.once('exit', () => { try { rmSync(ownDirectory, { recursive: true, force: true }); } catch {} });
}
