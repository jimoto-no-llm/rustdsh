import { constants, closeSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { exact, failure } from './validation.mjs';

const FILE_LIMIT = 65536;
const OUTPUT_LIMIT = 65536;

function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 512 && !isAbsolute(path) &&
    !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part && part !== '..' && !part.startsWith('.'));
}

function canonicalDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw failure('INVALID_WORKSPACE');
  return path;
}

function regularFile(root, path) {
  if (!safeRelative(path)) throw failure('FILE_DENIED');
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw failure('FILE_DENIED');
  }
  const rel = relative(root, cursor);
  if (!rel || rel.startsWith(`..${sep}`) || realpathSync(cursor) !== cursor || !lstatSync(cursor).isFile()) throw failure('FILE_DENIED');
  return cursor;
}

export function supportedSandbox() {
  return process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
    ? { supported: true, kind: 'macos-sandbox-exec' }
    : { supported: false, kind: 'unsupported', reason: 'OS_SANDBOX_UNAVAILABLE' };
}

// Exact, single-occurrence edits to existing allowlisted files only. No test edits,
// file creation, directory traversal, symlink following, or arbitrary commands.
export async function editFixture(workspace, coding, args) {
  exact(args, ['path', 'search', 'replace']);
  canonicalDirectory(workspace);
  if (!coding || !Array.isArray(coding.editableFiles) || !Array.isArray(coding.testFiles) ||
      !safeRelative(args.path) || !coding.editableFiles.includes(args.path) || coding.testFiles.includes(args.path) ||
      typeof args.search !== 'string' || !args.search || args.search.includes('\0') ||
      typeof args.replace !== 'string' || args.replace.includes('\0') ||
      Buffer.byteLength(args.search) > FILE_LIMIT || Buffer.byteLength(args.replace) > FILE_LIMIT) throw failure('EDIT_DENIED');
  let fd;
  try {
    const target = regularFile(workspace, args.path);
    fd = openSync(target, constants.O_RDWR | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > FILE_LIMIT) throw failure('EDIT_DENIED');
    const original = readFileSync(fd, 'utf8');
    if (original.includes('\0') || Buffer.byteLength(original) > FILE_LIMIT) throw failure('EDIT_DENIED');
    const first = original.indexOf(args.search);
    if (first === -1 || original.indexOf(args.search, first + 1) !== -1) throw failure('EDIT_MATCH_COUNT');
    const updated = original.slice(0, first) + args.replace + original.slice(first + args.search.length);
    const bytes = Buffer.from(updated, 'utf8');
    if (bytes.length > FILE_LIMIT) throw failure('EDIT_DENIED');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    ftruncateSync(fd, bytes.length);
    return { path: args.path, replacements: 1, bytes: bytes.length };
  } catch (error) {
    if (['EDIT_DENIED', 'EDIT_MATCH_COUNT'].includes(error.code)) throw error;
    throw failure('EDIT_DENIED');
  } finally { if (fd !== undefined) closeSync(fd); }
}

export { validateGradingSources } from './source-policy.mjs';

function quoteProfile(path) { return JSON.stringify(path); }

