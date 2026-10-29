#!/usr/bin/env node
/**
 * Extract the upstream DSH locale dictionaries into a reviewable English snapshot.
 *
 * Stage 1 of #80: this tool inventories the upstream locale dictionaries shipped
 * by an installed @deepseek-ai runtime. It does not translate anything and it
 * only writes the English snapshot plus locale/upstream.json.
 *
 * The extractor parses every JavaScript file under each installed package's
 * lib/ directory with an existing JavaScript parser (acorn), resolves the
 * dictionaries handed to the locale service's register() calls, and follows
 * object spreads, string/template expressions and multi-namespace files. A
 * registration that cannot be resolved statically is an error: silently
 * omitting a namespace would make the snapshot look complete when it is not.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SNAPSHOT_DIR = path.join(REPO_ROOT, 'packages', 'dsh-locale-ja', 'locale');
const SNAPSHOT_SCHEMA = 1;
const SNAPSHOT_LOCALE = 'en';
const REQUIRED_LOCALES = ['en', 'zh'];
const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu;

/** @typedef {{ ok: true, value: unknown } | { ok: false, reason: string }} EvalResult */

class Scope {
	/** @param {Scope | null} parent */
	constructor(parent) {
		this.parent = parent;
		/** @type {Map<string, Binding>} */
		this.bindings = new Map();
	}

	/** @param {string} name @param {import('acorn').Node | null} init @param {import('acorn').Node} origin @param {string} kind */
	define(name, init, origin, kind = 'const') {
		this.bindings.set(name, { name, init, origin, kind, scope: this });
	}

	/** @param {string} name @returns {Binding | null} */
	resolve(name) {
		for (let scope = this; scope !== null; scope = scope.parent) {
			const binding = scope.bindings.get(name);
			if (binding !== undefined) return binding;
		}
		return null;
	}
}

