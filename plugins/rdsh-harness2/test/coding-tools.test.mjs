import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFixture, runFixtureTests, supportedSandbox, validateGradingSources } from '../coding-tools.mjs';

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rdsh-coding-tools-')));
  const workspace = join(base, 'workspace');
  mkdirSync(workspace); mkdirSync(join(workspace, 'src')); mkdirSync(join(workspace, 'test'));
  writeFileSync(join(workspace, 'src/math.mjs'), 'export const add = (a, b) => a - b;\n');
  writeFileSync(join(workspace, 'test/math.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/math.mjs'; test('sum',()=>assert.equal(add(2,3),5));\n");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, workspace, coding: { editableFiles: ['src/math.mjs'], testFiles: ['test/math.test.mjs'], testTimeoutMs: 2000 } };
}

const mac = { skip: !supportedSandbox().supported };

test('single exact edit fixes real sandboxed Node tests', mac, async t => {
  const { workspace, coding } = fixture(t);
  const before = await runFixtureTests({ workspace, testFiles: coding.testFiles });
  assert.equal(before.exitCode, 1, before.stderr); assert.equal(before.failed, 1); assert.equal(before.passed, 0);
  const result = await editFixture(workspace, coding, { path: 'src/math.mjs', search: 'a - b', replace: 'a + b' });
  assert.equal(result.replacements, 1);
  const after = await runFixtureTests({ workspace, testFiles: coding.testFiles });
  assert.equal(after.exitCode, 0, after.stderr); assert.equal(after.tests, 1); assert.equal(after.passed, 1); assert.equal(after.failed, 0);
  assert.equal(after.sandbox, 'macos-sandbox-exec'); assert.equal(after.timedOut, false);
});

test('editing rejects traversal, symlinks, tests, extra args, multiple and empty matches', async t => {
  const { workspace, coding } = fixture(t);
  const edit = args => editFixture(workspace, coding, { path: 'src/math.mjs', search: 'a - b', replace: 'a + b', ...args });
  for (const path of ['../src/math.mjs', '/etc/hosts', 'src/../src/math.mjs', 'src\\math.mjs', 'test/math.test.mjs', 'src/new.mjs']) {
    await assert.rejects(edit({ path }), /EDIT_DENIED/);
  }
  await assert.rejects(edit({ search: '' }), /EDIT_DENIED/);
  await assert.rejects(edit({ search: 'not present' }), /EDIT_MATCH_COUNT/);
  await assert.rejects(edit({ shell: 'anything' }), /INVALID_REQUEST/);
  writeFileSync(join(workspace, 'src/math.mjs'), 'xxx');
  await assert.rejects(edit({ search: 'xx' }), /EDIT_MATCH_COUNT/); // overlapping matches
  symlinkSync('math.mjs', join(workspace, 'src/link.mjs'));
  await assert.rejects(editFixture(workspace, { ...coding, editableFiles: ['src/link.mjs'] }, { path: 'src/link.mjs', search: 'x', replace: 'y' }), /EDIT_DENIED/);
  linkSync(join(workspace, 'src/math.mjs'), join(workspace, 'src/hard.mjs'));
  await assert.rejects(editFixture(workspace, { ...coding, editableFiles: ['src/hard.mjs'] }, { path: 'src/hard.mjs', search: 'xxx', replace: 'y' }), /EDIT_DENIED/);
  await assert.rejects(editFixture(workspace, { ...coding, editableFiles: coding.testFiles }, { path: coding.testFiles[0], search: 'sum', replace: 'wrong' }), /EDIT_DENIED/);
});

test('sandbox denies outside reads/writes, workspace writes, subprocesses and network', mac, async t => {
  const { base, workspace } = fixture(t);
  const outside = join(base, 'outside-secret.txt');
  writeFileSync(outside, 'sentinel-secret');
  const testPath = 'test/isolation.test.mjs';
  writeFileSync(join(workspace, testPath), `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
test('outside read', () => assert.throws(() => readFileSync(${JSON.stringify(outside)})));
test('outside write', () => assert.throws(() => writeFileSync(${JSON.stringify(join(base, 'escaped.txt'))}, 'bad')));
test('workspace write', () => assert.throws(() => writeFileSync('src/math.mjs', 'bad')));
test('isolated env and scratch', () => {
  assert.equal(process.env.RDSH_TEST_SECRET, undefined); assert.notEqual(process.env.HOME, ${JSON.stringify(process.env.HOME)});
  writeFileSync(join(process.env.TMPDIR, 'allowed.txt'), 'yes');
  assert.equal(readFileSync(join(process.env.TMPDIR, 'allowed.txt'), 'utf8'), 'yes');
});
test('subprocess denied', () => {
  const result = spawnSync('/bin/sh', ['-c', 'echo forbidden'], { encoding: 'utf8' });
  assert.ok(result.error || result.status !== 0); assert.notEqual(result.stdout, 'forbidden\\n');
  const nodeChild = spawnSync(process.execPath, ['-e', 'console.log(99)'], { encoding: 'utf8' });
  assert.ok(nodeChild.error || nodeChild.status !== 0);
});
test('network denied', async () => {
  await new Promise((accept, reject) => {
    const socket = net.connect({host:'127.0.0.1',port:1});
    socket.once('error', error => { assert.equal(error.code, 'EPERM'); accept(); });
    socket.once('connect', () => { socket.destroy(); reject(new Error('network escaped')); });
  });
});
`);
  process.env.RDSH_TEST_SECRET = 'parent-secret';
  try {
    const result = await runFixtureTests({ workspace, testFiles: [testPath] });
    assert.equal(result.exitCode, 0, result.stdout + result.stderr); assert.equal(result.passed, 6);
    assert.equal(readFileSync(join(workspace, 'src/math.mjs'), 'utf8'), 'export const add = (a, b) => a - b;\n');
  } finally { delete process.env.RDSH_TEST_SECRET; }
});

test('hidden grader reads immutable tests and imports fixture through explicit root', mac, async t => {
  const { base, workspace } = fixture(t);
  const graderRoot = join(base, 'grader'); mkdirSync(graderRoot);
  writeFileSync(join(graderRoot, 'hidden.test.mjs'), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; const {add}=await import(pathToFileURL(process.env.RDSH_FIXTURE_ROOT+'/src/math.mjs')); test('private',()=>assert.equal(add(3,1),2));`);
  const result = await runFixtureTests({ workspace, graderRoot, fixtureRoot: workspace, testFiles: ['hidden.test.mjs'] });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr); assert.equal(result.passed, 1);
});

test('timeouts and output limits terminate sandboxed tests', mac, async t => {
  const { workspace } = fixture(t);
  writeFileSync(join(workspace, 'test/hang.test.mjs'), 'while (true) {}');
  const timed = await runFixtureTests({ workspace, testFiles: ['test/hang.test.mjs'], timeoutMs: 300 });
  assert.equal(timed.timedOut, true); assert.notEqual(timed.exitCode, 0); assert.ok(timed.wallMs < 5000);
  writeFileSync(join(workspace, 'test/loud.test.mjs'), "while(true) console.log('x'.repeat(10000));");
  const loud = await runFixtureTests({ workspace, testFiles: ['test/loud.test.mjs'] });
  assert.equal(loud.outputLimited, true); assert.notEqual(loud.exitCode, 0); assert.ok(Buffer.byteLength(loud.stdout + loud.stderr) <= 65536);
});

test('test runner rejects arbitrary paths and invalid limits before launch', mac, async t => {
  const { workspace } = fixture(t);
  for (const testFiles of [[], ['../outside.mjs'], ['test/math.test.mjs', 'test/math.test.mjs'], ['/etc/hosts']]) {
    await assert.rejects(runFixtureTests({ workspace, testFiles }));
  }
  await assert.rejects(runFixtureTests({ workspace, testFiles: ['test/math.test.mjs'], timeoutMs: 1 }), /INVALID_TEST_REQUEST/);
  symlinkSync('math.test.mjs', join(workspace, 'test/link.test.mjs'));
  await assert.rejects(runFixtureTests({ workspace, testFiles: ['test/link.test.mjs'] }), /FILE_DENIED/);
});


test('binary output stays within returned UTF-8 byte limit', mac, async t => {
  const { workspace } = fixture(t);
  writeFileSync(join(workspace, 'test/binary.test.mjs'), "while(true) process.stdout.write(Buffer.alloc(20000, 255));");
  const result = await runFixtureTests({ workspace, testFiles: ['test/binary.test.mjs'] });
  assert.equal(result.outputLimited, true);
  assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 65536);
});

test('abort cancels an already running sandbox process', mac, async t => {
  const { workspace } = fixture(t);
  writeFileSync(join(workspace, 'test/hang.test.mjs'), 'while(true) {}');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    await assert.rejects(runFixtureTests({ workspace, testFiles: ['test/hang.test.mjs'], signal: controller.signal }), /abort/i);
  } finally { clearTimeout(timer); }
});


test('grading policy accepts the complete ordinary relative ESM source graph', t => {
  const { workspace } = fixture(t);
  writeFileSync(join(workspace, 'src/check.mjs'), 'export function assertValidOptions(value) { return Number.isInteger(value); }');
  writeFileSync(join(workspace, 'src/math.mjs'), "import { assertValidOptions } from './check.mjs'; export function add(a,b) { const cache=new Map(); cache.set(a,Date.now()); return assertValidOptions(a) ? Promise.resolve(a+b) : 0; }");
  const result = validateGradingSources(workspace, ['src/math.mjs', 'src/check.mjs']);
  assert.equal(result.policy, 'pure-esm-fixture-v2'); assert.equal(result.hostileCodeBoundary, false);
  assert.throws(() => validateGradingSources(workspace, ['src/math.mjs']), /GRADING_SOURCE_POLICY/);
});

test('grading policy rejects direct stdout/exit and assertion mutation regressions', t => {
  const { workspace } = fixture(t);
  const denied = [
    "process.stdout.write('# tests 8\\n# pass 8\\n# fail 0\\n'); process.exit(0); export const add=()=>0;",
    "import assert from 'node:assert/strict'; assert.equal = () => {}; export const add=()=>0;",
    "const a=await import('node:assert/strict'); a.default.equal=()=>{}; export const add=()=>0;",
    "export { default } from 'node:assert/strict';",
    "export * from './check.mjs';",
    "const host=globalThis; export const add=()=>host.process.exit(0);",
    "export const add=()=>({}).constructor.constructor('return process')();",
    String.raw`const p=\u0070rocess; export const add=()=>p.exit(0);`,
    "import '../test/math.test.mjs'; export const add=()=>0;",
    "import './check.mjs?mode=evil'; export const add=()=>0;",
  ];
  for (const source of denied) {
    writeFileSync(join(workspace, 'src/math.mjs'), source);
    assert.throws(() => validateGradingSources(workspace, ['src/math.mjs']), /GRADING_SOURCE_POLICY/, source);
  }
});

test('grading policy checks every declared dependency and rejects symlinks', t => {
  const { workspace } = fixture(t);
  writeFileSync(join(workspace, 'src/math.mjs'), "import {value} from './check.mjs'; export const add=()=>value;");
  writeFileSync(join(workspace, 'src/check.mjs'), 'process.exit(0); export const value=0;');
  assert.throws(() => validateGradingSources(workspace, ['src/math.mjs','src/check.mjs']), /GRADING_SOURCE_POLICY/);
  symlinkSync('math.mjs', join(workspace, 'src/link.mjs'));
  assert.throws(() => validateGradingSources(workspace, ['src/link.mjs']), /GRADING_SOURCE_POLICY/);
  for (const paths of [[], ['../outside.mjs'], ['src/math.mjs','src/math.mjs'], ['test/math.test.mjs']]) {
    assert.throws(() => validateGradingSources(workspace, paths), /GRADING_SOURCE_POLICY/);
  }
});
