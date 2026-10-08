// The model never receives the host filesystem, environment or network.
// Unsupported hosts/runners throw; there is no unconfined retry.
import fs from 'node:fs/promises';
import { openSync, closeSync, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const forbiddenName = name => name.startsWith('.') || /^(credentials?\.(json|ya?ml)|auth\.json|id_(rsa|ed25519)|.*\.(pem|key|p12|pfx))$/i.test(name);
async function snapshot(root, destination, sharedFiles) {
  if (!Array.isArray(sharedFiles) || sharedFiles.length > 256) throw new Error('invalid approved file list');
  let total = 0;
  for (const relative of sharedFiles) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '..' || forbiddenName(part))) throw new Error('invalid approved file path');
    const source = path.join(root, relative);
    const canonical = await fs.realpath(source);
    if (canonical !== source || !canonical.startsWith(root + path.sep)) throw new Error('approved file cannot be a symlink');
    const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (await fs.realpath(`/proc/self/fd/${handle.fd}`) !== canonical) throw new Error('approved file changed during opening');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('approved file must be a bounded, singly linked regular file');
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      total += bytesRead;
      if (bytesRead > stat.size || total > 8 * 1024 * 1024) throw new Error('approved snapshot exceeds size limit');
      const output = path.join(destination, relative);
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await fs.writeFile(output, bytes.subarray(0, bytesRead), { mode: 0o400, flag: 'wx' });
    } finally { await handle.close(); }
  }
}

function socketFilter() {
  // Linux x86_64 seccomp_data: nr at 0, architecture at 4.
  const instructions = [];
  const add = (code, jt, jf, k) => instructions.push({ code, jt, jf, k });
  add(0x20, 0, 0, 4);
  add(0x15, 1, 0, 0xc000003e);
  add(0x06, 0, 0, 0x80000000); // kill mismatched ABI
  add(0x20, 0, 0, 0);
  add(0x35, 0, 1, 0x40000000);
  add(0x06, 0, 0, 0x80000000); // reject x32 ABI syscall aliases
  // Keep the process inside the namespaces and limits established by the
  // launcher. clone3 is unavailable; libc may fall back to filtered clone.
  add(0x15, 0, 1, 435);
  add(0x06, 0, 0, 0x00050026); // ENOSYS
  add(0x15, 0, 3, 56);
  add(0x20, 0, 0, 16); // clone flags, low word of arg0
  add(0x45, 0, 1, 0x7e020080); // CLONE_NEW* flags
  add(0x06, 0, 0, 0x00050001);
  add(0x20, 0, 0, 0);
  // Deny all socket calls, including filesystem Unix sockets, and io_uring
  // which can otherwise submit network operations without socket syscalls.
  for (const nr of [41, 42, 43, 44, 45, 46, 47, 49, 50, 51, 52, 53, 54, 55, 288, 425, 426, 427, 272, 308, 165, 166, 155, 161, 304, 321, 323, 298, 101, 310, 311]) {
    add(0x15, 0, 1, nr);
    add(0x06, 0, 0, 0x00050001); // EPERM
  }
  add(0x06, 0, 0, 0x7fff0000);
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(({ code, jt, jf, k }, index) => {
    bytes.writeUInt16LE(code, index * 8);
    bytes[index * 8 + 2] = jt;
    bytes[index * 8 + 3] = jf;
    bytes.writeUInt32LE(k, index * 8 + 4);
  });
  return bytes;
}

export async function executeIsolated({ workspace, command, sharedFiles = [], timeoutMs = 10000 }, { bwrap = '/usr/bin/bwrap' } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('sandbox enforcement currently requires Linux x86_64');
  if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 16384) throw new Error('invalid sandbox command');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('invalid sandbox timeout');
  try { await fs.access(bwrap); await fs.access('/usr/bin/prlimit'); } catch { throw new Error('sandbox runner unavailable'); }
  const root = await fs.realpath(workspace);
  if (!(await fs.stat(root)).isDirectory() || root === '/' || root === os.homedir()) throw new Error('sandbox requires a dedicated project directory');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rdsh-kernel-policy-'));
  let filter;
  try {
    const project = path.join(temporary, 'project');
    await fs.mkdir(project, { mode: 0o700 });
    await snapshot(root, project, sharedFiles);
    const file = path.join(temporary, 'seccomp');
    await fs.writeFile(file, socketFilter(), { mode: 0o600, flag: 'wx' });
    filter = openSync(file, 'r');
    const args = ['--die-with-parent', '--new-session', '--unshare-all', '--cap-drop', 'ALL', '--clearenv'];
    // No host /home, /root, /run, /etc or /usr/local. /proc is private to
    // the new PID namespace. Runtime files are trusted system dependencies.
    for (const directory of ['/usr/bin', '/usr/lib', '/usr/lib64', '/bin', '/lib', '/lib64']) {
      try { await fs.access(directory); args.push('--ro-bind', directory, directory); } catch { /* optional runtime path */ }
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', project, '/workspace');
    args.push('--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--chdir', '/workspace', '--seccomp', '3', '--', '/usr/bin/prlimit', '--as=134217728', '--cpu=3', '--nproc=16', '--nofile=64', '--fsize=8388608', '--', '/bin/sh', '-c', command);
    return await new Promise((resolve, reject) => {
      const child = spawn(bwrap, args, { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe', filter] });
      const stdout = [], stderr = [];
      let bytes = 0, interrupted = false;
      const timer = setTimeout(() => { interrupted = true; child.kill('SIGKILL'); }, timeoutMs);
      const collect = chunks => chunk => {
        bytes += chunk.length;
        if (bytes > 65536) { interrupted = true; child.kill('SIGKILL'); }
        else chunks.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', error => { clearTimeout(timer); reject(new Error(`sandbox runner unavailable: ${error.code}`)); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (interrupted || signal || code === null) reject(new Error('sandbox execution interrupted'));
        else resolve({ exitCode: code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      });
    });
  } finally {
    if (filter !== undefined) closeSync(filter);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export function installToolBoundary(tools, { workspace, sharedFiles = [] }) {
  if (!tools || typeof tools.guard !== 'function' || typeof tools.get !== 'function') throw new Error('required monotonic tools guard unavailable');
  const definition = {
    name: 'rdsh_inspect',
    description: 'Inspect this project in a kernel sandbox. Only files explicitly shared by the human are available, read-only. Disposable temporary storage is available. No network, host writes, escalation, plugins or background jobs.',
    parameters: { command: { type: 'string', required: true, description: 'Inspection command, run in /workspace.' } },
    output: { schema: { type: 'object', properties: { exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' } }, required: ['exitCode', 'stdout', 'stderr'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      if (!args || Object.keys(args).some(key => key !== 'command')) throw new Error('sandbox arguments do not permit permissions or environment overrides');
      return executeIsolated({ workspace, sharedFiles, command: args.command });
    },
  };
  // Register the denial before exposing any capability. Identity comparison
  // rejects a child/scoped tool that shadows the trusted tool's name.
  tools.guard(exec => exec.name === definition.name && tools.get(exec.name, exec.agent) === definition
    ? undefined : 'RDSH_SECURITY: this tool has no credential-isolated, network-denying execution adapter');
  tools.register(definition);
}