function sha256(value) {
	return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function compareText(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
	if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
	if (value !== null && typeof value === 'object') {
		return '{' + Object.keys(value).sort(compareText).map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
	}
	return JSON.stringify(value);
}

function jsonText(value) {
	return JSON.stringify(value, null, 2) + '\n';
}

function isDirectory(value) {
	try {
		return fs.statSync(value).isDirectory();
	} catch {
		return false;
	}
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Load acorn without adding a dependency or touching the network. */
let acornPromise;
async function loadAcorn() {
	acornPromise ??= (async () => {
		const require = createRequire(import.meta.url);
		// The parser bundled with Node is version-matched to this runtime and
		// new enough for the syntax in the installed rc. An already-installed
		// project acorn is the next choice; the Debian system acorn can be older
		// than the rc's syntax, so it is only the last resort.
		const natives = process.binding?.('natives');
		const source = natives?.['internal/deps/acorn/acorn/dist/acorn'];
		if (typeof source === 'string') {
			const module = { exports: {} };
			const factory = vm.runInThisContext('(function (module, exports, require) {\n' + source + '\n})', {
				filename: 'node:internal/deps/acorn/acorn/dist/acorn',
			});
			factory(module, module.exports, () => {
				throw new Error('the bundled acorn parser unexpectedly required a module');
			});
			return module.exports;
		}
		try {
			const loaded = require('acorn');
			if (typeof loaded.parse === 'function') return loaded;
		} catch {
			// No project-local parser; continue with the system fallback.
		}
		try {
			const loaded = require('/usr/share/nodejs/acorn');
			if (typeof loaded.parse === 'function') return loaded;
		} catch {
			// Fall through to the error below.
		}
		throw new Error('no usable JavaScript parser found; install acorn or use a Node.js build with bundled acorn');
	})();
	return acornPromise;
}

/** @param {string} source @param {string} file @param {any} acorn */
function parseSource(source, file, acorn) {
	const options = { ecmaVersion: 'latest', allowHashBang: true, locations: true };
	try {
		return acorn.parse(source, { ...options, sourceType: 'script' });
	} catch (scriptError) {
		try {
			return acorn.parse(source, { ...options, sourceType: 'module' });
		} catch (moduleError) {
			throw new Error(file + ': could not parse as script (' + scriptError.message + ') or module (' + moduleError.message + ')');
		}
	}
}

/** @param {string} value @returns {Scope | null} */
function normalizeDshScope(value) {
	const absolute = path.resolve(value);
	if (isDirectory(absolute) && fs.existsSync(path.join(absolute, 'dsh', 'package.json'))) return absolute;
	const nested = path.join(absolute, 'node_modules', '@deepseek-ai');
	if (isDirectory(nested) && fs.existsSync(path.join(nested, 'dsh', 'package.json'))) return nested;
	if (path.basename(absolute) === 'dsh' && fs.existsSync(path.join(absolute, 'package.json'))) {
		const parent = path.dirname(absolute);
		if (fs.existsSync(path.join(parent, 'dsh', 'package.json'))) return parent;
	}
	return null;
}

/** @param {string | null} requested */
function resolveDshScope(requested) {
	if (requested !== null) {
		const scope = normalizeDshScope(requested);
		if (scope === null) {
			throw new Error('--dsh-root ' + requested + ' is not a DSH runtime root, an @deepseek-ai scope directory, or the @deepseek-ai/dsh package');
		}
		return scope;
	}
	const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
	for (const candidate of [
		path.join(home, 'runtime'),
		path.join(home, 'runtime', 'node_modules', '@deepseek-ai'),
		path.join(home, 'node_modules', '@deepseek-ai'),
	]) {
		const scope = normalizeDshScope(candidate);
		if (scope !== null) return scope;
	}
	throw new Error('could not find an installed @deepseek-ai runtime; pass --dsh-root <path>');
}

/** @param {string} scopeDir */
function listPackages(scopeDir) {
	const packages = [];
	for (const entry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const dir = path.join(scopeDir, entry.name);
		const manifestFile = path.join(dir, 'package.json');
		if (!fs.existsSync(manifestFile)) continue;
		const manifest = readJson(manifestFile);
		packages.push({
			name: typeof manifest.name === 'string' ? manifest.name : entry.name,
			version: typeof manifest.version === 'string' ? manifest.version : null,
			dir,
			manifest,
		});
	}
	packages.sort((left, right) => compareText(left.name, right.name));
	return packages;
}

/** @param {string} dir */
function listJavaScriptFiles(dir) {
	const files = [];
	const walk = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			const file = path.join(current, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (/\.(?:c|m)?js$/u.test(entry.name)) files.push(file);
		}
	};
	if (isDirectory(dir)) walk(dir);
	return files.sort(compareText);
}

function unwrapExport(statement) {
	if (statement.type === 'ExportNamedDeclaration' && statement.declaration !== null) return statement.declaration;
	if (statement.type === 'ExportDefaultDeclaration' && statement.declaration !== null) return statement.declaration;
	return statement;
}

function memberName(node) {
	if (node === null || node === undefined || node.computed) return null;
	if (node.type === 'Identifier') return node.name;
	if (node.type === 'Literal') return String(node.value);
	return null;
}

function isProperty(property) {
	return property.type === 'Property' && property.kind === 'init' && property.method !== true;
}

function evalPropertyKey(property, scope) {
	if (!property.computed) {
		if (property.key.type === 'Identifier') return { ok: true, value: property.key.name };
		if (property.key.type === 'Literal') return { ok: true, value: String(property.key.value) };
		return { ok: false, reason: 'unsupported static property key ' + property.key.type };
	}
	return evalString(property.key, scope);
}

function isObjectFreeze(call) {
	const callee = call.callee;
	return callee.type === 'MemberExpression' && !callee.computed
		&& callee.object.type === 'Identifier' && callee.object.name === 'Object'
		&& (callee.property.type === 'Identifier' && ['freeze', 'seal'].includes(callee.property.name));
}

/**
 * Resolve a primitive value expression to a string/number/boolean/null.
 * @param {import('acorn').Node | null} node
 * @param {Scope} scope
 * @param {Set<Binding>} [seen]
 * @returns {EvalResult}
 */
function evalPrimitive(node, scope, seen = new Set()) {
	if (node === null || node === undefined) return { ok: false, reason: 'missing expression' };
	switch (node.type) {
		case 'Literal':
			if (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value)) return { ok: true, value: node.value };
			return { ok: false, reason: 'unsupported literal ' + typeof node.value };
		case 'Identifier': {
			const binding = scope.resolve(node.name);
			if (binding === null) return { ok: false, reason: 'unknown binding "' + node.name + '"' };
			if (binding.kind === 'param') return { ok: false, reason: 'runtime-only binding "' + node.name + '"' };
			if (binding.kind === 'function' || binding.kind === 'class') return { ok: false, reason: '"' + node.name + '" is not a value expression' };
			if (binding.init === null) return { ok: false, reason: '"' + node.name + '" has no static initializer' };
			if (seen.has(binding)) return { ok: false, reason: 'cyclic value through "' + node.name + '"' };
			seen.add(binding);
			const result = evalPrimitive(binding.init, binding.scope, seen);
			seen.delete(binding);
			return result;
		}
		case 'TemplateLiteral': {
			let result = '';
			for (let index = 0; index < node.quasis.length; index += 1) {
				result += node.quasis[index].value.cooked ?? node.quasis[index].value.raw;
				const expression = node.expressions[index];
				if (expression === undefined) continue;
				const value = evalPrimitive(expression, scope, seen);
				if (!value.ok) return value;
				if (value.value === null) return { ok: false, reason: 'null template interpolation' };
				result += String(value.value);
			}
			return { ok: true, value: result };
		}
		case 'BinaryExpression': {
			if (node.operator !== '+') return { ok: false, reason: 'unsupported binary operator ' + node.operator };
			const left = evalPrimitive(node.left, scope, seen);
			if (!left.ok) return left;
			const right = evalPrimitive(node.right, scope, seen);
			if (!right.ok) return right;
			return { ok: true, value: left.value + right.value };
		}
		case 'ConditionalExpression': {
			const test = evalPrimitive(node.test, scope, seen);
			if (!test.ok) return test;
			return evalPrimitive(test.value ? node.consequent : node.alternate, scope, seen);
		}
		case 'LogicalExpression': {
			const left = evalPrimitive(node.left, scope, seen);
			if (!left.ok) return left;
			if (node.operator === '??') return left.value === null || left.value === undefined ? evalPrimitive(node.right, scope, seen) : left;
			if (node.operator === '||') return left.value ? left : evalPrimitive(node.right, scope, seen);
			if (node.operator === '&&') return left.value ? evalPrimitive(node.right, scope, seen) : left;
			return { ok: false, reason: 'unsupported logical operator ' + node.operator };
		}
		case 'CallExpression': {
			const callee = node.callee;
			if (isObjectFreeze(node) && node.arguments.length === 1) return evalPrimitive(node.arguments[0], scope, seen);
			if (callee.type === 'Identifier' && callee.name === 'String' && node.arguments.length <= 1) {
				if (node.arguments.length === 0) return { ok: true, value: '' };
				const argument = evalPrimitive(node.arguments[0], scope, seen);
				return argument.ok ? { ok: true, value: String(argument.value) } : argument;
			}
			if (callee.type !== 'MemberExpression' || callee.computed) return { ok: false, reason: 'unsupported call value' };
			const method = memberName(callee.property);
			if (method === 'join' && callee.object.type === 'ArrayExpression') {
				const separator = node.arguments.length === 0 ? ',' : evalString(node.arguments[0], scope, seen);
				if (!separator.ok) return separator;
				const parts = [];
				for (const element of callee.object.elements) {
					if (element === null) return { ok: false, reason: 'array hole in join()' };
					if (element.type === 'SpreadElement') return { ok: false, reason: 'spread in join() array' };
					const value = evalString(element, scope, seen);
					if (!value.ok) return value;
					parts.push(value.value);
				}
				return { ok: true, value: parts.join(separator.value) };
			}
			const receiver = evalString(callee.object, scope, seen);
			if (!receiver.ok) return receiver;
			if (method === 'trim' || method === 'trimStart' || method === 'trimEnd') return { ok: true, value: receiver.value[method]() };
			if (method === 'concat') {
				let result = receiver.value;
				for (const argument of node.arguments) {
					const value = evalPrimitive(argument, scope, seen);
					if (!value.ok) return value;
					result += String(value.value);
				}
				return { ok: true, value: result };
			}
			return { ok: false, reason: 'unsupported call method ' + String(method) };
		}
		case 'ParenthesizedExpression':
			return evalPrimitive(node.expression, scope, seen);
		default:
			return { ok: false, reason: 'unsupported value expression ' + node.type };
	}
}

