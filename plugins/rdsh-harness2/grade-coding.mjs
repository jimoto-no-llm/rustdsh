#!/usr/bin/env node
import { existsSync, linkSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureTests, supportedSandbox, validateGradingSources } from './coding-tools.mjs';

// The evaluator is a host operation after adoption. Hidden assertions and their
// output are never passed to the agent or its improvement context.
export async function gradeCoding(value) {
  const keys = ['version', 'workspace', 'testRoot', 'testFiles', 'sourceFiles', 'timeoutMs'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k)) ||
      value.version !== 1 || !Array.isArray(value.testFiles) || value.testFiles.length < 1 || value.testFiles.length > 16 ||
      value.testFiles.some(p => typeof p !== 'string' || !p.split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part))) ||
      !Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 30000)
    throw new Error('INVALID_GRADER_REQUEST');
  for (const key of ['workspace', 'testRoot']) {
    const p = value[key];
    if (typeof p !== 'string' || !isAbsolute(p) || resolve(p) !== p || realpathSync(p) !== p || !lstatSync(p).isDirectory())
      throw new Error('INVALID_GRADER_PATH');
  }
  if (!supportedSandbox().supported) throw new Error('SANDBOX_UNAVAILABLE');
  const policy = validateGradingSources(value.workspace, value.sourceFiles);
  const result = await runFixtureTests({ workspace: value.workspace, graderRoot: value.testRoot,
    fixtureRoot: value.workspace, testFiles: value.testFiles, timeoutMs: value.timeoutMs });
  return { version: 1, ok: result.exitCode === 0 && result.tests > 0 && result.failed === 0 &&
      result.passed === result.tests && !result.timedOut && !result.outputLimited,
    exitCode: result.exitCode, tests: result.tests, passed: result.passed, failed: result.failed,
    sandbox: result.sandbox, sourcePolicy: policy.policy, hostileCodeBoundary: false,
    timedOut: result.timedOut, outputLimited: result.outputLimited, wallMs: result.wallMs };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 4 || args[0] !== '--request' || args[2] !== '--response' || !isAbsolute(args[1]) ||
      !isAbsolute(args[3]) || resolve(args[1]) === resolve(args[3]) || existsSync(args[3])) throw new Error('INVALID_ARGUMENTS');
  const input = readFileSync(args[1]);
  if (input.length > 65536) throw new Error('INVALID_GRADER_REQUEST');
  const response = await gradeCoding(JSON.parse(input));
  const temporary = `${args[3]}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(response) + '\n', { mode: 0o600, flag: 'wx' });
  try { linkSync(temporary, args[3]); } finally { unlinkSync(temporary); }
  return response.ok ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main(); }
  catch { process.stderr.write('rdsh-harness2: GRADER_FAILED\n'); process.exitCode = 1; }
}
