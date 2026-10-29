import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'acorn';
import { failure } from './validation.mjs';

const FILE_LIMIT = 65536;
const FORBIDDEN_REFERENCES = new Set([
  'process', 'globalThis', 'global', 'require', 'module', 'exports', 'console', 'Buffer',
  'Deno', 'Bun', 'eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'WebAssembly',
  'Reflect', 'fetch', 'XMLHttpRequest', 'Worker', 'SharedWorker', 'MessageChannel',
  'navigator', 'window', 'document', 'assert',
]);
const FORBIDDEN_MEMBERS = new Set(['constructor', 'prototype', '__proto__']);
const FORBIDDEN_CALLS = new Set(['test', 'assert', 'describe', 'it', 'before', 'after', 'beforeEach', 'afterEach']);

function reject() { throw failure('GRADING_SOURCE_POLICY'); }
function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 512 && !isAbsolute(path) &&
    !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part && part !== '..' && !part.startsWith('.'));
}
function canonicalDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path ||
      realpathSync(path) !== path || !lstatSync(path).isDirectory()) reject();
}
function regularFile(root, path) {
  if (!safeRelative(path)) reject();
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) reject();
  }
  const rel = relative(root, cursor);
  const stat = lstatSync(cursor);
  if (!rel || rel.startsWith(`..${sep}`) || realpathSync(cursor) !== cursor ||
      !stat.isFile() || stat.nlink !== 1 || stat.size > FILE_LIMIT) reject();
  return cursor;
}
function readSource(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > FILE_LIMIT) reject();
    const source = readFileSync(fd, 'utf8');
    if (source.includes('\0') || Buffer.byteLength(source) > FILE_LIMIT) reject();
    return source;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function staticProperty(node, computed) {
  if (!computed && node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}
function objectPrototype(node) {
  return node?.type === 'MemberExpression' && node.object.type === 'Identifier' &&
    node.object.name === 'Object' && staticProperty(node.property, node.computed) === 'prototype';
}
function rootedAtObjectPrototype(node) {
  if (objectPrototype(node)) return true;
  return node?.type === 'MemberExpression' && rootedAtObjectPrototype(node.object);
}
function identifierIsReference(parent, key) {
  if (!parent) return true;
  if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return false;
  if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent.type) && key === 'key' && !parent.computed) return false;
  if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(parent.type)) return false;
  if (parent.type === 'ExportSpecifier' && key === 'exported') return false;
  if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent.type) && key === 'label') return false;
  // Binding names are conservatively checked too: fixtures have no need to
  // shadow runtime capability names, which keeps direct checks auditable.
  return true;
}
function inspectAst(ast, path, allowed) {
  function visit(node, parent, key) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'ImportExpression' || node.type === 'ExportAllDeclaration' ||
        (node.type === 'ExportNamedDeclaration' && node.source) ||
        (node.type === 'MetaProperty' && node.meta.name === 'import')) reject();
    if (node.type === 'ImportDeclaration') {
      const specifier = node.source.value;
      if (typeof specifier !== 'string' || (!specifier.startsWith('./') && !specifier.startsWith('../')) ||
          specifier.includes('\\') || specifier.includes('?') || specifier.includes('#') ||
          !allowed.has(resolve(dirname(path), specifier))) reject();
      for (const binding of node.specifiers) if (FORBIDDEN_REFERENCES.has(binding.local.name)) reject();
    }
    if (node.type === 'Identifier' && identifierIsReference(parent, key) && FORBIDDEN_REFERENCES.has(node.name)) reject();
    if (node.type === 'MemberExpression' && FORBIDDEN_MEMBERS.has(staticProperty(node.property, node.computed)) &&
        !objectPrototype(node)) reject();
    // Read-only use of Object.prototype supports normal plain-object and own-key
    // checks. Obvious mutations of that shared object remain unsupported; this
    // deliberately does not claim to track aliases or arbitrary capability flow.
    if ((node.type === 'AssignmentExpression' && rootedAtObjectPrototype(node.left)) ||
        (node.type === 'UpdateExpression' && rootedAtObjectPrototype(node.argument)) ||
        (node.type === 'UnaryExpression' && node.operator === 'delete' && rootedAtObjectPrototype(node.argument))) reject();
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' && ['Object', 'Reflect'].includes(node.callee.object.name) &&
        ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf', 'freeze', 'seal', 'preventExtensions', 'deleteProperty', 'set'].includes(staticProperty(node.callee.property, node.callee.computed)) &&
        rootedAtObjectPrototype(node.arguments[0])) reject();
    if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(node.type) &&
        !(node.type === 'MethodDefinition' && node.kind === 'constructor') &&
        FORBIDDEN_MEMBERS.has(staticProperty(node.key, node.computed))) reject();
    if (['CallExpression', 'NewExpression'].includes(node.type) && node.callee.type === 'Identifier' &&
        FORBIDDEN_CALLS.has(node.callee.name)) reject();
    if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' &&
        FORBIDDEN_CALLS.has(node.tag.name)) reject();
    for (const [childKey, child] of Object.entries(node)) {
      if (Array.isArray(child)) { for (const item of child) visit(item, node, childKey); }
      else visit(child, node, childKey);
    }
  }
  visit(ast, null, null);
}

// Fixture-specific guard against direct capability and test/report tampering.
// AST parsing avoids treating comments, strings, or ordinary `.test` calls as
// executable capabilities. This is not a hostile-JavaScript security boundary:
// indirect computed access and same-realm mutation still need source review.
export function validateGradingSources(workspace, sourceFiles) {
  try {
    canonicalDirectory(workspace);
    if (!Array.isArray(sourceFiles) || sourceFiles.length < 1 || sourceFiles.length > 32 ||
        new Set(sourceFiles).size !== sourceFiles.length ||
        sourceFiles.some(path => !safeRelative(path) || !path.endsWith('.mjs'))) reject();
    const allowed = new Set(sourceFiles.map(path => regularFile(workspace, path)));
    for (const path of allowed) {
      const ast = parse(readSource(path), { ecmaVersion: 'latest', sourceType: 'module' });
      inspectAst(ast, path, allowed);
    }
    return { policy: 'pure-esm-fixture-v2', checkedFiles: [...sourceFiles], hostileCodeBoundary: false };
  } catch { throw failure('GRADING_SOURCE_POLICY'); }
}