/**
 * Resolve a dictionary value. Locale dictionaries are flat string maps.
 * @param {import('acorn').Node | null} node
 * @param {Scope} scope
 * @param {Set<Binding>} [seen]
 * @returns {EvalResult}
 */
function evalString(node, scope, seen = new Set()) {
	const result = evalPrimitive(node, scope, seen);
	if (!result.ok) return result;
	if (typeof result.value !== 'string') return { ok: false, reason: 'expected a string, found ' + (result.value === null ? 'null' : typeof result.value) };
	return result;
}

/**
 * Resolve an object literal into a flat string dictionary, following spreads.
 * @param {import('acorn').Node | null} node
 * @param {Scope} scope
 * @param {Set<Binding>} [seen]
 * @returns {EvalResult & { value?: Record<string, string> }}
 */
function evalDictionary(node, scope, seen = new Set()) {
	if (node === null || node === undefined) return { ok: false, reason: 'missing dictionary expression' };
	if (node.type === 'ParenthesizedExpression') return evalDictionary(node.expression, scope, seen);
	if (node.type === 'Identifier') {
		const binding = scope.resolve(node.name);
		if (binding === null) return { ok: false, reason: 'unknown dictionary binding "' + node.name + '"' };
		if (binding.init === null) return { ok: false, reason: 'dictionary binding "' + node.name + '" has no static initializer' };
		if (seen.has(binding)) return { ok: false, reason: 'cyclic dictionary through "' + node.name + '"' };
		seen.add(binding);
		const result = evalDictionary(binding.init, binding.scope, seen);
		seen.delete(binding);
		return result;
	}
	if (node.type === 'CallExpression' && isObjectFreeze(node) && node.arguments.length === 1) {
		return evalDictionary(node.arguments[0], scope, seen);
	}
	if (node.type !== 'ObjectExpression') return { ok: false, reason: 'unsupported dictionary expression ' + node.type };
	const entries = new Map();
	for (const property of node.properties) {
		if (property.type === 'SpreadElement') {
			const spread = evalDictionary(property.argument, scope, seen);
			if (!spread.ok) return { ok: false, reason: 'spread: ' + spread.reason };
			for (const [key, value] of Object.entries(spread.value)) entries.set(key, value);
			continue;
		}
		if (!isProperty(property)) return { ok: false, reason: 'unsupported dictionary property ' + property.type };
		const key = evalPropertyKey(property, scope);
		if (!key.ok) return { ok: false, reason: 'key: ' + key.reason };
		const value = evalString(property.value, scope, seen);
		if (!value.ok) return { ok: false, reason: 'key "' + key.value + '": ' + value.reason };
		entries.set(key.value, value.value);
	}
	return { ok: true, value: Object.fromEntries(entries) };
}

