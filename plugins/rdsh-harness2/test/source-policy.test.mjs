import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateGradingSources } from '../source-policy.mjs';

function fixture(t, files = { 'src/main.mjs': 'export const value = 1;' }) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'rdsh-source-policy-')));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(workspace, path, '..'), { recursive: true });
    writeFileSync(join(workspace, path), source);
  }
  return workspace;
}
const denied = error => error?.code === 'GRADING_SOURCE_POLICY';

test('accepts regex and ordinary .test members plus inert capability words', t => {
  const workspace = fixture(t, { 'src/main.mjs': `
    // process test constructor node:test import('node:fs')
    export function check(value) { return /process|test|constructor/.test(value); }
    export const words = 'process test constructor assert import';
    export const obj = { process: 'plain key', test(value) { return value; } };
    export function another(value) { return obj.test(value); }
    export class Value { constructor(value) { this.value = value; } }
    export const template = \`process test constructor\`;
  ` });
  assert.deepEqual(validateGradingSources(workspace, ['src/main.mjs']), {
    policy: 'pure-esm-fixture-v2', checkedFiles: ['src/main.mjs'], hostileCodeBoundary: false,
  });
});
test('accepts local static imports and aliases while scanning entire graph', t => {
  const workspace = fixture(t, {
    'src/main.mjs': `import { helper as localHelper } from './helper.mjs'; export const result=localHelper(2);`,
    'src/helper.mjs': `export function helper(value) { return value+1; }`,
  });
  assert.equal(validateGradingSources(workspace, ['src/main.mjs', 'src/helper.mjs']).checkedFiles.length, 2);
  writeFileSync(join(workspace, 'src/helper.mjs'), 'export const secret = process.env;');
  assert.throws(() => validateGradingSources(workspace, ['src/main.mjs', 'src/helper.mjs']), denied);
});
test('accepts Object.prototype read checks but rejects direct shared-object mutation', t => {
  const workspace = fixture(t, { 'src/main.mjs': `
    export function ordinary(value) { return Object.getPrototypeOf(value) === Object.prototype; }
    export function owns(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
  ` });
  assert.equal(validateGradingSources(workspace, ['src/main.mjs']).policy, 'pure-esm-fixture-v2');
  for (const source of [
    'Object.prototype.value=1;', 'Object.prototype.value++;', 'delete Object.prototype.value;',
    'Object["prototype"]["value"]=1;', 'Object.prototype = {};',
    'Object.assign(Object.prototype,{value:1});', 'Object.defineProperty(Object.prototype,"value",{value:1});',
    'Object.defineProperties(Object.prototype,{value:{value:1}});', 'Object.setPrototypeOf(Object.prototype,null);',
    'Object.freeze(Object.prototype);', 'Object.prototype.hasOwnProperty.call = () => true;',
    'export const value = Object.prototype.constructor;',
  ]) {
    writeFileSync(join(workspace, 'src/main.mjs'), source);
    assert.throws(() => validateGradingSources(workspace, ['src/main.mjs']), denied, source);
  }
});
test('finds decoded unicode identifiers and template interpolations', t => {
  const workspace = fixture(t);
  for (const source of ['export const value = pro\\u0063ess.env;', 'export const value = `text ${process.env}`;', 'export const value = { process };']) {
    writeFileSync(join(workspace, 'src/main.mjs'), source);
    assert.throws(() => validateGradingSources(workspace, ['src/main.mjs']), denied);
  }
});
test('rejects direct capability references, test calls, and dangerous members', t => {
  const workspace = fixture(t);
  for (const source of [
    'process.exit(0);', 'globalThis.value=1;', 'eval("value");', 'new Function("return 1");',
    'Reflect.get({},"a");', 'console.log(1);', 'assert.equal(1,1);', 'test("fake",()=>{});',
    'describe("fake",()=>{});', 'export const f = value => value.constructor;',
    'export const f = value => value["protot\\u0079pe"];', 'export const f = value => value[`__proto__`];',
    'export const value = { __proto__: null };',
  ]) {
    writeFileSync(join(workspace, 'src/main.mjs'), source);
    assert.throws(() => validateGradingSources(workspace, ['src/main.mjs']), denied, source);
  }
  writeFileSync(join(workspace, 'src/main.mjs'), 'export function assertValid(value) { if (!value) throw new TypeError("invalid"); return value; }');
  assert.equal(validateGradingSources(workspace, ['src/main.mjs']).policy, 'pure-esm-fixture-v2');
});
test('rejects external and dynamic imports, metadata access, and reexports', t => {
  const workspace = fixture(t, { 'src/main.mjs': '', 'src/helper.mjs': 'export const value=1;' });
  for (const source of [
    "import test from 'node:test'; test('fake',()=>{});",
    "import assert from 'node:assert/strict'; assert.equal=()=>{};",
    "import 'arbitrary-package';", "export const value=import('./helper.mjs');",
    "export {value} from './helper.mjs';", "export * from './helper.mjs';",
    'export const value=import.meta.url;', "import './helper.mjs?other';",
    "import './missing.mjs';",
  ]) {
    writeFileSync(join(workspace, 'src/main.mjs'), source);
    assert.throws(() => validateGradingSources(workspace, ['src/main.mjs', 'src/helper.mjs']), denied, source);
  }
});
test('enforces file allowlist, file count, syntax, byte size, and NUL checks', t => {
  const workspace = fixture(t);
  for (const files of [[], ['../main.mjs'], ['src/.hidden.mjs'], ['src/main.mjs', 'src/main.mjs'], ['src/main.js'], Array(33).fill('src/main.mjs')]) {
    assert.throws(() => validateGradingSources(workspace, files), denied);
  }
  for (const source of ['export const =;', 'export const value="\0";', `//${'a'.repeat(65536)}`]) {
    writeFileSync(join(workspace, 'src/main.mjs'), source);
    assert.throws(() => validateGradingSources(workspace, ['src/main.mjs']), denied);
  }
});
test('rejects source symlinks, directory symlinks, hardlinks, and noncanonical roots', t => {
  const workspace = fixture(t);
  symlinkSync(join(workspace, 'src/main.mjs'), join(workspace, 'src/linked.mjs'));
  assert.throws(() => validateGradingSources(workspace, ['src/linked.mjs']), denied);
  symlinkSync(join(workspace, 'src'), join(workspace, 'alias'));
  assert.throws(() => validateGradingSources(workspace, ['alias/main.mjs']), denied);
  linkSync(join(workspace, 'src/main.mjs'), join(workspace, 'src/hard.mjs'));
  assert.throws(() => validateGradingSources(workspace, ['src/hard.mjs']), denied);
  assert.throws(() => validateGradingSources(workspace, ['src/main.mjs']), denied);
  assert.throws(() => validateGradingSources(workspace + '/.', ['src/main.mjs']), denied);
});
