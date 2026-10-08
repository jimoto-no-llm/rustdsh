// Integration tests against an explicitly selected DSH tool-bash source.
// No real shell execution, model call, network request, or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const source = process.env.DSH_TOOL_BASH_SOURCE;
test('approval includes the exact command and cwd even without the chat detail slot', { skip: !source }, async t => {
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
        // A pending approval must not permit execution of mutated arguments.
        args.command = 'printf DIFFERENT_DUMMY_COMMAND';
        args.workdir = '/different-workspace';
        return outcome;
      } };
    },
    systemPrompt: { section() {}, getSectionOrder() { return 1; } },
    shellEnv: { collect() { return {}; } },
  };
  bash.apply(ctx, { enableRunInBackground: false });
  await tool.execute(args, { agent: { session: { header: { cwd: policy.workspaceRoot } } }, callId: 'dummy-call', signal: new AbortController().signal });
  for (const reason of [asked.reason, asked.displayReason.en, asked.displayReason.zh]) {
    assert.ok(reason.includes('printf DUMMY_COMMAND'), 'approval must carry the command independently of chat');
    assert.ok(reason.includes('/dummy-workspace/subdir'), 'approval must carry the resolved cwd');
  }
  assert.equal(executed.command, 'printf DUMMY_COMMAND');
  assert.equal(executed.workdir, '/dummy-workspace/subdir');
  const exec = { agent: { session: { header: { cwd: '/dummy-workspace' } } }, callId: 'another-dummy', signal: new AbortController().signal };
  await t.test('rejection never dispatches the shell', async () => {
    outcome = 'rejected';
    executed = undefined;
    await assert.rejects(tool.execute({ ...args }, exec), /rejected/);
    assert.equal(executed, undefined);
  });
  await t.test('unknown cwd cannot be approved', async () => {
    outcome = 'allowed-once';
    const workspace = policy.workspaceRoot;
    delete policy.workspaceRoot;
    try {
      const withoutWorkdir = { ...args };
      delete withoutWorkdir.workdir;
      await assert.rejects(tool.execute(withoutWorkdir, { ...exec, agent: { session: { header: {} } } }), /resolved working directory/);
      assert.equal(executed, undefined);
    } finally {
      policy.workspaceRoot = workspace;
    }
  });
  await t.test('control and bidi characters cannot alter the approval display', async () => {
    await tool.execute({ ...args, command: 'printf DUMMY\r\n\u202eHIDDEN', justification: 'Docs\u2066only' }, exec);
    assert.ok(asked.reason.includes('\\r\\n\\u202e'));
    assert.ok(asked.reason.includes('\\u2066'));
    assert.ok(!asked.reason.includes('\u202e'));
    assert.ok(!asked.reason.includes('\u2066'));
  });
});