/**
 * Resolve a locale bundle object: { en: {...}, zh: {...} }.
 * @param {import('acorn').Node | null} node
 * @param {Scope} scope
 * @param {Set<Binding>} [seen]
 * @returns {EvalResult & { value?: Record<string, Record<string, string>> }}
 */
function evalLocaleBundle(node, scope, seen = new Set()) {
	if (node === null || node === undefined) return { ok: false, reason: 'missing locale bundle' };
	if (node.type === 'ParenthesizedExpression') return evalLocaleBundle(node.expression, scope, seen);
	if (node.type === 'Identifier') {
		const binding = scope.resolve(node.name);
		if (binding === null) return { ok: false, reason: 'unknown locale bundle "' + node.name + '"' };
		if (binding.init === null) return { ok: false, reason: 'locale bundle "' + node.name + '" has no static initializer' };
		if (seen.has(binding)) return { ok: false, reason: 'cyclic locale bundle through "' + node.name + '"' };
		seen.add(binding);
		const result = evalLocaleBundle(binding.init, binding.scope, seen);
		seen.delete(binding);
		return result;
	}
	if (node.type === 'CallExpression' && isObjectFreeze(node) && node.arguments.length === 1) {
		return evalLocaleBundle(node.arguments[0], scope, seen);
	}
	if (node.type !== 'ObjectExpression') return { ok: false, reason: 'unsupported locale bundle ' + node.type };
	const locales = new Map();
	for (const property of node.properties) {
		if (property.type === 'SpreadElement') {
			const spread = evalLocaleBundle(property.argument, scope, seen);
			if (!spread.ok) return { ok: false, reason: 'locale bundle spread: ' + spread.reason };
			for (const [locale, dictionary] of Object.entries(spread.value)) locales.set(locale, dictionary);
			continue;
		}
		if (!isProperty(property)) return { ok: false, reason: 'unsupported locale bundle property ' + property.type };
		const locale = evalPropertyKey(property, scope);
		if (!locale.ok) return { ok: false, reason: 'locale key: ' + locale.reason };
		const dictionary = evalDictionary(property.value, scope, seen);
		if (!dictionary.ok) return { ok: false, reason: 'locale "' + locale.value + '": ' + dictionary.reason };
		locales.set(locale.value, dictionary.value);
	}
	return { ok: true, value: Object.fromEntries(locales) };
}

/**
 * Resolve an array literal to its element expressions, following spreads.
 * Elements are returned as AST nodes so callers can bind loop variables.
 * @param {import('acorn').Node | null} node
 * @param {Scope} scope
 * @param {Set<Binding>} [seen]
 * @returns {EvalResult & { value?: import('acorn').Node[] }}
 */
