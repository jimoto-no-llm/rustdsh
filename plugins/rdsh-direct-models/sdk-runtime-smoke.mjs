import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm, unlink, realpath, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseTurnResponse, buildTurnPrompt } from './json-turn.mjs';
import { registerDevinTool } from './devin-tool.mjs';
const requireInstalled = createRequire(path.join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/package.json'));
async function installed(name) { return import(pathToFileURL(requireInstalled.resolve(name)).href); }
export const DEVIN_SMOKE_PROMPT = 'Reply exactly RDSH_DEVIN_TOOL_OK. Do not read files or use tools.';
export async function runRuntimeSmoke({ liveDevin = false, spawnImpl, workspace: existingWorkspace } = {}) {
  const [{ Context }, { ToolRuntime }, { SystemPrompt }, { LocalFileSystem }, fsTools] = await Promise.all([
    installed('@deepseek-ai/cordis'), installed('@deepseek-ai/dsh-tools'), installed('@deepseek-ai/dsh-system-prompt'), installed('@deepseek-ai/dsh-fs-local'), installed('@deepseek-ai/dsh-tool-fs'),
  ]);
  if (existingWorkspace && !path.isAbsolute(existingWorkspace)) throw new Error('Runtime fixture workspace must be absolute');
  const workspace = existingWorkspace ? await realpath(existingWorkspace) : await mkdtemp(path.join(tmpdir(), 'rdsh-sdk-runtime-'));
  if (!(await stat(workspace)).isDirectory()) throw new Error('Runtime fixture workspace must be an existing directory');
  const ctx = new Context();
  let grantedCall, approvalCount = 0, spawned = 0, fixtureCreated = false;
  const fixturePath = path.join(workspace, `.rdsh-runtime-fixture-${randomUUID()}.txt`);
  const expected = 'RDSH_RUNTIME_FILE_OK';
  try {
    await writeFile(fixturePath, expected + '\n', { flag: 'wx' });
    fixtureCreated = true;
    new SystemPrompt(ctx, { includeHarnessIdentity: false });
    new ToolRuntime(ctx);
    new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 1024 * 1024 });
    fsTools.apply(ctx, { readLimit: 100, readMaxLineLength: 1000, readMaxBytes: 4096, readStreamMinSize: 4096 });
    ctx.provide('approval', { async request(request) {
      approvalCount++;
      return request.callId === grantedCall ? 'allowed-once' : 'rejected';
    } });
    ctx.on('tools/pre-execute', async (exec, next) => {
      const inherited = await next();
      if (inherited.kind !== 'allow') return inherited;
      if (exec.name === 'read') return exec.arguments.file_path === fixturePath ? { kind: 'ask', reason: 'Isolated runtime fixture read' } : { kind: 'deny', reason: 'Outside exact fixture' };
      if (exec.name === 'devin_cli') return exec.arguments.prompt === DEVIN_SMOKE_PROMPT && Object.keys(exec.arguments).every(k => ['prompt', 'timeout'].includes(k)) ? inherited : { kind: 'deny', reason: 'Outside exact fixture prompt' };
      return { kind: 'deny', reason: 'Runtime smoke permits only exact fixture operations' };
    });
    const { spawn } = await import('node:child_process');
    registerDevinTool(ctx, { spawnImpl: (...args) => { spawned++; return (spawnImpl ?? spawn)(...args); } });
    const agent = { session: { header: { cwd: workspace } } };
    const signal = new AbortController().signal;
    const readTool = ctx.tools.schemas().find(t => t.name === 'read');
    const parsed = parseTurnResponse(JSON.stringify({ version: 1, text: '', toolCalls: [{ id: 'read-denied', name: 'read', arguments: { file_path: fixturePath } }] }), [readTool]);
    const execute = (id, name, args) => ctx.tools.execute({ callId: id, name, arguments: args, agent, signal });
    const invalid = await execute('invalid-read', 'read', { file_path: 42 });
    assert.equal(invalid.isError, true);
    assert.equal(approvalCount, 0);
    const denied = await execute(parsed.toolCalls[0].id, 'read', JSON.parse(parsed.toolCalls[0].arguments));
    assert.equal(denied.isError, true);
    grantedCall = 'read-allowed';
    const allowed = await execute(grantedCall, 'read', { file_path: fixturePath });
    assert.ok(!allowed.isError, JSON.stringify(allowed));
    assert.match(JSON.stringify(allowed.content), /RDSH_RUNTIME_FILE_OK/);
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'Read the fixture.' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: grantedCall, name: 'read', arguments: { file_path: fixturePath } }] },
      { role: 'tool', toolCallId: grantedCall, content: allowed.content },
    ];
    assert.match(buildTurnPrompt({ messages: history, tools: [readTool] }), /RDSH_RUNTIME_FILE_OK/);
    grantedCall = undefined;
    const devinDenied = await execute('devin-denied', 'devin_cli', { prompt: DEVIN_SMOKE_PROMPT, timeout: 60 });
    assert.equal(devinDenied.isError, true);
    assert.equal(spawned, 0);
    let devinAllowed;
    if (liveDevin) {
      grantedCall = 'devin-allowed';
      devinAllowed = await execute(grantedCall, 'devin_cli', { prompt: DEVIN_SMOKE_PROMPT, timeout: 60 });
      assert.ok(!devinAllowed.isError, JSON.stringify(devinAllowed));
      const value = JSON.parse(devinAllowed.content.find(part => part.type === 'text').text);
      assert.equal(value.exitCode, 0, 'Devin CLI must exit successfully');
      assert.match(value.stdout, /RDSH_DEVIN_TOOL_OK/);
      assert.equal(spawned, 1);
    }
    return { runtime: 'installed @deepseek-ai/dsh-tools ToolRuntime + Cordis', invalidArgumentsBlocked: true, readDenied: true, readExecuted: true, resultInModelHistory: true, devinDeniedWithoutSpawn: true, devinExecuted: liveDevin, approvalCount, spawned, ...(devinAllowed ? { devinResult: devinAllowed.content } : {}) };
  } finally {
    if (existingWorkspace && fixtureCreated) await unlink(fixturePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    else if (!existingWorkspace) await rm(workspace, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workspaceIndex = process.argv.indexOf('--workspace');
  if (workspaceIndex !== -1 && !process.argv[workspaceIndex + 1]) throw new Error('--workspace requires an absolute directory');
  console.log(JSON.stringify(await runRuntimeSmoke({ liveDevin: process.argv.includes('--live-devin'), workspace: workspaceIndex === -1 ? undefined : process.argv[workspaceIndex + 1] })));
}