const runtimeCache = new Map();
function runtimeLibraries(node) {
  if (runtimeCache.has(node)) return runtimeCache.get(node);
  const discovered = new Set(), inspected = new Set();
  let pending = [node];
  // Ask the trusted system inspector for the selected runtime's dylib closure.
  // Only exact library paths are granted; no Homebrew or home tree is exposed.
  for (let round = 0; pending.length && round < 8; round++) {
    const result = spawnSync('/usr/bin/otool', ['-L', ...pending], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw failure('NODE_RUNTIME_UNAVAILABLE');
    pending.forEach(path => inspected.add(path));
    pending = [];
    let image = node;
    for (const line of result.stdout.split('\n')) {
      if (!line.startsWith('\t')) { if (line.endsWith(':')) image = line.slice(0, -1); continue; }
      let dependency = line.trim().split(' (')[0];
      if (dependency.startsWith('/System/Library/') || dependency.startsWith('/usr/lib/')) continue;
      if (dependency.startsWith('@loader_path/')) dependency = resolve(dirname(image), dependency.slice(13));
      if (dependency.startsWith('@rpath/')) {
        const suffix = dependency.slice(7);
        dependency = [resolve(dirname(image), suffix), resolve(dirname(node), '../lib', suffix)].find(path => existsSync(path));
      }
      if (typeof dependency !== 'string' || !isAbsolute(dependency) || !existsSync(dependency)) throw failure('NODE_RUNTIME_UNAVAILABLE');
      const canonical = realpathSync(dependency);
      discovered.add(dependency); discovered.add(canonical);
      if (discovered.size > 512) throw failure('NODE_RUNTIME_UNAVAILABLE');
      if (!inspected.has(canonical) && !pending.includes(canonical)) pending.push(canonical);
    }
  }
  if (pending.length) throw failure('NODE_RUNTIME_UNAVAILABLE');
  const libraries = [...discovered]; runtimeCache.set(node, libraries); return libraries;
}

function sandboxProfile({ workspace, graderRoot, scratch, node, libraries }) {
  const readable = [...new Set([workspace, graderRoot, scratch].filter(Boolean))];
  return `(version 1)
(deny default)
(allow process-exec (literal ${quoteProfile(node)}))
(allow signal (target self))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read*
  (literal "/")
  (literal ${quoteProfile(node)})
  ${libraries.map(path => `(literal ${quoteProfile(path)})`).join('\n  ')}
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
  (subpath "/System/Library") (subpath "/usr/lib")
  ${readable.map(path => `(subpath ${quoteProfile(path)})`).join('\n  ')})
(allow file-write* (subpath ${quoteProfile(scratch)}))`;
}

function tapCount(text, name) {
  const matches = [...text.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

// The OS sandbox is mandatory. cwd/env filtering alone is not a sandbox. Only
// the fixed node --test command is exposed; subprocess creation is denied.
export async function runFixtureTests({ workspace, testFiles, node = process.execPath, timeoutMs = 10000, graderRoot, fixtureRoot = workspace, signal } = {}) {
  if (!supportedSandbox().supported) throw failure('OS_SANDBOX_UNAVAILABLE');
  canonicalDirectory(workspace);
  canonicalDirectory(fixtureRoot);
  if (graderRoot !== undefined) canonicalDirectory(graderRoot);
  const testRoot = graderRoot ?? workspace;
  if (!Array.isArray(testFiles) || testFiles.length < 1 || testFiles.length > 16 || new Set(testFiles).size !== testFiles.length ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw failure('INVALID_TEST_REQUEST');
  const tests = testFiles.map(path => regularFile(testRoot, path));
  node = realpathSync(node);
  if (!lstatSync(node).isFile() || !isAbsolute(node)) throw failure('INVALID_NODE');
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rdsh-harness2-test-')));
  const started = Date.now();
  let stdout = '', stderr = '', outputBytes = 0, timedOut = false, outputLimited = false;
  let child;
  const kill = () => {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }
  };
  const abort = () => kill();
  try {
    signal?.throwIfAborted();
    const profile = sandboxProfile({ workspace, graderRoot, scratch, node, libraries: runtimeLibraries(node) });
    child = spawn('/usr/bin/sandbox-exec', ['-p', profile, node, '--test', '--test-isolation=none', '--test-reporter=tap', ...tests], {
      cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { LANG: 'C.UTF-8', OPENSSL_CONF: '/dev/null', PATH: dirname(node), HOME: scratch, TMPDIR: scratch, RDSH_FIXTURE_ROOT: fixtureRoot },
    });
    const collect = stream => chunk => {
      const remaining = Math.max(0, OUTPUT_LIMIT - outputBytes);
      const decoded = Buffer.from(chunk.toString('utf8'));
      // Bound the returned UTF-8 text as well as input bytes (invalid byte
      // sequences otherwise expand to three-byte replacement characters).
      const accepted = new StringDecoder('utf8').write(decoded.subarray(0, remaining));
      if (stream === 'stdout') stdout += accepted; else stderr += accepted;
      outputBytes += Buffer.byteLength(accepted);
      if (decoded.length > remaining || chunk.length > remaining) { outputLimited = true; kill(); }
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) kill();
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    let exitCode;
    try {
      exitCode = await new Promise((accept, reject) => {
        child.once('error', () => reject(failure('TEST_LAUNCH_FAILED')));
        child.once('close', code => accept(code));
      });
    } finally { clearTimeout(timer); }
    signal?.throwIfAborted();
    return { exitCode, passed: tapCount(stdout, 'pass'), failed: tapCount(stdout, 'fail'), tests: tapCount(stdout, 'tests'), stdout, stderr,
      wallMs: Date.now() - started, sandbox: supportedSandbox().kind, timedOut, outputLimited };
  } finally {
    signal?.removeEventListener('abort', abort);
    kill(); // Also clean up descendants after a successful parent exit.
    rmSync(scratch, { recursive: true, force: true });
  }
}