function evalArrayElements(node, scope, seen = new Set()) {
	if (node === null || node === undefined) return { ok: false, reason: 'missing array expression' };
	if (node.type === 'Identifier') {
		const binding = scope.resolve(node.name);
		if (binding === null) return { ok: false, reason: 'unknown array binding "' + node.name + '"' };
		if (binding.init === null) return { ok: false, reason: 'array binding "' + node.name + '" has no static initializer' };
		if (seen.has(binding)) return { ok: false, reason: 'cyclic array through "' + node.name + '"' };
		seen.add(binding);
		const result = evalArrayElements(binding.init, binding.scope, seen);
		seen.delete(binding);
		return result;
	}
	if (node.type === 'CallExpression' && isObjectFreeze(node) && node.arguments.length === 1) {
		return evalArrayElements(node.arguments[0], scope, seen);
	}
	if (node.type !== 'ArrayExpression') return { ok: false, reason: 'unsupported array expression ' + node.type };
	const elements = [];
	for (const element of node.elements) {
		if (element === null) return { ok: false, reason: 'array hole' };
		if (element.type === 'SpreadElement') {
			const spread = evalArrayElements(element.argument, scope, seen);
			if (!spread.ok) return spread;
			elements.push(...spread.value);
		} else {
			elements.push(element);
		}
	}
	return { ok: true, value: elements };
}

function bindPatternNames(pattern, scope, kind) {
	if (pattern === null || pattern === undefined) return;
	if (pattern.type === 'VariableDeclaration') {
		for (const declarator of pattern.declarations) bindPatternNames(declarator.id, scope, kind);
		return;
	}
	if (pattern.type === 'Identifier') {
		scope.define(pattern.name, null, pattern, kind);
		return;
	}
	if (pattern.type === 'AssignmentPattern') {
		bindPatternNames(pattern.left, scope, kind);
		return;
	}
	if (pattern.type === 'RestElement') {
		bindPatternNames(pattern.argument, scope, kind);
		return;
	}
	if (pattern.type === 'ArrayPattern') {
		for (const element of pattern.elements) bindPatternNames(element, scope, kind);
		return;
	}
	if (pattern.type === 'ObjectPattern') {
		for (const property of pattern.properties) {
			if (property.type === 'RestElement') bindPatternNames(property.argument, scope, kind);
			else bindPatternNames(property.value, scope, kind);
		}
	}
}

function predeclare(statements, scope) {
	for (const raw of statements) {
		const statement = unwrapExport(raw);
		if (statement.type === 'VariableDeclaration') {
			for (const declarator of statement.declarations) {
				if (declarator.id.type === 'Identifier') scope.define(declarator.id.name, declarator.init, declarator, statement.kind);
				else bindPatternNames(declarator.id, scope, 'destructure');
			}
		} else if (statement.type === 'FunctionDeclaration' && statement.id !== null) {
			scope.define(statement.id.name, statement, statement, 'function');
		} else if (statement.type === 'ClassDeclaration' && statement.id !== null) {
			scope.define(statement.id.name, statement, statement, 'class');
		}
	}
}

function visit(node, scope, state) {
	if (node === null || node === undefined) return;
	switch (node.type) {
		case 'Program': {
			predeclare(node.body, scope);
			for (const statement of node.body) visit(statement, scope, state);
			return;
		}
		case 'BlockStatement': {
			const block = new Scope(scope);
			predeclare(node.body, block);
			for (const statement of node.body) visit(statement, block, state);
			return;
		}
		case 'FunctionDeclaration':
		case 'FunctionExpression':
		case 'ArrowFunctionExpression': {
			const functionScope = new Scope(scope);
			if (node.type === 'FunctionExpression' && node.id !== null) functionScope.define(node.id.name, node, node, 'function');
			for (const parameter of node.params) bindPatternNames(parameter, functionScope, 'param');
			if (node.body.type === 'BlockStatement') visit(node.body, functionScope, state);
			else visit(node.body, functionScope, state);
			return;
		}
		case 'VariableDeclaration': {
			for (const declarator of node.declarations) {
				if (declarator.id.type === 'Identifier' && !scope.bindings.has(declarator.id.name)) {
					scope.define(declarator.id.name, declarator.init, declarator, node.kind);
				}
				visit(declarator.init, scope, state);
			}
			return;
		}
		case 'ForOfStatement': {
			visit(node.right, scope, state);
			const elements = evalArrayElements(node.right, scope);
			if (!elements.ok) {
				const loopScope = new Scope(scope);
				bindPatternNames(node.left, loopScope, 'loop');
				visit(node.body, loopScope, state);
				return;
			}
			for (const element of elements.value) {
				const loopScope = new Scope(scope);
				bindLoopPattern(node.left, element, loopScope);
				visit(node.body, loopScope, state);
			}
			return;
		}
		case 'CallExpression': {
			maybeRegister(node, scope, state);
			visit(node.callee, scope, state);
			for (const argument of node.arguments) visit(argument, scope, state);
			return;
		}
		default: {
			for (const key of Object.keys(node)) {
				if (['type', 'start', 'end', 'loc', 'range'].includes(key)) continue;
				const child = node[key];
				if (Array.isArray(child)) {
					for (const item of child) if (item !== null && typeof item.type === 'string') visit(item, scope, state);
				} else if (child !== null && typeof child === 'object' && typeof child.type === 'string') {
					visit(child, scope, state);
				}
			}
		}
	}
}

