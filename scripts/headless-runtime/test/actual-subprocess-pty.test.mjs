import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const candidate = process.env.RDSH_CANDIDATE;

test('candidate node-pty prebuild starts and joins a credential-free local PTY command', { skip: !candidate }, async () => {
  const { spawn } = await import(path.join(candidate, 'node_modules/node-pty/lib/index.js'));
  const pty = spawn(process.execPath, ['-e', 'process.stdout.write("PTY_OK")'], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: tmpdir(), env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color' },
  });
  let output = '';
  const outcome = await Promise.race([
    new Promise(resolve => {
      pty.onData(data => { output += data; });
      pty.onExit(result => resolve(result));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('local PTY command did not exit')), 1_000)),
  ]);
  assert.equal(outcome.exitCode, 0);
  assert.match(output, /PTY_OK/);
});
