import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { apply } from '../index.mjs';
import { supportedSandbox } from '../coding-tools.mjs';
import { gradeCoding } from '../grade-coding.mjs';
import { validateRequest } from '../validation.mjs';

test('coding request rejects improver capabilities, test edits, hidden and escaping paths', () => {
  const request = { version: 1, role: 'solver', workspace: process.cwd(), prompt: 'Fix code', harness: {},
    provider: 'fixture', model: 'fixture', timeoutMs: 3000, maxSteps: 4,
    coding: { editableFiles: ['src/calc.mjs'], testFiles: ['test/public.test.mjs'], testTimeoutMs: 1000 } };
  assert.equal(validateRequest(request), request);
  for (const changed of [ { role: 'improver' }, { coding: { ...request.coding, editableFiles: ['../secret'] } },
    { coding: { ...request.coding, editableFiles: ['.env'] } }, { coding: { ...request.coding, editableFiles: request.coding.testFiles } },
    { coding: { ...request.coding, command: 'arbitrary' } } ]) assert.throws(() => validateRequest({ ...request, ...changed }));
});

test('real Cordis coding tools reproduce failure, edit source, pass tests, and preserve original tests', async t => {
  if (!supportedSandbox().supported) { t.skip('OS coding sandbox unavailable'); return; }
  const installation = process.env.RDSH_HARNESS2_DSH_PACKAGE || join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh');
  const modules = process.env.RDSH_PUBLIC_DSH_MODULES || join(installation, 'node_modules');
  const modulePath = name => join(modules, '@deepseek-ai', name, 'lib/index.js');
  if (!['cordis', 'dsh-system-prompt', 'dsh-tools'].every(name => existsSync(modulePath(name)))) { t.skip('Installed DSH APIs unavailable'); return; }
  const [{ Context }, { SystemPrompt }, { ToolRuntime }] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools'].map(name => import(pathToFileURL(modulePath(name)).href)));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rdsh-coding-integration-')));
  const workspace = join(root, 'workspace'); mkdirSync(workspace); mkdirSync(join(workspace, 'src')); mkdirSync(join(workspace, 'test'));
  writeFileSync(join(workspace, 'src/calc.mjs'), 'export const add = (a,b) => a-b;\n');
  const testText = 'import test from "node:test"; import assert from "node:assert/strict"; import {add} from "../src/calc.mjs"; test("sum",()=>assert.equal(add(2,3),5));\n';
  writeFileSync(join(workspace, 'test/public.test.mjs'), testText);
  const request = { version: 1, role: 'solver', workspace, prompt: 'Fix add', harness: {}, provider: 'fixture', model: 'fixture', timeoutMs: 10000, maxSteps: 8,
    coding: { editableFiles: ['src/calc.mjs'], testFiles: ['test/public.test.mjs'], testTimeoutMs: 3000 } };
  const requestPath = join(root, 'request.json'), telemetryPath = join(root, 'telemetry.json'); writeFileSync(requestPath, JSON.stringify(request));
  const ctx = new Context(); new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false }); const tools = new ToolRuntime(ctx, {});
  t.after(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }); });
  apply(ctx, { requestPath, telemetryPath });
  assert.deepEqual((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name).sort(), ['harness2_edit', 'harness2_read', 'harness2_test']);
  let id = 0;
  const call = async (name, args) => tools.execute({ name, arguments: args, callId: 'test-' + (++id), signal: new AbortController().signal });
  const decode = response => { assert.equal(response.isError, false); return JSON.parse(response.content[0].text); };
  const before = decode(await call('harness2_test', {})); assert.equal(before.exitCode, 1); assert.equal(before.failed, 1);
  decode(await call('harness2_edit', { path: 'src/calc.mjs', search: 'a-b', replace: 'a+b' }));
  const after = decode(await call('harness2_test', {})); assert.equal(after.exitCode, 0); assert.equal(after.passed, 1);
  assert.equal((await call('harness2_edit', { path: 'test/public.test.mjs', search: '5', replace: '0' })).isError, true);
  assert.equal(readFileSync(join(workspace, 'test/public.test.mjs'), 'utf8'), testText);
  assert.equal((await call('bash', {})).isError, true);
  const graded = await gradeCoding({ version: 1, workspace, testRoot: workspace, testFiles: ['test/public.test.mjs'], sourceFiles: ['src/calc.mjs'], timeoutMs: 3000 });
  assert.equal(graded.ok, true); assert.equal(graded.tests, 1); assert.equal(graded.sandbox, 'macos-sandbox-exec');
});