function bindLoopPattern(pattern, element, scope) {
	if (pattern.type === 'VariableDeclaration') {
		for (const declarator of pattern.declarations) bindLoopPattern(declarator.id, element, scope);
		return;
	}
	if (pattern.type === 'Identifier') {
		scope.define(pattern.name, element, pattern, 'loop');
		return;
	}
	if (pattern.type === 'ArrayPattern') {
		const tuple = evalArrayElements(element, scope);
		if (!tuple.ok) {
			bindPatternNames(pattern, scope, 'loop');
			return;
		}
		for (let index = 0; index < pattern.elements.length; index += 1) {
			const entry = pattern.elements[index];
			if (entry === null) continue;
			const value = tuple.value[index];
			if (value === undefined) bindPatternNames(entry, scope, 'loop');
			else bindLoopPattern(entry, value, scope);
		}
		return;
	}
	bindPatternNames(pattern, scope, 'loop');
}

function maybeRegister(call, scope, state) {
	const callee = call.callee;
	if (callee.type !== 'MemberExpression' || callee.computed || memberName(callee.property) !== 'register') return;
	const receiver = callee.object;
	const isLocale = (receiver.type === 'Identifier' && receiver.name === 'locale')
		|| (receiver.type === 'MemberExpression' && !receiver.computed && memberName(receiver.property) === 'locale');
	if (!isLocale) return;
	const location = state.file + ':' + call.loc.start.line;
	const args = call.arguments;
	if (args.length === 2) {
		const namespace = evalString(args[0], scope);
		if (!namespace.ok) {
			state.errors.push(location + ': cannot resolve locale namespace: ' + namespace.reason);
			return;
		}
		const bundle = evalLocaleBundle(args[1], scope);
		if (!bundle.ok) {
			state.errors.push(location + ': cannot resolve dictionaries for namespace "' + namespace.value + '": ' + bundle.reason);
			return;
		}
		state.add(namespace.value, bundle.value, call);
		return;
	}
	if (args.length === 3) {
		const namespace = evalString(args[0], scope);
		if (!namespace.ok) {
			state.errors.push(location + ': cannot resolve locale namespace: ' + namespace.reason);
			return;
		}
		const locale = evalString(args[1], scope);
		if (!locale.ok) {
			state.errors.push(location + ': cannot resolve locale id for namespace "' + namespace.value + '": ' + locale.reason);
			return;
		}
		const dictionary = evalDictionary(args[2], scope);
		if (!dictionary.ok) {
			state.errors.push(location + ': cannot resolve dictionary "' + locale.value + '" for namespace "' + namespace.value + '": ' + dictionary.reason);
			return;
		}
		state.add(namespace.value, { [locale.value]: dictionary.value }, call);
		return;
	}
	state.errors.push(location + ': locale register() must take (namespace, bundle) or (namespace, locale, dictionary), found ' + args.length + ' arguments');
}

/**
 * Extract one installed package scope.
 * @param {{ scopeDir: string, dshRoot?: string | null }} options
 */
