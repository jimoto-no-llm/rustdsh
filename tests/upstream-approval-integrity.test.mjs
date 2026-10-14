// Integration tests against an explicitly selected DSH tool-bash source.
// No real shell execution, model call, network request, or credentials.
// DSH links approval to the already-presented tool call by callId; it does not
// duplicate command arguments in the approval reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.env.DSH_TOOL_BASH_SOURCE;
assert.ok(source, 'DSH_TOOL_BASH_SOURCE must point to the pinned DSH tool-bash implementation');
assert.ok(path.isAbsolute(source), 'DSH_TOOL_BASH_SOURCE must be an absolute file path');
const packageJsonPath = path.resolve(path.dirname(source), '..', 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
assert.equal(packageJson.name, '@deepseek-ai/dsh-tool-bash');
assert.equal(packageJson.version, '0.2.0-rc.2', 'test the audited DSH runtime version');

test('pinned DSH approval is linked to the exact presented bash call', async t => {
  const bash = await import(pathToFileURL(source));
  let tool, asked, executed;
  let outcome = 'allowed-once';
  const args = {
    command: 'printf DUMMY_COMMAND', description: 'List documentation',
    workdir: 'subdir', justification: 'List documentation',
    sandbox_permissions: 'danger-full-access',
  };
  const policy = { mode: 'workspace-write', workspaceRoot: '/dummy-workspace' };
  const ctx = {
    tools: { register(value) { tool = value; } },
    shell: {
      sandboxMode: policy.mode,
      resolve(value) { return value; },
      async execute(value) {
        executed = value;
        return { async result() { return { stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000 }; } };
      },
    },
    get(name) {
      if (name === 'sandboxPolicy') return { resolve() { return policy; } };
      if (name === 'approval') return { async request(value) {
        asked = value;
        return outcome;
      } };
    },
    systemPrompt: { section() {}, getSectionOrder() { return 1; } },
    shellEnv: { collect() { return {}; } },
  };
  bash.apply(ctx, { enableRunInBackground: false });
  const presented = tool.presentCall(args);
  assert.equal(presented.title, args.command, 'the tool call presentation must show the command');
  assert.equal(presented.description, args.description);
  assert.equal(presented.cwd, args.workdir, 'the tool call presentation must show its requested cwd');
  const callId = 'dummy-call';
  const callExec = { agent: { session: { header: { cwd: policy.workspaceRoot } } }, callId, signal: new AbortController().signal };
  await tool.execute(args, callExec);
  assert.equal(asked.callId, callId, 'approval must attach to the already-presented tool call');
  assert.equal(asked.toolName, 'bash');
  assert.equal(asked.agent, callExec.agent);
  assert.equal(asked.reason, 'escalate sandbox to danger-full-access: List documentation');
  assert.equal(executed.command, 'printf DUMMY_COMMAND');
  assert.equal(executed.workdir, `${policy.workspaceRoot}${path.sep}subdir`);
  const exec = { agent: { session: { header: { cwd: '/dummy-workspace' } } }, callId: 'another-dummy', signal: new AbortController().signal };
  await t.test('rejection never dispatches the shell', async () => {
    outcome = 'rejected';
    executed = undefined;
    await assert.rejects(tool.execute({ ...args }, exec), /rejected/);
    assert.equal(executed, undefined);
  });
  await t.test('an omitted per-call cwd resolves to the session workspace', async () => {
    outcome = 'allowed-once';
    const withoutWorkdir = { ...args };
    delete withoutWorkdir.workdir;
    await tool.execute(withoutWorkdir, exec);
    assert.equal(executed.command, withoutWorkdir.command);
    assert.equal(executed.workdir, '/dummy-workspace');
  });
});
