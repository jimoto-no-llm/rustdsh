// Register rdsh_inspect at ToolRuntime construction before it is exposed.
// Version/source mismatch aborts module loading.
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
    if (source.split(marker).length !== 2) throw new Error('RDSH_SECURITY: unsupported runtime constructor');
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
