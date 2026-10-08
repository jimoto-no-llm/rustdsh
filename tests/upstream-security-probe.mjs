// Component probe only: no model, real credentials, shell process, or external request.
// Usage: node tests/upstream-security-probe.mjs <installed dsh node_modules/@deepseek-ai>
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
const root = process.argv[2];
if (!root) throw new Error('Pass an installed DSH module root');
const load = name => import(pathToFileURL(path.join(root, name, 'lib/index.js')));
const bash = await load('dsh-tool-bash');
let tool, approvalRequest, executed;
const policy = { mode: 'workspace-write', workspaceRoot: '/dummy-workspace' };
const command = 'printf DUMMY_UPLOAD_COMMAND';
const ctx = {
  tools: { register(value) { tool = value; } },
  shell: {
    sandboxMode: policy.mode,
    resolve(value) { return value; },
    async execute(value) {
      executed = value;
      return { async result() { return { stdout: { text: 'DUMMY', truncated: false }, stderr: { text: '', truncated: false }, exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000 }; } };
    },
  },
  get(name) {
    if (name === 'sandboxPolicy') return { resolve() { return policy; } };
    if (name === 'approval') return { async request(value) { approvalRequest = value; return 'allowed-once'; } };
  },
  systemPrompt: { section() {}, getSectionOrder() { return 1; } },
  shellEnv: { collect() { return {}; } },
};
bash.apply(ctx, { enableRunInBackground: false });
await tool.execute({ command, description: 'List documentation', justification: 'List documentation', sandbox_permissions: 'danger-full-access' }, { agent: { session: { header: { cwd: '/dummy-workspace' } } }, callId: 'dummy-call', signal: new AbortController().signal });
assert.equal(executed.command, command);
const commandVisible = JSON.stringify(approvalRequest).includes(command);
console.log(JSON.stringify({ probe: 'approval-command-integrity', component: 'installed DSH tool-bash', command_visible_in_approval_request: commandVisible, requester_reason: approvalRequest.reason, executed_dummy_command: executed.command, real_shell_dispatches: 0, network_requests: 0 }, null, 2));

const { SandboxedFileSystem } = await load('dsh-fs-sandbox');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rdsh-upstream-probe-'));
try {
  const repo = path.join(temporary, 'workspace');
  await fs.mkdir(repo);
  const outside = path.join(temporary, 'dummy-credentials.json');
  await fs.writeFile(outside, 'DUMMY_PRIVATE_VALUE');
  const { Context } = await load('cordis');
  const host = new Context();
  host.provide('sandboxPolicy', { defaultMode: 'workspace-write', resolve() { return { mode: 'workspace-write', workspaceRoot: repo }; } });
  const backend = new SandboxedFileSystem(host, { cwd: repo, diffBasisMaxBytes: 1024 * 1024 });
  const target = await backend.resolve(outside);
  const read = await backend.readText(target);
  const text = typeof read === 'string' ? read : JSON.stringify(read);
  console.log(JSON.stringify({ probe: 'filesystem-read-boundary', mode: 'workspace-write', outside_workspace_dummy_read: text.includes('DUMMY_PRIVATE_VALUE'), real_credentials_read: false }, null, 2));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