async function extractScope(options) {
	const acorn = await loadAcorn();
	const scopeDir = options.scopeDir;
	const packages = listPackages(scopeDir);
	/** @type {Map<string, NamespaceRecord>} */
	const namespaces = new Map();
	const errors = [];
	const warnings = [];

	for (const pkg of packages) {
		for (const file of listJavaScriptFiles(path.join(pkg.dir, 'lib'))) {
			const source = fs.readFileSync(file, 'utf8');
			let ast;
			try {
				ast = parseSource(source, file, acorn);
			} catch (error) {
				// A file that mentions locale.register but cannot be parsed must not
				// be skipped: that could hide a namespace from the snapshot.
				if (source.includes('.locale.register') || source.includes('locale.register')) {
					errors.push(file + ': parse failed and the file mentions locale.register: ' + error.message);
				} else {
					warnings.push(error.message);
				}
				continue;
			}
			const relative = path.relative(pkg.dir, file).split(path.sep).join('/');
			const sourceHash = sha256(source);
			const state = {
				file,
				errors,
				add(namespace, dictionaries, call) {
					let record = namespaces.get(namespace);
					if (record === undefined) {
						record = { namespace, owners: new Set(), versions: new Map(), sources: new Map(), dictionaries: new Map() };
						namespaces.set(namespace, record);
					}
					record.owners.add(pkg.name);
					record.versions.set(pkg.name, pkg.version);
					const sourceKey = pkg.name + '/' + relative + ':' + call.loc.start.line;
					record.sources.set(sourceKey, { package: pkg.name, packageVersion: pkg.version, file: relative, line: call.loc.start.line, sha256: sourceHash });
					for (const [locale, dictionary] of Object.entries(dictionaries)) {
						let current = record.dictionaries.get(locale);
						if (current === undefined) {
							current = new Map();
							record.dictionaries.set(locale, current);
						}
						for (const [key, value] of Object.entries(dictionary)) {
							const previous = current.get(key);
							if (previous !== undefined && previous !== value) {
								errors.push(pkg.name + '/' + relative + ':' + call.loc.start.line + ': namespace "' + namespace + '" locale "' + locale + '" key "' + key + '" is registered twice with different values');
							}
							current.set(key, value);
						}
					}
				},
			};
			const root = new Scope(null);
			visit(ast, root, state);
		}
	}

	if (errors.length > 0) {
		throw new Error('upstream locale extraction failed:\n' + errors.map((error) => '  - ' + error).join('\n'));
	}

	const namespaceEntries = [...namespaces.values()]
		.sort((left, right) => compareText(left.namespace, right.namespace))
		.map((record) => {
			const owners = [...record.owners].sort(compareText);
			const sources = [...record.sources.values()].sort((left, right) => compareText(left.package + '/' + left.file + ':' + left.line, right.package + '/' + right.file + ':' + right.line));
			const locales = [...record.dictionaries.keys()].sort(compareText);
			const dictionaries = {};
			for (const locale of locales) {
				const dictionary = record.dictionaries.get(locale);
				dictionaries[locale] = Object.fromEntries([...dictionary.entries()].sort((left, right) => compareText(left[0], right[0])));
			}
			const keyCounts = {};
			const dictionaryHashes = {};
			for (const locale of locales) {
				keyCounts[locale] = Object.keys(dictionaries[locale]).length;
				dictionaryHashes[locale] = sha256(canonicalJson(dictionaries[locale]) + '\n');
			}
			const sourceHash = sha256(
				[...new Set(sources.map((source) => source.package + '/' + source.file + ':' + source.sha256))].sort(compareText).join('\n') + '\n',
			);
			const fileName = namespaceFileName(record.namespace);
			return {
				namespace: record.namespace,
				fileName,
				owners,
				sources,
				sourceHash,
				locales,
				keyCounts,
				dictionaryHashes,
				dictionaries,
			};
		});

	const byName = new Map(namespaceEntries.map((entry) => [entry.namespace, entry]));
	for (const locale of REQUIRED_LOCALES) {
		const missing = namespaceEntries.filter((entry) => entry.keyCounts[locale] === undefined).map((entry) => entry.namespace);
		if (missing.length > 0) throw new Error('upstream locale extraction is incomplete: namespaces without an ' + locale + ' dictionary: ' + missing.join(', '));
	}
	const fileNames = new Set();
	for (const entry of namespaceEntries) {
		if (fileNames.has(entry.fileName)) throw new Error('namespace file name collision: ' + entry.fileName);
		fileNames.add(entry.fileName);
	}

	const dshManifestFile = path.join(scopeDir, 'dsh', 'package.json');
	const dshManifest = fs.existsSync(dshManifestFile) ? readJson(dshManifestFile) : null;
	const totals = {
		namespaces: namespaceEntries.length,
		keys: namespaceEntries.reduce((sum, entry) => sum + entry.keyCounts.en, 0),
		locales: Object.fromEntries(REQUIRED_LOCALES.map((locale) => [locale, namespaceEntries.reduce((sum, entry) => sum + entry.keyCounts[locale], 0)])),
	};
	const upstream = {
		schemaVersion: SNAPSHOT_SCHEMA,
		snapshotLocale: SNAPSHOT_LOCALE,
		dsh: {
			name: dshManifest?.name ?? '@deepseek-ai/dsh',
			version: dshManifest?.version ?? null,
		},
		totals,
		namespaces: Object.fromEntries(namespaceEntries.map((entry) => [entry.namespace, {
			fileName: entry.fileName,
			owners: entry.owners,
			sources: entry.sources,
			sourceHash: entry.sourceHash,
			locales: entry.locales,
			keyCounts: entry.keyCounts,
			dictionaryHashes: entry.dictionaryHashes,
		}])),
	};

	return {
		upstream,
		namespaceEntries,
		dictionaries: Object.fromEntries(namespaceEntries.map((entry) => [entry.namespace, entry.dictionaries])),
		warnings,
	};
}

function namespaceFileName(namespace) {
	if (/^[A-Za-z0-9._-]+$/u.test(namespace) && namespace !== '.' && namespace !== '..') return namespace + '.json';
	return encodeURIComponent(namespace) + '.json';
}

/** @param {{ dshRoot?: string | null }} [options] */
export async function buildSnapshot(options = {}) {
	const scopeDir = resolveDshScope(options.dshRoot ?? null);
	return extractScope({ scopeDir });
}

/** @param {{ upstream: any, namespaceEntries: any[] }} snapshot @param {string} outDir */
export function writeSnapshot(snapshot, outDir = DEFAULT_SNAPSHOT_DIR) {
	const englishDir = path.join(outDir, 'namespaces', 'en');
	fs.mkdirSync(englishDir, { recursive: true });
	for (const entry of snapshot.namespaceEntries) {
		fs.writeFileSync(path.join(englishDir, entry.fileName), jsonText(entry.dictionaries.en));
	}
	fs.writeFileSync(path.join(outDir, 'upstream.json'), jsonText(snapshot.upstream));
}

/** @param {{ upstream: any, namespaceEntries: any[] }} snapshot @param {string} outDir */
export function checkSnapshot(snapshot, outDir = DEFAULT_SNAPSHOT_DIR) {
	const problems = [];
	const englishDir = path.join(outDir, 'namespaces', 'en');
	for (const entry of snapshot.namespaceEntries) {
		const file = path.join(englishDir, entry.fileName);
		const expected = jsonText(entry.dictionaries.en);
		if (!fs.existsSync(file)) {
			problems.push('missing ' + path.relative(outDir, file));
			continue;
		}
		const actual = fs.readFileSync(file, 'utf8');
		if (actual !== expected) problems.push('different ' + path.relative(outDir, file));
	}
	const upstreamFile = path.join(outDir, 'upstream.json');
	const expectedUpstream = jsonText(snapshot.upstream);
	if (!fs.existsSync(upstreamFile)) {
		problems.push('missing upstream.json');
	} else if (fs.readFileSync(upstreamFile, 'utf8') !== expectedUpstream) {
		problems.push('different upstream.json');
	}
	if (fs.existsSync(englishDir)) {
		const expectedFiles = new Set(snapshot.namespaceEntries.map((entry) => entry.fileName));
		for (const file of fs.readdirSync(englishDir)) {
			if (file.endsWith('.json') && !expectedFiles.has(file)) problems.push('stale ' + path.relative(outDir, path.join(englishDir, file)));
		}
	}
	return problems;
}

function parseArguments(argv) {
	const options = { check: false, dshRoot: null, outDir: DEFAULT_SNAPSHOT_DIR, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--check') options.check = true;
		else if (argument === '--dsh-root') {
			const value = argv[index + 1];
			if (value === undefined) throw new Error('--dsh-root requires a path');
			options.dshRoot = value;
			index += 1;
		} else if (argument === '--out') {
			const value = argv[index + 1];
			if (value === undefined) throw new Error('--out requires a path');
			options.outDir = path.resolve(value);
			index += 1;
		} else if (argument === '--help' || argument === '-h') options.help = true;
		else throw new Error('unknown argument "' + argument + '"; see --help');
	}
	return options;
}

function printHelp() {
	console.log([
		'Usage: node tools/extract-upstream.mjs [options]',
		'',
		'Options:',
		'  --dsh-root <path>  DSH runtime root, @deepseek-ai scope, or @deepseek-ai/dsh package.',
		'                     Defaults to $DSH_HOME/runtime or ~/.dsh/runtime.',
		'  --out <path>       Snapshot directory (default: packages/dsh-locale-ja/locale).',
		'  --check            Compare the installed upstream sources with the committed snapshot.',
		'  --help             Show this help.',
	].join('\n'));
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const options = parseArguments(process.argv.slice(2));
		if (options.help) {
			printHelp();
		} else {
			const snapshot = await buildSnapshot({ dshRoot: options.dshRoot });
			for (const warning of snapshot.warnings) console.warn('warning: ' + warning);
			if (options.check) {
				const problems = checkSnapshot(snapshot, options.outDir);
				if (problems.length > 0) {
					console.error('upstream locale snapshot is out of date:');
					for (const problem of problems) console.error('  - ' + problem);
					process.exitCode = 1;
				} else {
					console.log('upstream locale snapshot is up to date: ' + snapshot.upstream.totals.namespaces + ' namespaces, ' + snapshot.upstream.totals.keys + ' keys');
				}
			} else {
				writeSnapshot(snapshot, options.outDir);
				console.log('wrote ' + snapshot.upstream.totals.namespaces + ' namespaces / ' + snapshot.upstream.totals.keys + ' keys to ' + path.relative(REPO_ROOT, options.outDir));
			}
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
